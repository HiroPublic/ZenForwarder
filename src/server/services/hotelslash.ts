import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import type { CurrentReservationInfo } from "../../shared/types";

const HOTELSLASH_LOGIN_URL = "https://www.hotelslash.com/Account/LogIn";
const HOTELSLASH_TRIPS_URL = "https://www.hotelslash.com/Trips";
const HOTELSLASH_ORIGIN = "https://www.hotelslash.com";
const HOTELSLASH_GOTO_TIMEOUT_MS = 30_000;
const HOTELSLASH_NETWORK_SETTLE_TIMEOUT_MS = 5_000;
const HOTELSLASH_PARSE_DEADLINE_MS = 20_000;
const HOTELSLASH_POLL_INTERVAL_MS = 1_000;
const HOTELSLASH_BODY_TIMEOUT_MS = 3_000;
const HOTELSLASH_STABLE_MARKETING_PAGE_ATTEMPTS = 3;
type HotelSlashStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

interface SavedHotelSlashAuthState {
  savedAt: string;
  storageState: HotelSlashStorageState;
  sessionStorage: Record<string, string>;
}

export interface HotelSlashOffer {
  pageUrl: string;
  priceCurrency: string;
  priceAmount: number;
  roomType: string;
  conditions: string[];
  currentReservation?: CurrentReservationInfo;
}

export class HotelSlashRatesUnavailableError extends Error {
  requestedUrl: string;
  finalUrl: string;
  pageTitle?: string;

  constructor(options: { requestedUrl: string; finalUrl: string; pageTitle?: string }) {
    super(
      [
        "HotelSlash says the lower rates are no longer available.",
        `Requested URL: ${options.requestedUrl}`,
        `Final URL: ${options.finalUrl}`,
        options.pageTitle ? `Title: ${options.pageTitle}` : undefined,
        "No proposal was created because the offer expired before it could be reviewed."
      ]
        .filter(Boolean)
        .join(" ")
    );
    this.name = "HotelSlashRatesUnavailableError";
    this.requestedUrl = options.requestedUrl;
    this.finalUrl = options.finalUrl;
    this.pageTitle = options.pageTitle;
  }
}

export function isHotelSlashRatesUnavailableError(error: unknown): error is HotelSlashRatesUnavailableError {
  return (
    error instanceof HotelSlashRatesUnavailableError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "HotelSlashRatesUnavailableError" &&
      "message" in error &&
      typeof error.message === "string")
  );
}

let loginContext: BrowserContext | undefined;

