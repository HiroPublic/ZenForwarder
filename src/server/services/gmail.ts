import { google, gmail_v1 } from "googleapis";
import type { PendingForward } from "../../shared/types";
import { config } from "../config";
import type { SourceEmail } from "./ai";

export const labels = {
  pending: "ZenForwarder/Pending",
  processed: "ZenForwarder/Processed",
  error: "ZenForwarder/Error"
};

interface CandidateQueryOptions {
  includeProcessed?: boolean;
}

interface ReservationSearchOptions {
  includeProcessed?: boolean;
  inboxOnly?: boolean;
  lookbackDays?: number;
  excludeUserAuthored?: boolean;
  maxResults?: number;
}

export function buildOAuthClient() {
  return new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, config.GOOGLE_REDIRECT_URI);
}

export function getAuthUrl() {
  return buildOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.settings.basic"
    ]
  });
}

export function isGmailConfigured() {
  return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
}

export function hasGmailTokens(tokens?: unknown) {
  return Boolean(tokens && typeof tokens === "object");
}

export function buildCandidateQuery(options: CandidateQueryOptions = {}) {
  const terms = [
    "ホテル",
    "hotel",
    "reservation",
    "予約",
    "HotelSlash",
    "Expedia",
    "expedia",
    "itinerary",
    "confirmation",
    "\"travel confirmation\"",
    "\"hotel confirmed\"",
    "\"We found you a better price\"",
    "\"CLICK HERE TO SEE YOUR RATES\"",
    "\"Lower Rate Found on Your Trip\""
  ].join(" ");
  const processedFilter = options.includeProcessed ? "" : ` -label:"${labels.processed}"`;
  return `in:inbox newer_than:7d${processedFilter} -from:do-not-reply@tripit.com {${terms}}`;
}

export function isLowerRateEmail(email: SourceEmail) {
  const normalizedFrom = email.from.toLowerCase();
  const normalizedSubject = email.subject.toLowerCase();
  const normalizedBody = email.body.toLowerCase();
  const fromHotelSlash = normalizedFrom.includes("hotelslash");
  const hasLowerRateSubject =
    /lower rate found on your trip/i.test(email.subject) ||
    /better price/i.test(email.subject) ||
    /lower rate/i.test(email.subject);
  const hasHotelSlashProposalBody =
    /click\s+here\s+to\s+see\s+your\s+rates/i.test(email.body) ||
    /we found you a better price/i.test(email.body) ||
    /your hotelslash rates/i.test(email.body) ||
    /rebook your .*lower rate/i.test(email.body);

  return hasLowerRateSubject || (fromHotelSlash && hasHotelSlashProposalBody) || (normalizedSubject.includes("hotelslash") && hasHotelSlashProposalBody) || (normalizedBody.includes("hotelslash") && hasHotelSlashProposalBody);
}

