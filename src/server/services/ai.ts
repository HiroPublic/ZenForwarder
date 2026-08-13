import OpenAI from "openai";
import type { ReservationMetadata } from "../../shared/types";
import { config } from "../config";
import { inferBookingSiteFromEmail } from "./booking-site";
import { redactPersonalInformation } from "./redaction";

const client = config.OPENAI_API_KEY ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : undefined;

export const reservationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "hotelName",
    "hotelAddress",
    "hotelPhone",
    "bookingSite",
    "reservationNumber",
    "guestName",
    "adultCount",
    "childCount",
    "reservationConfirmationUrl",
    "status",
    "emailType",
    "checkIn",
    "checkOut",
    "nights",
    "room",
    "mealPlan",
    "originalCurrency",
    "originalAmount",
    "cancellationPolicy",
    "notes"
  ],
  properties: {
    hotelName: { type: "string" },
    hotelAddress: { type: ["string", "null"] },
    hotelPhone: { type: ["string", "null"] },
    bookingSite: { type: ["string", "null"] },
    reservationNumber: { type: ["string", "null"] },
    guestName: { type: ["string", "null"] },
    adultCount: { type: ["number", "null"] },
    childCount: { type: ["number", "null"] },
    reservationConfirmationUrl: { type: ["string", "null"] },
    status: { enum: ["Confirmed", "Modified", "Cancelled", "Price Alert"] },
    emailType: {
      enum: ["Reservation Confirmation", "Change Notice", "Cancellation Notice", "HotelSlash Price Alert"]
    },
    checkIn: { type: ["string", "null"] },
    checkOut: { type: ["string", "null"] },
    nights: { type: ["number", "null"] },
    room: { type: ["string", "null"] },
    mealPlan: { type: ["string", "null"] },
    originalCurrency: { type: ["string", "null"] },
    originalAmount: { type: ["number", "null"] },
    cancellationPolicy: { type: ["string", "null"] },
    notes: { type: ["string", "null"] }
  }
} as const;

export interface SourceEmail {
  id: string;
  from: string;
  subject: string;
  receivedAt: string;
  body: string;
}

export class NonHotelReservationEmailError extends Error {
  constructor(message = "Email does not appear to be a hotel reservation.") {
    super(message);
    this.name = "NonHotelReservationEmailError";
  }
}

export async function extractReservationJson(email: SourceEmail): Promise<ReservationMetadata> {
  assertSupportedHotelReservationCandidate(email);
  const metadata = client
    ? await extractReservationJsonWithAi(email)
    : mockExtract(email);
  assertLooksLikeHotelReservation(email, metadata);
  return metadata;
}

export function assertSupportedHotelReservationCandidate(email: SourceEmail): void {
  const normalized = `${email.from}\n${email.subject}\n${email.body}`.replace(/\r/g, "\n").toLowerCase();
  const hasClearHotelStaySignals = countHotelStayTextSignals(normalized) >= 2;

  if (!hasClearHotelStaySignals && looksLikeTransportBooking(normalized)) {
    throw new NonHotelReservationEmailError("Email looks like a transport or transfer booking, not a hotel reservation.");
  }
  if (!hasClearHotelStaySignals && looksLikeRestaurantBooking(normalized)) {
    throw new NonHotelReservationEmailError("Email looks like a restaurant reservation, not a hotel reservation.");
  }
  if (!hasClearHotelStaySignals && looksLikeReligiousSiteBooking(normalized)) {
    throw new NonHotelReservationEmailError("Email looks like a church reservation or event, not a hotel reservation.");
  }
  if (!hasClearHotelStaySignals && looksLikeRuinsBooking(normalized)) {
    throw new NonHotelReservationEmailError("Email looks like an archaeological site or ruins booking, not a hotel reservation.");
  }
  if (!hasClearHotelStaySignals && looksLikeMuseumBooking(normalized)) {
    throw new NonHotelReservationEmailError("Email looks like a museum or gallery booking, not a hotel reservation.");
  }
  if (!hasClearHotelStaySignals && looksLikeLandmarkOrAttractionBooking(normalized)) {
    throw new NonHotelReservationEmailError("Email looks like an attraction or timed-entry booking, not a hotel reservation.");
  }
  if (!hasClearHotelStaySignals && looksLikeTourOrActivityBooking(normalized)) {
    throw new NonHotelReservationEmailError("Email looks like a tour, activity, or class booking, not a hotel reservation.");
  }
  if (!hasClearHotelStaySignals && looksLikePerformanceOrSportsBooking(normalized)) {
    throw new NonHotelReservationEmailError("Email looks like an event or performance booking, not a hotel reservation.");
  }
}

