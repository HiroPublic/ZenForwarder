import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceEmail } from "../services/ai";

let emails: SourceEmail[] = [
  {
    id: "sample-message-1",
    from: "booking@example.jp",
    subject: "ホテル予約確認",
    receivedAt: "2026-04-30T00:00:00.000Z",
    body: "ホテル: Sample Hotel"
  }
];
let lowerRate = false;
let unavailableRateUrls = new Set<string>();

class MockHotelSlashRatesUnavailableError extends Error {
  finalUrl: string;
  pageTitle?: string;

  constructor(message: string, finalUrl: string, pageTitle?: string) {
    super(message);
    this.name = "HotelSlashRatesUnavailableError";
    this.finalUrl = finalUrl;
    this.pageTitle = pageTitle;
  }
}

vi.mock("../services/gmail", () => ({
  fetchCandidateEmails: vi.fn(async () => emails),
  ensureSendAsAlias: vi.fn(),
  extractLowerRateButtonUrl: vi.fn((body: string) => body.match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? "https://hotelslash.example/rates"),
  isLowerRateEmail: vi.fn((email: SourceEmail) => lowerRate || /Lower Rate Found on Your Trip/i.test(email.subject)),
  markProcessed: vi.fn(),
  searchEmailsByReservationNumber: vi.fn(async () => emails),
  sendForward: vi.fn()
}));

vi.mock("../services/hotelslash", () => ({
  HotelSlashRatesUnavailableError: MockHotelSlashRatesUnavailableError,
  isHotelSlashRatesUnavailableError: vi.fn((error: unknown) => error instanceof MockHotelSlashRatesUnavailableError),
  extractTopHotelSlashOffer: vi.fn(async (url: string) => {
    if (unavailableRateUrls.has(url)) {
      throw new MockHotelSlashRatesUnavailableError(
        "HotelSlash says the lower rates are no longer available.",
        "https://www.hotelslash.com/Offer/RatesNotFound?identifier=sample",
        "Rate Not Found | HotelSlash | Hotel Price Tracker"
      );
    }
    return {
      pageUrl: "https://hotelslash.example/rates",
      priceCurrency: "JPY",
      priceAmount: 12000,
      roomType: "Standard Room",
      conditions: ["Refundable"]
    };
  })
}));

vi.mock("../services/ai", () => ({
  NonHotelReservationEmailError: class NonHotelReservationEmailError extends Error {
    constructor(message = "Email does not appear to be a hotel reservation.") {
      super(message);
      this.name = "NonHotelReservationEmailError";
    }
  },
  extractReservationJson: vi.fn(async () => ({
    hotelName: "Sample Hotel",
    reservationNumber: "SAMPLE-RESERVATION-1",
    checkIn: "2026-06-01",
    checkOut: "2026-06-03",
    status: "Confirmed",
    emailType: "Reservation Confirmation"
  })),
  generateForwardEmail: vi.fn(async () => ({
    subject: "Hotel Reservation - Sample Hotel - TBD to TBD",
    body: "Hotel Reservation\n\nGuests:\n[Redacted]"
  }))
}));

vi.mock("../services/exchange", () => ({
  convertToJpy: vi.fn(async () => undefined)
}));

vi.mock("../services/notion", () => ({
  createLowPriceProposalRecord: vi.fn(async () => "low-price-notion-page-id"),
  createReservationRecord: vi.fn(async () => "notion-page-id"),
  ensureReservationDatabaseSchema: vi.fn(async () => undefined),
  findLatestProposalByNameAndCheckIn: vi.fn(async () => undefined),
  findNonHotelSlashBookingSiteForCheckIn: vi.fn(async () => undefined),
  findRelatedReservation: vi.fn(async () => undefined),
  hasCheckedHotelArrangementForCheckIn: vi.fn(async () => false),
  updateReservationEmailType: vi.fn(async () => undefined)
}));