export function extractLowerRateButtonUrl(body: string): string | undefined {
  const extractedUrls = collectCandidateUrls(body);
  const bestUrl = pickBestHotelSlashRatesUrl(extractedUrls);
  if (bestUrl) return bestUrl;

  const anchorPattern =
    /<a\b[^>]*href=(["'])(?<href>.*?)\1[^>]*>[\s\S]*?(?:CLICK\s+HERE\s+TO\s+SEE\s+YOUR\s+RATES!?|VIEW\s+YOUR\s+LOWER\s+RATE|BEGIN\s+STEP\s+1)[\s\S]*?<\/a>/i;
  const anchorMatch = body.match(anchorPattern);
  const href = anchorMatch?.groups?.href;
  if (href) return cleanMatchedUrl(decodeHtmlAttribute(href));

  const markdownLinkPattern =
    /\[[^\]]*(?:CLICK\s+HERE\s+TO\s+SEE\s+YOUR\s+RATES!?|VIEW\s+YOUR\s+LOWER\s+RATE|BEGIN\s+STEP\s+1)[^\]]*\]\((?<href>https?:\/\/[^)\s]+)\)/i;
  const markdownLinkMatch = body.match(markdownLinkPattern);
  const markdownHref = markdownLinkMatch?.groups?.href;
  if (markdownHref) return cleanMatchedUrl(decodeHtmlAttribute(markdownHref));

  const preferredOfferUrl = body.match(/https?:\/\/www\.hotelslash\.com\/offer\/[^\s)"'<>]+/i)?.[0];
  if (preferredOfferUrl) return cleanMatchedUrl(preferredOfferUrl);

  const textIndex = body.search(/CLICK\s+HERE\s+TO\s+SEE\s+YOUR\s+RATES!?|VIEW\s+YOUR\s+LOWER\s+RATE|BEGIN\s+STEP\s+1/i);
  if (textIndex >= 0) {
    const before = body.slice(Math.max(0, textIndex - 1500), textIndex);
    const nearbyUrl = before.match(/https?:\/\/[^\s"'<>]+/g)?.at(-1);
    if (nearbyUrl) return cleanMatchedUrl(decodeHtmlAttribute(nearbyUrl));
  }

  return cleanMatchedUrl(body.match(/https?:\/\/[^\s"'<>]+/)?.[0]);
}

export async function fetchCandidateEmails(tokens?: unknown, options: CandidateQueryOptions = {}): Promise<SourceEmail[]> {
  if (!isGmailConfigured()) return mockEmails();
  if (!hasGmailTokens(tokens)) {
    throw new Error("Gmail is not connected. Click Gmail連携してから同期してください。");
  }
  const auth = buildOAuthClient();
  auth.setCredentials(tokens as Parameters<typeof auth.setCredentials>[0]);
  const gmail = google.gmail({ version: "v1", auth });
  const query = buildCandidateQuery(options);
  const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 10 });
  const messages = list.data.messages ?? [];
  const emails = await Promise.all(messages.map((message) => fetchMessage(gmail, message.id ?? "")));
  return emails.filter((email) => !isSelfGeneratedForward(email));
}

export async function fetchEmailByMessageId(tokens: unknown, messageId: string): Promise<SourceEmail | undefined> {
  if (!isGmailConfigured() || !hasGmailTokens(tokens)) return undefined;
  const auth = buildOAuthClient();
  auth.setCredentials(tokens as Parameters<typeof auth.setCredentials>[0]);
  const gmail = google.gmail({ version: "v1", auth });
  return fetchMessage(gmail, messageId);
}

export async function searchEmailsByReservationNumber(
  tokens: unknown,
  reservationNumber: string,
  options: ReservationSearchOptions = {}
): Promise<SourceEmail[]> {
  if (!isGmailConfigured() || !hasGmailTokens(tokens)) return [];
  const auth = buildOAuthClient();
  auth.setCredentials(tokens as Parameters<typeof auth.setCredentials>[0]);
  const gmail = google.gmail({ version: "v1", auth });
  const inboxFilter = options.inboxOnly === false ? "" : "in:inbox ";
  const processedFilter = options.includeProcessed ? "" : ` -label:"${labels.processed}"`;
  const selfAuthoredFilter = options.excludeUserAuthored
    ? ` -in:sent -from:${config.GMAIL_AUTH_ACCOUNT} -from:${config.FORWARD_FROM_EMAIL}`
    : "";
  const lookbackDays = options.lookbackDays ?? 30;
  const query = `${inboxFilter}newer_than:${lookbackDays}d "${reservationNumber}"${processedFilter}${selfAuthoredFilter}`.trim();
  const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults: options.maxResults ?? 5 });
  const messages = list.data.messages ?? [];
  const emails = await Promise.all(messages.map((message) => fetchMessage(gmail, message.id ?? "")));
  return prioritizeOriginalEmails(
    emails.filter((email) => !isSelfGeneratedForward(email) && !(options.excludeUserAuthored && isUserAuthoredEmail(email)))
  );
}

export async function ensureSendAsAlias(tokens: unknown): Promise<void> {
  if (!config.GOOGLE_CLIENT_ID || !tokens) return;
  const auth = buildOAuthClient();
  auth.setCredentials(tokens as Parameters<typeof auth.setCredentials>[0]);
  const gmail = google.gmail({ version: "v1", auth });
  const aliases = await gmail.users.settings.sendAs.list({ userId: "me" });
  const match = aliases.data.sendAs?.find((item) => item.sendAsEmail === config.FORWARD_FROM_EMAIL && item.verificationStatus === "accepted");
  if (!match) throw new Error(`${config.FORWARD_FROM_EMAIL} is not an accepted Gmail send-as alias.`);
}

export async function sendForward(tokens: unknown, item: PendingForward, editedBody: string): Promise<void> {
  if (!config.GOOGLE_CLIENT_ID || !tokens) return;
  const auth = buildOAuthClient();
  auth.setCredentials(tokens as Parameters<typeof auth.setCredentials>[0]);
  const gmail = google.gmail({ version: "v1", auth });
  const attachmentSourceMessageId = await resolveAttachmentSourceMessageId(tokens, item);
  const forwardSource = await fetchForwardSourceMessage(gmail, attachmentSourceMessageId);
  const attachmentSourceEmail = {
    id: forwardSource.id,
    from: forwardSource.from,
    subject: forwardSource.subject,
    receivedAt: forwardSource.receivedAt,
    body: forwardSource.textBody
  };
  assertOriginalReservationAttachmentEmail(attachmentSourceEmail, {
    reservationNumber: item.metadata.reservationNumber,
    hotelName: item.metadata.hotelName
  });
  const tripItRaw = createForwardLikeEmail(config.TRIPIT_FORWARD_EMAIL, forwardSource);
  await gmail.users.messages.send({ userId: "me", requestBody: { raw: tripItRaw } });

  const hotelSlashRaw = createForwardLikeEmail(config.HOTELSLASH_FORWARD_EMAIL, forwardSource, { plainTextOnly: true });
  await gmail.users.messages.send({ userId: "me", requestBody: { raw: hotelSlashRaw } });
}

export async function markProcessed(tokens: unknown, messageId: string): Promise<void> {
  if (!config.GOOGLE_CLIENT_ID || !tokens) return;
  const auth = buildOAuthClient();
  auth.setCredentials(tokens as Parameters<typeof auth.setCredentials>[0]);
  const gmail = google.gmail({ version: "v1", auth });
  const processedLabelId = await ensureLabel(gmail, labels.processed);
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      addLabelIds: [processedLabelId],
      removeLabelIds: ["INBOX"]
    }
  });
}