async function extractReservationJsonWithAi(email: SourceEmail): Promise<ReservationMetadata> {
  const response = await client!.responses.create({
    model: config.OPENAI_MODEL,
    input: [
      {
        role: "system",
        content:
          "Extract only hotel reservation metadata from the email. Preserve the booking site, reservation/itinerary number, guest name, adult/child guest counts, reservation confirmation URL, and any meal-plan details such as breakfast included, dinner included, room only, half board, or full board. Remove unrelated personal information. Return strict JSON matching the requested keys."
      },
      {
        role: "user",
        content: `Email subject: ${email.subject}\n\nEmail body:\n${email.body}`
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "hotel_reservation",
        schema: reservationJsonSchema
      }
    }
  });

  return applyEmailDerivedFallbacks(compactNulls(JSON.parse(response.output_text) as ReservationMetadata), email.body);
}

export async function generateForwardEmail(metadata: ReservationMetadata): Promise<{ subject: string; body: string }> {
  const translatedFields = await translateForwardFieldsToEnglish(metadata);
  const formattedCheckIn = formatForwardDate(metadata.checkIn);
  const formattedCheckOut = formatForwardDate(metadata.checkOut);
  const parserFriendlyCheckIn = formatForwardDate(metadata.checkIn, { verbose: true });
  const parserFriendlyCheckOut = formatForwardDate(metadata.checkOut, { verbose: true });
  const subject = `Hotel reservation confirmation: ${metadata.hotelName}, check in ${parserFriendlyCheckIn}, check out ${parserFriendlyCheckOut}`;
  const body = redactPersonalInformation(`Hotel reservation confirmation

Hotel:
${metadata.hotelName}

Check in date:
${parserFriendlyCheckIn}

Check out date:
${parserFriendlyCheckOut}

Confirmation number:
${cleanForwardFieldText(metadata.reservationNumber) ?? "Not provided"}

Guest name:
${cleanForwardFieldText(metadata.guestName) ?? "Not provided"}

Guests:
${formatGuestCounts(metadata)}

Room type:
${translatedFields.room}

Total price:
${metadata.originalAmount ? `${metadata.originalCurrency ?? ""} ${metadata.originalAmount}`.trim() : "Not provided"}

Hotel address:
${translatedFields.hotelAddress}

Hotel phone:
${cleanForwardFieldText(metadata.hotelPhone) ?? "Not provided"}

Booking site:
${cleanForwardFieldText(metadata.bookingSite) ?? "Not provided"}

Number of nights:
${metadata.nights ?? "Not provided"}

Meal plan:
${translatedFields.mealPlan}

Cancellation policy:
${translatedFields.cancellationPolicy}

Status:
${metadata.status}

Original email type:
${metadata.emailType}

Forwarding reference:
Hotel Name: ${metadata.hotelName}
Booking Site / Reservation Number: ${formatBookingReference(metadata)}
Check-in: ${formattedCheckIn}
Check-out: ${formattedCheckOut}
Notes: ${translatedFields.notes}`);

  return { subject, body };
}

function formatBookingReference(metadata: ReservationMetadata) {
  return `${cleanForwardFieldText(metadata.bookingSite) ?? "Not provided"} / ${cleanForwardFieldText(metadata.reservationNumber) ?? "Not provided"}`;
}

function formatGuestCounts(metadata: ReservationMetadata) {
  const parts = [];
  if (typeof metadata.adultCount === "number") parts.push(`${metadata.adultCount} ${metadata.adultCount === 1 ? "adult" : "adults"}`);
  if (typeof metadata.childCount === "number") parts.push(`${metadata.childCount} ${metadata.childCount === 1 ? "child" : "children"}`);
  return parts.length ? parts.join(", ") : "Not provided";
}