export async function extractTopHotelSlashOffer(pageUrl: string): Promise<HotelSlashOffer> {
  if (loginContext) {
    throw new Error("HotelSlash login window is still open. Click ログイン完了 after signing in, then run Gmail sync again.");
  }
  const authState = readSavedHotelSlashAuthState();
  if (!authState) {
    throw new Error("HotelSlash login session is not saved. Use HotelSlashログイン and click ログイン完了 before running Gmail sync.");
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: authState.storageState,
    viewport: { width: 1440, height: 1100 }
  });
  try {
    await applySavedSessionStorage(context, authState.sessionStorage);
    const page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: HOTELSLASH_GOTO_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: HOTELSLASH_NETWORK_SETTLE_TIMEOUT_MS }).catch(() => undefined);
    return await parseRenderedOffer(page, pageUrl);
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function startHotelSlashLoginSession() {
  if (loginContext) return getHotelSlashLoginStatus();
  const profileDir = getHotelSlashProfileDir();
  fs.mkdirSync(profileDir, { recursive: true });
  loginContext = await launchHotelSlashContext({ headless: false, width: 1280, height: 900 });
  const activeContext = loginContext;
  activeContext.once("close", () => {
    if (loginContext === activeContext) loginContext = undefined;
  });
  const page = activeContext.pages()[0] ?? (await activeContext.newPage());
  await page.goto(HOTELSLASH_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  return getHotelSlashLoginStatus();
}

export async function finishHotelSlashLoginSession() {
  const context = loginContext;
  if (!context) {
    throw new Error("HotelSlash login window is not open. Start HotelSlashログイン and complete sign-in before clicking ログイン完了.");
  }
  const authState = await captureHotelSlashAuthState(context);
  writeSavedHotelSlashAuthState(authState);
  if (context) {
    loginContext = undefined;
    await context.close().catch(() => undefined);
  }
  return getHotelSlashLoginStatus();
}

export function getHotelSlashLoginStatus() {
  return {
    profileDir: getHotelSlashProfileDir(),
    profileExists: fs.existsSync(getHotelSlashProfileDir()),
    loginWindowOpen: Boolean(loginContext)
  };
}

export function parseTopHotelSlashOffer(text: string, pageUrl = ""): HotelSlashOffer {
  const normalizedLines = normalizeRenderedLines(text);
  const topOfferLines = sliceTopOfferLines(normalizedLines);
  const currentReservation = parseCurrentReservation(normalizedLines);
  const price = findPrice(topOfferLines) ?? findPrice(normalizedLines);
  if (!price) throw new Error("HotelSlash price could not be extracted from the rendered rates page.");

  const priceLineIndex = topOfferLines.findIndex((line) => line.includes(price.raw));
  const roomType =
    findRoomType(topOfferLines.slice(0, priceLineIndex >= 0 ? priceLineIndex : topOfferLines.length)) ?? findRoomType(topOfferLines);
  if (!roomType) throw new Error("HotelSlash room type could not be extracted from the rendered rates page.");

  return {
    pageUrl,
    priceCurrency: price.currency,
    priceAmount: price.amount,
    roomType,
    conditions: findConditions(topOfferLines),
    currentReservation
  };
}

export function shouldAbortHotelSlashPolling(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  const hasOfferSignals =
    normalized.includes("your hotelslash rates") ||
    normalized.includes("rebook your") ||
    normalized.includes("here are the details of your current reservation") ||
    normalized.includes("rates we found are no longer available") ||
    normalized.includes("sign in to your account");
  if (hasOfferSignals) return false;

  return (
    normalized.includes("about gift cards") ||
    normalized.includes("save big on hotels") ||
    normalized.includes("where would you like to stay") ||
    normalized.includes("step 1 choose where you'd like to stay") ||
    normalized.includes("step 2 our algorithm finds you the best deal possible") ||
    normalized.includes("blog your trips hello") ||
    normalized.includes("members unlock exclusive")
  );
}

function normalizeRenderedLines(text: string) {
  const collapsedPricePattern =
    /((?:[A-Z]{3}|¥|\$|€|£|₺)\s*\d[\d,.]*)\s+(?=Save\b|PAY LATER\b|PAY DEPOSIT\b|Earn\b|Photos\b|Other deals\b|\d+\s+nights\b|$)/gi;
  const normalizedText = text
    .replace(/\r/g, "\n")
    .replace(/(Here are the details of your current reservation\.)/gi, "\n$1\n")
    .replace(/(Your HotelSlash Rates)/gi, "\n$1\n")
    .replace(/(We found you a better price!)/gi, "\n$1\n")
    .replace(/(Rebook your .*?lower rate:)/gi, "\n$1\n")
    .replace(/(Other deals.*?:)/gi, "\n$1\n")
    .replace(/(Photos,\s*Amenities,\s*Description|Photos Amenities Description)/gi, "\n$1\n")
    .replace(/(Breakfast Included|Breakfast included|Fully Refundable|Non-Refundable|Non refundable|PAY DEPOSIT|PREPAID|Room Only)/gi, "\n$1\n")
    .replace(/(Cancel before [A-Za-z]{3,9} \d{1,2}, \d{4}|Free cancellation until [A-Za-z]{3,9} \d{1,2}, \d{4})/gi, "\n$1\n")
    .replace(/(\d+\s+adults?)\s+/gi, "$1\n")
    .replace(collapsedPricePattern, "\n$1\n")
    .replace(/(Save\s+(?:[A-Z]{3}|¥|\$|€|£|₺)?\s*\d[\d,.\s]*)/gi, "\n$1\n")
    .replace(/(Earn\s+(?:[A-Z]{3}|¥|\$|€|£|₺)?\s*\d[\d,.\s]*SlashCash)/gi, "\n$1\n")
    .replace(/(\d+\s+nights)\s+(PAY LATER|PAY DEPOSIT|PREPAID)/gi, "$1\n$2")
    .replace(/\bat the\b/gi, "\nat the\n");

  return normalizedText
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function sliceTopOfferLines(lines: string[]) {
  const hotelSlashRatesIndex = lines.findIndex((line) => /Your HotelSlash Rates/i.test(line));
  const rebookIndex = lines.findIndex((line) => /Rebook your .*lower rate/i.test(line));
  const betterPriceIndex = lines.findIndex((line) => /We found you a better price!/i.test(line));
  const start = hotelSlashRatesIndex >= 0 ? hotelSlashRatesIndex : rebookIndex >= 0 ? rebookIndex : betterPriceIndex >= 0 ? betterPriceIndex : 0;
  const afterStart = lines.slice(start);
  const end = afterStart.findIndex((line, index) => index > 0 && /Other deals|Results expire|Photos,\s*Amenities,\s*Description|Photos Amenities Description/i.test(line));
  return end >= 0 ? afterStart.slice(0, end) : afterStart.slice(0, 40);
}

function findPrice(lines: string[]) {
  const currencyCode = "JPY|USD|EUR|GBP|AUD|CAD|NZD|TRY|AED|SAR|QAR|OMR|BHD|KWD|CHF|SEK|NOK|DKK|ISK|HUF|CZK|PLN|RON|BGN|GEL|INR|IDR|THB|VND|SGD|HKD|TWD|KRW|CNY|MYR|PHP|MXN|BRL|ARS|CLP|COP|ZAR|MAD|EGP";
  const amountPattern = String.raw`\d{1,3}(?:[,.]\d{3})+(?:[,.]\d{2})?|\d+(?:[,.]\d{2})?`;
  const currencyPattern = String.raw`(?<![A-Z])(?:${currencyCode})(?![A-Z])|¥|\$|€|£|₺`;
  const slashCashPattern = new RegExp(String.raw`earn\s+(?:${currencyPattern})?\s*${amountPattern}\s+slashcash`, "gi");
  const priceOnlyPattern = new RegExp(
    String.raw`^\s*(?:${currencyPattern}\s*${amountPattern}|${amountPattern}\s*${currencyPattern})\s*$`,
    "i"
  );

  for (const [index, line] of lines.entries()) {
    if (/^\s*save\b/i.test(line)) continue;
    const previousLine = lines[index - 1] ?? "";
    const nextLine = lines[index + 1] ?? "";
    if (priceOnlyPattern.test(line) && (/^\s*save\b/i.test(previousLine) || /^\s*earn\b/i.test(previousLine) || /slashcash/i.test(nextLine))) {
      continue;
    }
    const searchableLine = line
      .replace(slashCashPattern, "")
      .replace(/\b\d+(?:[,.]\d{2})?\s+slashcash\b/gi, "")
      .replace(/\bSave\b.*$/i, "");
    const currencyFirst = searchableLine.match(new RegExp(String.raw`(?<currency>${currencyPattern})\s*(?<amount>${amountPattern})`, "i"));
    const amountFirst = searchableLine.match(new RegExp(String.raw`(?<amount>${amountPattern})\s*(?<currency>${currencyPattern})`, "i"));
    const match = currencyFirst ?? amountFirst;
    if (!match?.groups) continue;
    return {
      raw: match[0],
      currency: normalizeCurrency(match.groups.currency),
      amount: parsePriceAmount(match.groups.amount)
    };
  }
  return undefined;
}

function parseCurrentReservation(lines: string[]): CurrentReservationInfo | undefined {
  const currentLines = sliceCurrentReservationLines(lines);
  if (!currentLines.length) return undefined;
  const price = findPrice(currentLines);
  const priceLineIndex = price ? currentLines.findIndex((line) => line.includes(price.raw)) : -1;
  const roomType = findRoomType(currentLines.slice(0, priceLineIndex >= 0 ? priceLineIndex : currentLines.length)) ?? findRoomType(currentLines);
  const cancellationDeadline = currentLines.find((line) => /cancel before|free cancellation until|cancellation/i.test(line));
  const paymentTerms = currentLines.find((line) => /\bprepaid\b|pay at|pay later|pay deposit/i.test(line));
  const conditions = findCurrentReservationConditions(currentLines);

  if (!price && !roomType && !cancellationDeadline && !paymentTerms && !conditions.length) return undefined;
  return {
    priceCurrency: price?.currency,
    priceAmount: price?.amount,
    roomType,
    conditions,
    cancellationDeadline,
    paymentTerms
  };
}

function sliceCurrentReservationLines(lines: string[]) {
  const start = lines.findIndex((line) => /details of your current reservation/i.test(line));
  const end = lines.findIndex((line) => /Your HotelSlash Rates/i.test(line));
  if (start >= 0 && end > start) {
    const cardLines = lines.slice(start + 1, end);
    const cardEnd = cardLines.findIndex((line) => /^at the$/i.test(line) || /Hotel Overview|Location|Amenities|Address/i.test(line));
    return cardEnd >= 0 ? cardLines.slice(0, cardEnd) : cardLines;
  }
  if (end > 0) return lines.slice(0, end);
  return [];
}

function findCurrentReservationConditions(lines: string[]) {
  const conditions: string[] = [];
  for (const line of lines) {
    if (/room only/i.test(line)) conditions.push("Room Only");
    if (/breakfast/i.test(line)) conditions.push(titleCaseCondition(line));
  }
  return [...new Set(conditions)];
}

function findRoomType(lines: string[]) {
  const ignored = /hello|found|rates|rebook|change|save|earn|slashcash|pay deposit|prepaid|included|refundable|photos|amenities|description/i;
  return lines.find((line) => !ignored.test(line) && /room|suite|king|queen|twin|double|bed|villa|apartment|studio/i.test(line));
}

function findConditions(lines: string[]) {
  const conditions: string[] = [];
  for (const line of lines) {
    if (/room only/i.test(line)) conditions.push("Room Only");
    if (/breakfast/i.test(line)) conditions.push(titleCaseCondition(line));
    if (/fully refundable|non[- ]?refundable|free cancellation|cancel/i.test(line)) conditions.push(titleCaseCondition(line));
    if (/pay deposit/i.test(line)) conditions.push("Pay Deposit");
    if (/\bprepaid\b/i.test(line)) conditions.push("Prepaid");
  }
  return [...new Set(conditions)];
}

function normalizeCurrency(value: string) {
  const symbolMap: Record<string, string> = { "¥": "JPY", $: "USD", "€": "EUR", "£": "GBP", "₺": "TRY" };
  return symbolMap[value] ?? value.toUpperCase();
}

function parsePriceAmount(value: string) {
  if (value.includes(",") && value.includes(".")) {
    return value.lastIndexOf(",") > value.lastIndexOf(".")
      ? Number(value.replace(/\./g, "").replace(",", "."))
      : Number(value.replace(/,/g, ""));
  }
  if (/\.\d{3}(?:\.|$)/.test(value)) return Number(value.replace(/\./g, "").replace(",", "."));
  if (/,\d{2}$/.test(value)) return Number(value.replace(/\./g, "").replace(",", "."));
  return Number(value.replace(/,/g, ""));
}

function titleCaseCondition(value: string) {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

async function parseRenderedOffer(page: Page, originalUrl: string) {
  let lastText = "";
  let lastError: unknown;
  let stableMarketingPageAttempts = 0;
  let previousSignature = "";
  const deadline = Date.now() + HOTELSLASH_PARSE_DEADLINE_MS;

  while (Date.now() < deadline) {
    lastText = await page.locator("body").innerText({ timeout: HOTELSLASH_BODY_TIMEOUT_MS }).catch(() => "");
    const signature = lastText.replace(/\s+/g, " ").trim();
    stableMarketingPageAttempts =
      signature && signature === previousSignature && shouldAbortHotelSlashPolling(lastText) ? stableMarketingPageAttempts + 1 : shouldAbortHotelSlashPolling(lastText) ? 1 : 0;
    previousSignature = signature;
    if (isHotelSlashLoginPage(page.url(), lastText)) {
      throw new Error(
        [
          "HotelSlash login is required before rates can be extracted.",
          `Requested URL: ${originalUrl}`,
          `Final URL: ${page.url()}`,
          "Please sign in to HotelSlash in a browser session that this automation can use, then run Gmail sync again."
        ].join(" ")
      );
    }
    if (isHotelSlashRatesUnavailablePage(page.url(), lastText)) {
      throw new HotelSlashRatesUnavailableError({
        requestedUrl: originalUrl,
        finalUrl: page.url(),
        pageTitle: await page.title().catch(() => undefined)
      });
    }
    if (lastText.trim()) {
      try {
        return parseTopHotelSlashOffer(lastText, page.url());
      } catch (error) {
        lastError = error;
      }
    }
    if (stableMarketingPageAttempts >= HOTELSLASH_STABLE_MARKETING_PAGE_ATTEMPTS) {
      throw buildHotelSlashParseFailure(originalUrl, page.url(), await page.title().catch(() => "(title unavailable)"), lastText, lastError);
    }
    if (Date.now() + HOTELSLASH_POLL_INTERVAL_MS >= deadline) break;
    await page.waitForTimeout(HOTELSLASH_POLL_INTERVAL_MS);
  }

  throw buildHotelSlashParseFailure(
    originalUrl,
    page.url(),
    await page.title().catch(() => "(title unavailable)"),
    lastText,
    lastError
  );
}

function isHotelSlashLoginPage(url: string, text: string) {
  return /\/Account\/LogIn/i.test(url) || /Sign in to your account|Your password|Forgot password/i.test(text);
}

function isHotelSlashRatesUnavailablePage(url: string, text: string) {
  return (
    /\/Offer\/RatesNotFound/i.test(url) ||
    /rates we found are no longer available/i.test(text) ||
    /no worries, we'll continue to look for better deals/i.test(text)
  );
}

function getHotelSlashProfileDir() {
  return path.resolve(process.cwd(), ".hotelslash-profile");
}

async function captureHotelSlashAuthState(context: BrowserContext): Promise<SavedHotelSlashAuthState> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(HOTELSLASH_TRIPS_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  const text = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  if (isHotelSlashLoginPage(page.url(), text)) {
    throw new Error(
      [
        "HotelSlash login is not saved in the browser session yet.",
        "Keep the HotelSlash login window open, finish signing in there, then click ログイン完了 again so the app can save the active session."
      ].join(" ")
    );
  }
  if (!/\/Trips(?:[/?#]|$)/i.test(page.url())) {
    const title = await page.title().catch(() => "(title unavailable)");
    throw new Error(`HotelSlash login could not be verified. Expected Trips page but got ${page.url()} (Title: ${title}).`);
  }

  return {
    savedAt: new Date().toISOString(),
    storageState: await context.storageState(),
    sessionStorage: await readSessionStorage(page)
  };
}

function launchHotelSlashContext(options: { headless: boolean; width: number; height: number }) {
  return chromium.launchPersistentContext(getHotelSlashProfileDir(), {
    headless: options.headless,
    viewport: { width: options.width, height: options.height }
  });
}

async function readSessionStorage(page: Page) {
  return page.evaluate(() => {
    const entries: Record<string, string> = {};
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (!key) continue;
      const value = window.sessionStorage.getItem(key);
      if (value !== null) entries[key] = value;
    }
    return entries;
  });
}

async function applySavedSessionStorage(context: BrowserContext, sessionStorage: Record<string, string>) {
  if (!Object.keys(sessionStorage).length) return;
  await context.addInitScript(
    ({ origin, entries }: { origin: string; entries: Record<string, string> }) => {
      if (window.location.origin !== origin) return;
      for (const [key, value] of Object.entries(entries)) {
        window.sessionStorage.setItem(key, value);
      }
    },
    { origin: HOTELSLASH_ORIGIN, entries: sessionStorage }
  );
}

function getHotelSlashAuthStatePath() {
  return path.resolve(process.cwd(), ".hotelslash-auth.json");
}

function readSavedHotelSlashAuthState(): SavedHotelSlashAuthState | undefined {
  const authPath = getHotelSlashAuthStatePath();
  if (!fs.existsSync(authPath)) return undefined;
  return JSON.parse(fs.readFileSync(authPath, "utf8")) as SavedHotelSlashAuthState;
}

function writeSavedHotelSlashAuthState(state: SavedHotelSlashAuthState) {
  fs.writeFileSync(getHotelSlashAuthStatePath(), JSON.stringify(state, null, 2));
}

function buildHotelSlashParseFailure(originalUrl: string, finalUrl: string, title: string, lastText: string, lastError: unknown) {
  const excerpt = lastText.replace(/\s+/g, " ").trim().slice(0, 500);
  const detail = lastError instanceof Error ? lastError.message : "No parse attempt succeeded.";
  return new Error(
    [
      "HotelSlash rates page loaded, but the top offer could not be extracted.",
      `Requested URL: ${originalUrl}`,
      `Final URL: ${finalUrl}`,
      `Title: ${title}`,
      `Parse detail: ${detail}`,
      excerpt ? `Visible text excerpt: ${excerpt}` : "Visible text excerpt: (empty)"
    ].join(" ")
  );
}