async function fetchMessage(gmail: gmail_v1.Gmail, id: string): Promise<SourceEmail> {
  const message = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const headers = message.data.payload?.headers ?? [];
  const subject = headers.find((header) => header.name?.toLowerCase() === "subject")?.value ?? "(no subject)";
  const from = headers.find((header) => header.name?.toLowerCase() === "from")?.value ?? "";
  const date = headers.find((header) => header.name?.toLowerCase() === "date")?.value ?? new Date().toISOString();
  return {
    id,
    subject,
    from,
    receivedAt: new Date(date).toISOString(),
    body: decodeBody(message.data.payload)
  };
}

async function fetchRawMessage(gmail: gmail_v1.Gmail, id: string): Promise<string> {
  const message = await gmail.users.messages.get({ userId: "me", id, format: "raw" });
  if (!message.data.raw) throw new Error("Original Gmail message could not be loaded for TripIt attachment.");
  return message.data.raw;
}

interface ForwardSourceMessage {
  id: string;
  from: string;
  subject: string;
  receivedAt: string;
  dateHeader: string;
  to: string;
  cc?: string;
  textBody: string;
  htmlBody?: string;
}

async function fetchForwardSourceMessage(gmail: gmail_v1.Gmail, id: string): Promise<ForwardSourceMessage> {
  const message = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const headers = message.data.payload?.headers ?? [];
  const subject = headers.find((header) => header.name?.toLowerCase() === "subject")?.value ?? "(no subject)";
  const from = headers.find((header) => header.name?.toLowerCase() === "from")?.value ?? "";
  const to = headers.find((header) => header.name?.toLowerCase() === "to")?.value ?? "";
  const cc = headers.find((header) => header.name?.toLowerCase() === "cc")?.value ?? "";
  const dateHeader = headers.find((header) => header.name?.toLowerCase() === "date")?.value ?? new Date().toUTCString();
  const receivedAt = new Date(dateHeader).toISOString();
  const bodies = extractMessageBodies(message.data.payload);

  return {
    id,
    from,
    subject,
    to,
    cc: cc || undefined,
    dateHeader,
    receivedAt,
    textBody: bodies.textBody || decodeBody(message.data.payload),
    htmlBody: bodies.htmlBody,
  };
}