describe("workflow dismiss and reload", () => {
  beforeEach(() => {
    emails = [
      {
        id: "sample-message-1",
        from: "booking@example.jp",
        subject: "ホテル予約確認",
        receivedAt: "2026-04-30T00:00:00.000Z",
        body: "ホテル: Sample Hotel"
      }
    ];
    lowerRate = false;
    unavailableRateUrls = new Set<string>();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("excludes the dismissed Gmail message from the reloaded candidate list", async () => {
    const workflow = await import("../workflow");
    const { items } = await workflow.syncReservations();
    const [item] = items;

    expect(item.gmailMessageId).toBe("sample-message-1");

    const reloaded = await workflow.dismissForwardAndReload(item.id);

    expect(reloaded).toEqual([]);
    expect(workflow.listPending()).toEqual([]);
  });

  it("removes approved messages from the app queue and prevents them from reappearing on sync", async () => {
    const workflow = await import("../workflow");
    const { items } = await workflow.syncReservations();
    const [item] = items;

    await workflow.approveForward(item.id, item.generatedBody);

    expect(workflow.listPending()).toEqual([]);
    expect((await workflow.syncReservations()).items).toEqual([]);
  });

  it("marks all inbox emails for the same reservation as processed after approval", async () => {
    emails = [
      { ...emails[0], id: "sample-message-1", subject: "Fwd: ホテル予約確認" },
      { ...emails[0], id: "sample-message-2", subject: "ホテル予約確認" }
    ];
    const gmail = await import("../services/gmail");
    const workflow = await import("../workflow");
    const { items } = await workflow.syncReservations();
    const [item] = items;

    await workflow.approveForward(item.id, item.generatedBody);

    expect(gmail.markProcessed).toHaveBeenCalledWith(undefined, "sample-message-1");
    expect(gmail.markProcessed).toHaveBeenCalledWith(undefined, "sample-message-2");
  });

  it("can re-import an already processed reservation in force reload mode for verification", async () => {
    const workflow = await import("../workflow");
    const { items } = await workflow.syncReservations();
    const [item] = items;

    await workflow.approveForward(item.id, item.generatedBody);

    const reloaded = await workflow.syncReservations(undefined, { forceReload: true });

    expect(reloaded.items).toHaveLength(1);
    expect(reloaded.items[0]?.gmailMessageId).toBe("sample-message-1");
  });

  it("can re-import an already processed reservation by specifying its reservation number", async () => {
    emails = [
      {
        id: "generated-message-1",
        from: "Sample Traveler <sender@example.com>",
        subject: "Hotel reservation confirmation: Sample Hotel, check in Monday, June 1, 2026, check out Wednesday, June 3, 2026",
        receivedAt: "2026-08-10T06:00:00.000Z",
        body: "Forwarding reference:\nBooking Site / Reservation Number: Expedia / SAMPLE-RESERVATION-1"
      },
      {
        id: "original-message-1",
        from: "booking@example.jp",
        subject: "ホテル予約確認",
        receivedAt: "2026-04-30T00:00:00.000Z",
        body: "ホテル: Sample Hotel"
      }
    ];
    const gmail = await import("../services/gmail");
    vi.mocked(gmail.searchEmailsByReservationNumber).mockResolvedValueOnce([emails[1]!]);
    const workflow = await import("../workflow");
    const { items } = await workflow.syncReservations();
    const [item] = items;

    await workflow.approveForward(item.id, item.generatedBody);

    const reloaded = await workflow.syncReservations(undefined, { reservationNumber: "SAMPLE-RESERVATION-1" });

    expect(reloaded.items).toHaveLength(1);
    expect(reloaded.items[0]?.metadata.reservationNumber).toBe("SAMPLE-RESERVATION-1");
  });

  it("inherits checked Hotel Arrangement when an approved forward creates a Notion entry", async () => {
    const gmail = await import("../services/gmail");
    const notion = await import("../services/notion");
    vi.mocked(notion.hasCheckedHotelArrangementForCheckIn).mockResolvedValueOnce(true);
    const workflow = await import("../workflow");
    const { items } = await workflow.syncReservations();
    const [item] = items;

    await workflow.approveForward(item.id, item.generatedBody);

    expect(notion.createReservationRecord).toHaveBeenCalledWith(
      item,
      expect.objectContaining({ hotelArrangement: true })
    );
    expect(gmail.sendForward).toHaveBeenCalled();
  });

  it("registers a pending message in Notion without forwarding and inherits checked Hotel Arrangement", async () => {
    const gmail = await import("../services/gmail");
    const notion = await import("../services/notion");
    vi.mocked(notion.hasCheckedHotelArrangementForCheckIn).mockResolvedValueOnce(true);
    const workflow = await import("../workflow");
    const { items } = await workflow.syncReservations();
    const [item] = items;

    const result = await workflow.registerForwardInNotionOnly(item.id);

    expect(result.hotelArrangement).toBe(true);
    expect(notion.createReservationRecord).toHaveBeenCalledWith(item, { hotelArrangement: true });
    expect(gmail.ensureSendAsAlias).not.toHaveBeenCalled();
    expect(gmail.sendForward).not.toHaveBeenCalled();
    expect(gmail.markProcessed).toHaveBeenCalledWith(undefined, "sample-message-1");
    expect(workflow.listPending()).toEqual([]);
  });

  it("inherits checked Hotel Arrangement when deciding a HotelSlash proposal", async () => {
    lowerRate = true;
    const notion = await import("../services/notion");
    vi.mocked(notion.hasCheckedHotelArrangementForCheckIn).mockResolvedValue(true);
    const workflow = await import("../workflow");
    const { items } = await workflow.syncReservations();
    const [item] = items;

    await workflow.decideLowPriceProposal(item.id, "accepted");

    expect(notion.updateReservationEmailType).toHaveBeenCalledWith("low-price-notion-page-id", "Proposal accepted", {
      hotelArrangement: true
    });
  });

  it("uses a non-HotelSlash booking site from matching Check-in entries for proposal display", async () => {
    lowerRate = true;
    const notion = await import("../services/notion");
    vi.mocked(notion.findNonHotelSlashBookingSiteForCheckIn).mockResolvedValueOnce("Expedia.com");
    const workflow = await import("../workflow");

    const { items } = await workflow.syncReservations();
    const [item] = items;

    expect(item.proposal?.bookingSite).toBe("Expedia.com");
  });

  it("keeps an unavailable HotelSlash offer as an acknowledgment item and continues sync", async () => {
    emails = [
      {
        id: "hotelslash-unavailable",
        from: "alerts@hotelslash.com",
        subject: "Lower Rate Found on Your Trip",
        receivedAt: "2026-05-12T00:00:00.000Z",
        body: "CLICK HERE TO SEE YOUR RATES https://hotelslash.example/unavailable"
      },
      {
        id: "hotelslash-available",
        from: "alerts@hotelslash.com",
        subject: "Lower Rate Found on Your Trip",
        receivedAt: "2026-05-12T01:00:00.000Z",
        body: "CLICK HERE TO SEE YOUR RATES https://hotelslash.example/available"
      }
    ];
    lowerRate = true;
    unavailableRateUrls = new Set(["https://hotelslash.example/unavailable"]);
    const workflow = await import("../workflow");

    const { items: firstPass } = await workflow.syncReservations();

    expect(firstPass).toHaveLength(2);
    expect(firstPass.some((item) => item.kind === "unavailableLowPriceProposal")).toBe(true);
    expect(firstPass.some((item) => item.gmailMessageId === "hotelslash-available" && item.kind === "lowPriceProposal")).toBe(true);
  });

  it("marks unavailable HotelSlash offers as processed without forwarding or Notion updates", async () => {
    emails = [
      {
        id: "hotelslash-unavailable",
        from: "alerts@hotelslash.com",
        subject: "Lower Rate Found on Your Trip",
        receivedAt: "2026-05-12T00:00:00.000Z",
        body: "CLICK HERE TO SEE YOUR RATES https://hotelslash.example/unavailable"
      }
    ];
    lowerRate = true;
    unavailableRateUrls = new Set(["https://hotelslash.example/unavailable"]);
    const gmail = await import("../services/gmail");
    const notion = await import("../services/notion");
    const workflow = await import("../workflow");

    const { items } = await workflow.syncReservations();
    const [item] = items;
    const result = await workflow.acknowledgeUnavailableLowPriceProposal(item.id);

    expect(result.item.kind).toBe("unavailableLowPriceProposal");
    expect(gmail.markProcessed).toHaveBeenCalledWith(undefined, "hotelslash-unavailable");
    expect(notion.createLowPriceProposalRecord).not.toHaveBeenCalled();
    expect(gmail.sendForward).not.toHaveBeenCalled();
    expect(workflow.listPending()).toEqual([]);
  });

  it("collapses multiple Gmail messages for the same reservation into one app candidate", async () => {
    emails = [
      { ...emails[0], id: "sample-message-1" },
      { ...emails[0], id: "sample-message-2" }
    ];
    const workflow = await import("../workflow");

    const { items: pending } = await workflow.syncReservations();

    expect(pending).toHaveLength(1);
  });

  it("still collapses duplicate reservation emails within the same force reload run", async () => {
    emails = [
      { ...emails[0], id: "sample-message-1" },
      { ...emails[0], id: "sample-message-2" }
    ];
    const workflow = await import("../workflow");

    const { items } = await workflow.syncReservations(undefined, { forceReload: true });

    expect(items).toHaveLength(1);
  });

  it("skips transport bookings that are not hotel reservations", async () => {
    emails = [
      {
        id: "taxi-message-1",
        from: "noreply@taxidatum.com",
        subject: "Booking confirmation: TD265565",
        receivedAt: "2026-05-12T00:00:00.000Z",
        body: "Pick up address: Ollantaytambo Train Station\nDrop off address: Hilton Garden Inn Cusco\nVehicle type: Sedan"
      }
    ];
    const ai = await import("../services/ai");
    vi.mocked(ai.extractReservationJson).mockRejectedValueOnce(new ai.NonHotelReservationEmailError());
    const workflow = await import("../workflow");

    expect((await workflow.syncReservations()).items).toEqual([]);
  });

  it("skips restaurant, church, and museum bookings that are not hotel reservations", async () => {
    emails = [
      {
        id: "restaurant-message-1",
        from: "bookings@restaurant.example",
        subject: "Reservation confirmed for dinner",
        receivedAt: "2026-05-12T00:00:00.000Z",
        body: "Restaurant reservation\nTable for 2\nDining time: 19:30"
      },
      {
        id: "church-message-1",
        from: "tickets@church.example",
        subject: "Cathedral visit reservation confirmed",
        receivedAt: "2026-05-12T01:00:00.000Z",
        body: "Basilica reservation\nCathedral entry at 10:00\nVisitors: 2"
      },
      {
        id: "museum-message-1",
        from: "tickets@museum.example",
        subject: "Museum ticket reservation confirmed",
        receivedAt: "2026-05-12T02:00:00.000Z",
        body: "Museum reservation\nExhibition entry ticket\nAudio guide included"
      }
    ];
    const ai = await import("../services/ai");
    vi.mocked(ai.extractReservationJson)
      .mockRejectedValueOnce(new ai.NonHotelReservationEmailError("restaurant"))
      .mockRejectedValueOnce(new ai.NonHotelReservationEmailError("church"))
      .mockRejectedValueOnce(new ai.NonHotelReservationEmailError("museum"));
    const workflow = await import("../workflow");

    expect((await workflow.syncReservations()).items).toEqual([]);
  });

  it("rebuilds existing forward candidates on sync so newly excluded emails disappear", async () => {
    emails = [
      {
        id: "taxi-message-existing",
        from: "noreply@taxidatum.com",
        subject: "Booking confirmation: TD265565",
        receivedAt: "2026-05-12T00:00:00.000Z",
        body: "Reservation body"
      }
    ];
    const ai = await import("../services/ai");
    const workflow = await import("../workflow");

    vi.mocked(ai.extractReservationJson).mockResolvedValueOnce({
      hotelName: "",
      hotelAddress: undefined,
      hotelPhone: undefined,
      bookingSite: "taxidatum.com",
      reservationNumber: "TD265565",
      guestName: "Mr. Sample Guest",
      adultCount: 2,
      childCount: undefined,
      reservationConfirmationUrl: "https://taxidatum.com",
      status: "Confirmed",
      emailType: "Reservation Confirmation",
      checkIn: "2026-07-21",
      checkOut: undefined,
      nights: undefined,
      room: undefined,
      mealPlan: undefined,
      originalCurrency: "USD",
      originalAmount: 35,
      cancellationPolicy: undefined,
      notes: undefined
    });
    const { items } = await workflow.syncReservations();
    const [first] = items;
    expect(first).toBeDefined();

    vi.mocked(ai.extractReservationJson).mockRejectedValueOnce(new ai.NonHotelReservationEmailError("transport"));
    expect((await workflow.syncReservations()).items).toEqual([]);
  });

  it("collects a failed email with subject, receivedAt, and from, then continues to the next email", async () => {
    emails = [
      {
        id: "broken-hotelslash",
        from: "alerts@hotelslash.com",
        subject: "Lower Rate Found on Your Trip",
        receivedAt: "2026-08-10T01:00:00.000Z",
        body: "CLICK HERE TO SEE YOUR RATES https://hotelslash.example/broken"
      },
      {
        id: "sample-message-2",
        from: "booking2@example.jp",
        subject: "ホテル予約確認 その2",
        receivedAt: "2026-08-10T02:00:00.000Z",
        body: "ホテル: Sample Hotel 2"
      }
    ];
    lowerRate = false;
    const hotelslash = await import("../services/hotelslash");
    vi.mocked(hotelslash.extractTopHotelSlashOffer).mockRejectedValueOnce(
      new Error("HotelSlash rates page loaded, but the top offer could not be extracted.")
    );
    const workflow = await import("../workflow");

    const result = await workflow.syncReservations();

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.gmailMessageId).toBe("sample-message-2");
    expect(result.errors).toEqual([
      expect.objectContaining({
        gmailMessageId: "broken-hotelslash",
        from: "alerts@hotelslash.com",
        subject: "Lower Rate Found on Your Trip",
        receivedAt: "2026-08-10T01:00:00.000Z",
        message: "HotelSlash rates page loaded, but the top offer could not be extracted."
      })
    ]);
  });
});