function formatForwardDate(value?: string, options?: { verbose?: boolean }) {
  if (!value) return "Not provided";
  const normalized = value.trim();
  const isoDateMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!isoDateMatch) return normalized;

  const parsed = new Date(`${isoDateMatch[1]}-${isoDateMatch[2]}-${isoDateMatch[3]}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return normalized;

  return new Intl.DateTimeFormat("en-US", {
    weekday: options?.verbose ? "long" : undefined,
    month: options?.verbose ? "long" : "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(parsed);
}

function cleanForwardFieldText(value?: string) {
  if (!value) return undefined;

  const cleaned = decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/div>|<\/tr>|<\/li>/gi, "\n")
      .replace(/<li>/gi, "- ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return cleaned || undefined;
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function containsNonAscii(value?: string) {
  return Boolean(value && /[^\x00-\x7F]/.test(value));
}

async function translateForwardFieldsToEnglish(metadata: ReservationMetadata) {
  const cleaned = {
    hotelAddress: cleanForwardFieldText(metadata.hotelAddress) ?? "Not provided",
    room: cleanForwardFieldText(metadata.room) ?? "Not provided",
    mealPlan: cleanForwardFieldText(metadata.mealPlan) ?? "Not provided",
    cancellationPolicy: cleanForwardFieldText(metadata.cancellationPolicy) ?? "Not provided",
    notes: cleanForwardFieldText(metadata.notes) ?? "None"
  };

  const needsTranslation = Object.values(cleaned).some(containsNonAscii);
  if (!client || !needsTranslation) return cleaned;

  try {
    const response = await client.responses.create({
      model: config.OPENAI_MODEL,
      input: [
        {
          role: "system",
          content:
            "Translate the provided hotel reservation fields into concise, parser-friendly English. Preserve all numbers, dates, times, currencies, and booking terms exactly. Remove HTML fragments. Return strict JSON with the same keys only."
        },
        {
          role: "user",
          content: JSON.stringify(cleaned)
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "forward_email_fields",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["hotelAddress", "room", "mealPlan", "cancellationPolicy", "notes"],
            properties: {
              hotelAddress: { type: "string" },
              room: { type: "string" },
              mealPlan: { type: "string" },
              cancellationPolicy: { type: "string" },
              notes: { type: "string" }
            }
          }
        }
      }
    });

    const translated = JSON.parse(response.output_text) as Record<string, string>;
    return {
      hotelAddress: cleanForwardFieldText(translated.hotelAddress) ?? cleaned.hotelAddress,
      room: cleanForwardFieldText(translated.room) ?? cleaned.room,
      mealPlan: cleanForwardFieldText(translated.mealPlan) ?? cleaned.mealPlan,
      cancellationPolicy: cleanForwardFieldText(translated.cancellationPolicy) ?? cleaned.cancellationPolicy,
      notes: cleanForwardFieldText(translated.notes) ?? cleaned.notes
    };
  } catch {
    return cleaned;
  }
}

function mockExtract(email: SourceEmail): ReservationMetadata {
  const lower = `${email.subject}\n${email.body}`.toLowerCase();
  const isCancel = /cancel|キャンセル/.test(lower);
  const isChange = /change|変更/.test(lower);
  const isPriceAlert = /hotelslash|price|低価格|値下げ/.test(lower);
  return {
    hotelName: findLine(email.body, ["ホテル", "hotel"]) ?? "Sample Hotel Tokyo",
    hotelAddress: findLine(email.body, ["住所", "address"]) ?? "1-1-1 Marunouchi, Tokyo, Japan",
    hotelPhone: findLine(email.body, ["電話", "phone"]) ?? "+81-3-0000-0000",
    bookingSite: inferBookingSiteFromEmail(email),
    reservationNumber: findLine(email.body, ["予約番号", "reservation", "itinerary"]) ?? email.id.slice(0, 8).toUpperCase(),
    guestName: findLine(email.body, ["guest", "guest name", "宿泊者", "氏名", "お名前"]),
    adultCount: findGuestCount(email.body, ["adult", "adults", "大人"]),
    childCount: findGuestCount(email.body, ["child", "children", "子供", "子ども", "こども"]),
    reservationConfirmationUrl: findUrl(email.body),
    status: isPriceAlert ? "Price Alert" : isCancel ? "Cancelled" : isChange ? "Modified" : "Confirmed",
    emailType: isPriceAlert
      ? "HotelSlash Price Alert"
      : isCancel
        ? "Cancellation Notice"
        : isChange
          ? "Change Notice"
          : "Reservation Confirmation",
    checkIn: "2026-06-12",
    checkOut: "2026-06-15",
    nights: 3,
    room: "Standard room",
    mealPlan: inferMealPlanFromEmailBody(email.body),
    originalCurrency: "JPY",
    originalAmount: 42000,
    cancellationPolicy: "Free cancellation policy not provided in mock data.",
    notes: "Generated in mock mode because live AI credentials are not configured."
  };
}

export function assertLooksLikeHotelReservation(email: SourceEmail, metadata: ReservationMetadata): void {
  const text = `${email.subject}\n${email.body}`.replace(/\r/g, "\n");
  const normalized = text.toLowerCase();
  const transportSignalCount = countTransportSignals(normalized);
  const restaurantSignalCount = countRestaurantSignals(normalized);
  const churchSignalCount = countReligiousSiteSignals(normalized);
  const ruinsSignalCount = countRuinsSignals(normalized);
  const museumSignalCount = countMuseumSignals(normalized);
  const staySignalCount = countStaySignals(normalized, metadata);
  const lodgingSignalCount = countLodgingSignals(normalized, metadata);
  const hasHotelOnlyDestinationSignal =
    /\bdrop[\s-]?off address\b/i.test(normalized) &&
    /\b(hotel|inn|resort|hostel|ryokan|apartment|suites?)\b/i.test(metadata.hotelName ?? "");
  const hasExplicitRestaurantReservationSignal =
    /\btable\b/i.test(normalized) || /\bdining time\b/i.test(normalized) || /\btasting\b/i.test(normalized);

  if (transportSignalCount >= 2 && (staySignalCount === 0 || hasHotelOnlyDestinationSignal)) {
    throw new NonHotelReservationEmailError(
      "Email looks like a transport or transfer booking, not a hotel reservation."
    );
  }
  if (restaurantSignalCount >= 2 && staySignalCount < 3 && (lodgingSignalCount < 2 || hasExplicitRestaurantReservationSignal)) {
    throw new NonHotelReservationEmailError(
      "Email looks like a restaurant reservation, not a hotel reservation."
    );
  }
  if (churchSignalCount >= 2 && staySignalCount < 3 && lodgingSignalCount < 2) {
    throw new NonHotelReservationEmailError(
      "Email looks like a church reservation or event, not a hotel reservation."
    );
  }
  if (ruinsSignalCount >= 2 && staySignalCount < 3 && lodgingSignalCount < 2) {
    throw new NonHotelReservationEmailError(
      "Email looks like an archaeological site or ruins booking, not a hotel reservation."
    );
  }
  if (museumSignalCount >= 2 && staySignalCount < 3 && lodgingSignalCount < 2) {
    throw new NonHotelReservationEmailError(
      "Email looks like a museum or gallery booking, not a hotel reservation."
    );
  }
}

function findLine(body: string, labels: string[]): string | undefined {
  const line = body.split(/\r?\n/).find((candidate) => labels.some((label) => candidate.toLowerCase().includes(label)));
  return line?.replace(/^.*?[:：]\s*/, "").trim();
}

function findUrl(body: string): string | undefined {
  return body.match(/https?:\/\/[^\s"'<>]+/)?.[0];
}

function findGuestCount(body: string, labels: string[]): number | undefined {
  for (const line of body.split(/\r?\n/)) {
    const lowerLine = line.toLowerCase();
    if (!labels.some((label) => lowerLine.includes(label.toLowerCase()))) continue;
    const value = line.match(/\d+/)?.[0];
    if (value) return Number(value);
  }
  return undefined;
}

function compactNulls(metadata: ReservationMetadata): ReservationMetadata {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== null)) as unknown as ReservationMetadata;
}

function countMatches(text: string, patterns: RegExp[]) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function countTransportSignals(text: string) {
  return countMatches(text, [
    /\bpick[\s-]?up address\b/i,
    /\bdrop[\s-]?off address\b/i,
    /\bvehicle type\b/i,
    /\bdriver(s)?\b/i,
    /\btrain station\b/i,
    /\bairport transfer\b/i,
    /\bairport shuttle\b/i,
    /\bairport pickup\b/i,
    /\bairport pick-up\b/i,
    /\bairport drop[\s-]?off\b/i,
    /\bfare\b/i,
    /\barrivals?\b/i,
    /\bdeparture\b/i,
    /\bwhatsapp\b/i,
    /\btaxi(datum)?\b/i,
    /\btransfer\b/i,
    /\bbooking manager\b/i,
    /\bshuttle\b/i,
    /\bprivate car\b/i
  ]);
}

function countRestaurantSignals(text: string) {
  return countMatches(text, [
    /\brestaurant\b/i,
    /\bdining\b/i,
    /\btable\b/i,
    /\bmenu\b/i,
    /\btasting\b/i,
    /\bchef'?s table\b/i,
    /\bmeal time\b/i,
    /\bparty size\b/i
  ]);
}

function countReligiousSiteSignals(text: string) {
  return countMatches(text, [
    /\bchurch\b/i,
    /\bcathedral\b/i,
    /\bbasilica\b/i,
    /\bchapel\b/i,
    /\bparish\b/i,
    /\bmass\b/i,
    /\bworship\b/i,
    /\babbey\b/i,
    /\bmonastery\b/i,
    /\bmosque\b/i,
    /\bsynagogue\b/i,
    /\bshrine\b/i,
    /\bpilgrimage\b/i
  ]);
}

function countRuinsSignals(text: string) {
  return countMatches(text, [
    /\bruins?\b/i,
    /\barchaeological\b/i,
    /\barchaeology\b/i,
    /\bheritage site\b/i,
    /\bcitadel\b/i,
    /\btemple\b/i,
    /\bsanctuary\b/i,
    /\bfortress\b/i,
    /\bsite ticket\b/i
  ]);
}

function countMuseumSignals(text: string) {
  return countMatches(text, [
    /\bmuseum\b/i,
    /\bgallery\b/i,
    /\bexhibition\b/i,
    /\bexhibit\b/i,
    /\badmission\b/i,
    /\bentry ticket\b/i,
    /\baudio guide\b/i,
    /\bvisitor(s)?\b/i
  ]);
}

function countLandmarkOrAttractionSignals(text: string) {
  return countMatches(text, [
    /\bobservatory\b/i,
    /\bobservation deck\b/i,
    /\bviewing platform\b/i,
    /\btheme park\b/i,
    /\bamusement park\b/i,
    /\baquarium\b/i,
    /\bzoo\b/i,
    /\btower\b/i,
    /\btimed entry\b/i,
    /\btime slot\b/i,
    /\bskip-the-line\b/i,
    /\battraction\b/i,
    /\bentry pass\b/i,
    /\bpark reservation\b/i
  ]);
}

function countTourOrActivitySignals(text: string) {
  return countMatches(text, [
    /\btour\b/i,
    /\bexcursion\b/i,
    /\bguided visit\b/i,
    /\bwalking tour\b/i,
    /\bday trip\b/i,
    /\bcooking class\b/i,
    /\bworkshop\b/i,
    /\bclass booking\b/i,
    /\bactivity\b/i,
    /\bexperience\b/i,
    /\bboat trip\b/i,
    /\bcruise\b/i,
    /\bsnorkeling\b/i,
    /\bdiving\b/i,
    /\bhiking\b/i,
    /\btrek\b/i
  ]);
}

function countPerformanceOrSportsSignals(text: string) {
  return countMatches(text, [
    /\bconcert\b/i,
    /\btheater\b/i,
    /\btheatre\b/i,
    /\bshow time\b/i,
    /\bperformance\b/i,
    /\bmatch ticket\b/i,
    /\bstadium\b/i,
    /\barena\b/i,
    /\bseat number\b/i,
    /\bticket holder\b/i
  ]);
}

function looksLikeTransportBooking(text: string) {
  return countTransportSignals(text) >= 2;
}

function looksLikeRestaurantBooking(text: string) {
  return countRestaurantSignals(text) >= 2;
}

function looksLikeReligiousSiteBooking(text: string) {
  return countReligiousSiteSignals(text) >= 2;
}

function looksLikeRuinsBooking(text: string) {
  return countRuinsSignals(text) >= 2;
}

function looksLikeMuseumBooking(text: string) {
  return countMuseumSignals(text) >= 2;
}

function looksLikeLandmarkOrAttractionBooking(text: string) {
  return countLandmarkOrAttractionSignals(text) >= 2;
}

function looksLikeTourOrActivityBooking(text: string) {
  return countTourOrActivitySignals(text) >= 2;
}

function looksLikePerformanceOrSportsBooking(text: string) {
  return countPerformanceOrSportsSignals(text) >= 2;
}

function countHotelStayTextSignals(text: string) {
  return countMatches(text, [
    /\bcheck[\s-]?in\b/i,
    /\bcheck[\s-]?out\b/i,
    /\b\d+\s+nights?\b/i,
    /\broom type\b/i,
    /\broom\b/i,
    /\bguest room\b/i,
    /\brate plan\b/i,
    /\bhotel reservation\b/i,
    /\bhotel booking\b/i,
    /\breservation confirmed\b/i,
    /\bbooking confirmed\b/i,
    /ご宿泊予約/i,
    /予約が確定しました/i,
    /宿泊予約確認/i,
    /\bcancellation policy\b/i,
    /\bproperty address\b/i
  ]);
}

function countStaySignals(text: string, metadata: ReservationMetadata) {
  let count = 0;
  if (metadata.checkIn || /\bcheck[\s-]?in\b|チェックイン/i.test(text)) count += 1;
  if (metadata.checkOut || /\bcheck[\s-]?out\b|チェックアウト/i.test(text)) count += 1;
  if (typeof metadata.nights === "number" || /\b\d+\s+nights?\b|泊/i.test(text)) count += 1;
  if (metadata.room || /\broom\b|客室|部屋/i.test(text)) count += 1;
  if (metadata.mealPlan || /breakfast|dinner|meal plan|room only|half board|full board|朝食|夕食|食事/i.test(text)) count += 1;
  if (metadata.cancellationPolicy || /cancel|cancellation|返金|キャンセル/i.test(text)) count += 1;
  return count;
}

function countLodgingSignals(text: string, metadata: ReservationMetadata) {
  let count = 0;
  if (/\bhotel\b|inn|resort|hostel|ryokan|lodg(e|ing)|suite hotel|guesthouse|villa|aparthotel/i.test(text)) count += 1;
  if (/\broom\b|suite|bed type|king bed|queen bed|twin bed|villa|apartment/i.test(text)) count += 1;
  if (/\bfront desk\b|concierge|property|resort fee|occupancy|room rate/i.test(text)) count += 1;
  if (/\bhotel\b|inn|resort|hostel|ryokan|guesthouse|villa|aparthotel/i.test(metadata.hotelName ?? "")) count += 1;
  return count;
}

function applyEmailDerivedFallbacks(metadata: ReservationMetadata, emailBody: string): ReservationMetadata {
  if (metadata.mealPlan?.trim()) return metadata;
  const mealPlan = inferMealPlanFromEmailBody(emailBody);
  return mealPlan ? { ...metadata, mealPlan } : metadata;
}

export function inferMealPlanFromEmailBody(emailBody: string): string | undefined {
  const candidates = emailBody
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const matches = candidates.filter(isMealPlanLine).map(normalizeMealPlanLine);
  return matches.length ? [...new Set(matches)].join(", ") : undefined;
}

function isMealPlanLine(line: string) {
  const normalized = line.toLowerCase();
  if (!/(breakfast|dinner|lunch|meal plan|half board|full board|all inclusive|room only|朝食|夕食|昼食|食事)/i.test(line)) {
    return false;
  }
  return !/(cancellation|cancel|check-?in|check-?out|traveler|guest name|reservation number|confirmation number|total price|tax|fee)/i.test(normalized);
}

function normalizeMealPlanLine(line: string) {
  const trimmed = line.replace(/^[•*\-\u2022]\s*/, "").trim();
  if (/^breakfast included$/i.test(trimmed)) return "Breakfast Included";
  if (/^room only$/i.test(trimmed)) return "Room Only";
  return trimmed;
}