async function ensureLabel(gmail: gmail_v1.Gmail, name: string): Promise<string> {
  const labelsResponse = await gmail.users.labels.list({ userId: "me" });
  const existing = labelsResponse.data.labels?.find((label) => label.name === name);
  if (existing?.id) return existing.id;
  const created = await gmail.users.labels.create({ userId: "me", requestBody: { name, labelListVisibility: "labelShow" } });
  if (!created.data.id) throw new Error(`Failed to create Gmail label ${name}`);
  return created.data.id;
}

function decodeBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  if (part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  return (part.parts ?? []).map(decodeBody).filter(Boolean).join("\n\n");
}

function extractMessageBodies(part: gmail_v1.Schema$MessagePart | undefined): { textBody?: string; htmlBody?: string } {
  if (!part) return {};

  const mimeType = part.mimeType?.toLowerCase();
  if (part.body?.data) {
    const decoded = Buffer.from(part.body.data, "base64url").toString("utf8");
    if (mimeType === "text/plain") return { textBody: decoded };
    if (mimeType === "text/html") return { htmlBody: decoded };
  }

  const combined = { textBody: undefined as string | undefined, htmlBody: undefined as string | undefined };
  for (const child of part.parts ?? []) {
    const childBodies = extractMessageBodies(child);
    combined.textBody ??= childBodies.textBody;
    combined.htmlBody ??= childBodies.htmlBody;
  }
  return combined;
}

export function createForwardLikeEmail(to: string, source: ForwardSourceMessage, options?: { plainTextOnly?: boolean }) {
  const forwardedSubject = /^(fwd|fw):/i.test(source.subject) ? source.subject : `Fwd: ${source.subject}`;
  const forwardedHeaders = [
    "---------- Forwarded message ---------",
    `From: ${source.from}`,
    `Date: ${source.dateHeader}`,
    `Subject: ${source.subject}`,
    source.to ? `To: ${source.to}` : "",
    source.cc ? `Cc: ${source.cc}` : ""
  ]
    .filter(Boolean)
    .join("\r\n");

  const plainBody = [forwardedHeaders, "", source.textBody.trim()].join("\r\n");
  const plainTextOnly = options?.plainTextOnly ?? false;

  if (plainTextOnly || !source.htmlBody) {
    const message = [
      `From: ${config.FORWARD_FROM_EMAIL}`,
      `To: ${to}`,
      `Subject: ${forwardedSubject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      plainBody
    ].join("\r\n");
    return Buffer.from(message).toString("base64url");
  }

  const boundary = `zenforwarder-inline-${crypto.randomUUID()}`;
  const embeddedHtml = extractEmbeddableHtmlFragment(source.htmlBody);
  const htmlBody = [
    "<div>---------- Forwarded message ---------</div>",
    `<div><strong>From:</strong> ${escapeHtml(source.from)}</div>`,
    `<div><strong>Date:</strong> ${escapeHtml(source.dateHeader)}</div>`,
    `<div><strong>Subject:</strong> ${escapeHtml(source.subject)}</div>`,
    source.to ? `<div><strong>To:</strong> ${escapeHtml(source.to)}</div>` : "",
    source.cc ? `<div><strong>Cc:</strong> ${escapeHtml(source.cc)}</div>` : "",
    "<br />",
    embeddedHtml
  ]
    .filter(Boolean)
    .join("");

  const message = [
    `From: ${config.FORWARD_FROM_EMAIL}`,
    `To: ${to}`,
    `Subject: ${forwardedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    plainBody,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    htmlBody,
    "",
    `--${boundary}--`,
    ""
  ].join("\r\n");

  return Buffer.from(message).toString("base64url");
}

function extractEmbeddableHtmlFragment(html: string) {
  const withoutDoctype = html.replace(/<!doctype[^>]*>/gi, "").trim();
  const bodyMatch = withoutDoctype.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return (bodyMatch?.[1] ?? withoutDoctype).trim();
}

export function createRawEmailWithOriginalAttachment(to: string, subject: string, body: string, originalRawEmail: string) {
  const boundary = `zenforwarder-${crypto.randomUUID()}`;
  const originalEmailBase64 = wrapBase64(Buffer.from(originalRawEmail, "base64url").toString("base64"));
  const message = [
    `From: ${config.FORWARD_FROM_EMAIL}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
    "",
    `--${boundary}`,
    'Content-Type: message/rfc822; name="original-confirmation.eml"',
    'Content-Disposition: attachment; filename="original-confirmation.eml"',
    "Content-Transfer-Encoding: base64",
    "",
    originalEmailBase64,
    "",
    `--${boundary}--`,
    ""
  ].join("\r\n");
  return Buffer.from(message).toString("base64url");
}

function wrapBase64(value: string) {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function isSelfGeneratedForward(email: SourceEmail) {
  const normalizedSubject = email.subject.trim().toLowerCase();
  const normalizedBody = email.body.toLowerCase();
  return (
    (normalizedSubject.startsWith("hotel reservation - ") && normalizedBody.includes("original email type:")) ||
    (normalizedSubject.startsWith("hotel reservation confirmation:") && normalizedBody.includes("forwarding reference:"))
  );
}

export function isLikelyForwardedReservationEmail(email: SourceEmail) {
  return /^(fwd|fw):/i.test(email.subject.trim()) || /^begin forwarded message:/i.test(email.body.trim());
}

export function isUserAuthoredEmail(email: SourceEmail) {
  const normalizedFrom = email.from.toLowerCase();
  return normalizedFrom.includes(config.GMAIL_AUTH_ACCOUNT.toLowerCase()) || normalizedFrom.includes(config.FORWARD_FROM_EMAIL.toLowerCase());
}

export function prioritizeOriginalEmails(emails: SourceEmail[]) {
  return [...emails].sort((left, right) => {
    const selfAuthoredLeft = isUserAuthoredEmail(left);
    const selfAuthoredRight = isUserAuthoredEmail(right);
    if (selfAuthoredLeft !== selfAuthoredRight) return selfAuthoredLeft ? 1 : -1;

    const forwardedLeft = isLikelyForwardedReservationEmail(left);
    const forwardedRight = isLikelyForwardedReservationEmail(right);
    if (forwardedLeft !== forwardedRight) return forwardedLeft ? 1 : -1;

    return new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime();
  });
}

export function choosePreferredReservationSourceEmail(emails: SourceEmail[], currentEmail?: SourceEmail) {
  const ranked = prioritizeOriginalEmails(
    currentEmail ? [currentEmail, ...emails.filter((email) => email.id !== currentEmail.id)] : emails
  );
  return ranked[0] ?? currentEmail;
}

export function assertOriginalReservationAttachmentEmail(
  email: SourceEmail,
  expected?: { reservationNumber?: string; hotelName?: string }
) {
  if (isSelfGeneratedForward(email)) {
    throw new Error(`Attachment source ${email.id} is a ZenForwarder-generated email, not the original reservation email.`);
  }
  if (isUserAuthoredEmail(email)) {
    throw new Error(`Attachment source ${email.id} was authored by the forwarding account, not the original reservation sender.`);
  }
  if (isLikelyForwardedReservationEmail(email)) {
    throw new Error(`Attachment source ${email.id} is a forwarded wrapper, not the original reservation email.`);
  }

  const normalizedContent = `${email.subject}\n${email.body}`.toLowerCase();
  const expectedReservationNumber = expected?.reservationNumber?.trim();
  if (expectedReservationNumber && !normalizedContent.includes(expectedReservationNumber.toLowerCase())) {
    throw new Error(`Attachment source ${email.id} does not contain the expected reservation number ${expectedReservationNumber}.`);
  }

  const expectedHotelName = expected?.hotelName?.trim();
  if (expectedHotelName && !normalizedContent.includes(expectedHotelName.toLowerCase())) {
    throw new Error(`Attachment source ${email.id} does not contain the expected hotel name ${expectedHotelName}.`);
  }
}

async function resolveAttachmentSourceMessageId(tokens: unknown, item: PendingForward) {
  if (!item.metadata.reservationNumber) return item.gmailMessageId;

  const matches = await searchEmailsByReservationNumber(tokens, item.metadata.reservationNumber, {
    includeProcessed: true,
    inboxOnly: false,
    lookbackDays: 365,
    excludeUserAuthored: true,
    maxResults: 10
  });
  if (matches.length > 0) return matches[0]!.id;
  return item.gmailMessageId;
}

function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanMatchedUrl(value?: string) {
  return value?.replace(/[).,!?:;]+$/g, "");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function collectCandidateUrls(body: string) {
  const urls = new Set<string>();
  const pushUrl = (value?: string) => {
    const cleaned = cleanMatchedUrl(decodeHtmlAttribute(value ?? ""));
    if (cleaned) urls.add(cleaned);
  };

  for (const match of body.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    pushUrl(match[0]);
  }
  for (const match of body.matchAll(/\((https?:\/\/[^)\s]+)\)/gi)) {
    pushUrl(match[1]);
  }
  for (const match of body.matchAll(/href=(["'])(.*?)\1/gi)) {
    pushUrl(match[2]);
  }

  return [...urls];
}

function pickBestHotelSlashRatesUrl(urls: string[]) {
  let best: { url: string; score: number } | undefined;

  for (const originalUrl of urls) {
    const candidate = normalizeHotelSlashCandidateUrl(originalUrl);
    if (!candidate) continue;
    const score = scoreHotelSlashCandidateUrl(candidate);
    if (!best || score > best.score) best = { url: candidate, score };
  }

  return best?.score && best.score > 0 ? best.url : undefined;
}

function normalizeHotelSlashCandidateUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (!/(\.|^)hotelslash\.com$/i.test(parsed.hostname)) return undefined;
    const offerMatch = parsed.pathname.match(/\/offer\/([a-f0-9-]+)/i);
    if (offerMatch?.[1]) {
      return `https://www.hotelslash.com/offer/${offerMatch[1]}`;
    }
    const trackingMatch = parsed.pathname.match(/\/tracking\/ViewOfferDetails\/([a-f0-9-]+)/i);
    if (trackingMatch?.[1]) {
      return `https://www.hotelslash.com/offer/${trackingMatch[1]}`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

function scoreHotelSlashCandidateUrl(url: string) {
  if (/\/offer\/[a-f0-9-]+$/i.test(url)) return 100;
  if (/\/tracking\/ViewOfferDetails\//i.test(url)) return 90;
  if (/\/offer\b/i.test(url)) return 80;
  if (/\/tracking\b/i.test(url)) return 20;
  if (/\/privacy\b|\/terms\b/i.test(url)) return -10;
  if (/^https:\/\/www\.hotelslash\.com\/?$/i.test(url)) return -20;
  return 0;
}

function mockEmails(): SourceEmail[] {
  return [
    {
      id: "mock-gmail-001",
      from: "booking@example.jp",
      subject: "ホテル予約確認: Sample Hotel Tokyo",
      receivedAt: new Date().toISOString(),
      body: [
        "ホテル: Sample Hotel Tokyo",
        "住所: 1-1-1 Marunouchi, Tokyo, Japan",
        "電話: +81-3-0000-0000",
        "予約番号: ZEN-2026-001",
        "チェックイン: 2026-06-12",
        "チェックアウト: 2026-06-15",
        "料金: JPY 42000",
        "宿泊者: Sample Guest"
      ].join("\n")
    }
  ];
}
