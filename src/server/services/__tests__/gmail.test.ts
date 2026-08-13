import { describe, expect, it } from "vitest";
import {
  assertOriginalReservationAttachmentEmail,
  buildCandidateQuery,
  choosePreferredReservationSourceEmail,
  createForwardLikeEmail,
  createRawEmailWithOriginalAttachment,
  extractLowerRateButtonUrl,
  hasGmailTokens,
  isLikelyForwardedReservationEmail,
  isLowerRateEmail,
  isUserAuthoredEmail,
  prioritizeOriginalEmails
} from "../gmail";

describe("Gmail candidate query", () => {
  it("includes Expedia itinerary terms while keeping processed messages excluded", () => {
    const query = buildCandidateQuery();

    expect(query).toContain("in:inbox");
    expect(query).toContain("newer_than:7d");
    expect(query).toContain('-label:"ZenForwarder/Processed"');
    expect(query).toContain("Expedia");
    expect(query).toContain("itinerary");
    expect(query).toContain('"travel confirmation"');
    expect(query).toContain('"CLICK HERE TO SEE YOUR RATES"');
    expect(query).toContain('"We found you a better price"');
    expect(query).toContain("-from:do-not-reply@tripit.com");
  });

  it("keeps inbox filtering but allows processed-labeled messages during force reload", () => {
    const query = buildCandidateQuery({ includeProcessed: true });

    expect(query).toContain("in:inbox");
    expect(query).not.toContain('-label:"ZenForwarder/Processed"');
  });

  it("does not exclude the user's forwarding alias because manual forwarded reservation emails come from it", () => {
    const query = buildCandidateQuery();

    expect(query).not.toContain("-from:sender@example.com");
    expect(query).not.toContain('-subject:"Hotel Reservation -"');
  });
});

describe("hasGmailTokens", () => {
  it("treats empty or missing session tokens as unauthenticated", () => {
    expect(hasGmailTokens(undefined)).toBe(false);
    expect(hasGmailTokens(null)).toBe(false);
    expect(hasGmailTokens({ access_token: "token" })).toBe(true);
  });
});

describe("isLowerRateEmail", () => {
  it("detects a HotelSlash proposal by sender and body even if the subject text varies", () => {
    expect(
      isLowerRateEmail({
        id: "msg-1",
        from: "HotelSlash <alerts@hotelslash.com>",
        subject: "Good news about your stay",
        receivedAt: "2026-08-10T00:00:00.000Z",
        body: "We found you a better price! CLICK HERE TO SEE YOUR RATES"
      })
    ).toBe(true);
  });

  it("does not mark unrelated hotel messages as lower-rate proposals", () => {
    expect(
      isLowerRateEmail({
        id: "msg-2",
        from: "booking@example.com",
        subject: "Hotel reservation confirmed",
        receivedAt: "2026-08-10T00:00:00.000Z",
        body: "Your reservation is confirmed."
      })
    ).toBe(false);
  });
});

describe("reservation email prioritization", () => {
  it("detects user-authored reservation wrappers from the configured sender addresses", () => {
    expect(
      isUserAuthoredEmail({
        id: "self-1",
        from: "Sample Traveler <sender@example.com>",
        subject: "Fwd: Holiday Inn confirmation",
        receivedAt: "2026-08-10T05:37:08.000Z",
        body: "Body"
      })
    ).toBe(true);
  });

  it("detects forwarded reservation wrappers from the subject or body", () => {
    expect(
      isLikelyForwardedReservationEmail({
        id: "forwarded-1",
        from: "sender@example.com",
        subject: "Fwd: Holiday Inn confirmation",
        receivedAt: "2026-08-10T05:37:08.000Z",
        body: "Body"
      })
    ).toBe(true);

    expect(
      isLikelyForwardedReservationEmail({
        id: "forwarded-2",
        from: "sender@example.com",
        subject: "Holiday Inn confirmation",
        receivedAt: "2026-08-10T05:37:08.000Z",
        body: "Begin forwarded message:\nFrom: Hotel"
      })
    ).toBe(true);
  });

  it("prioritizes non-forwarded originals ahead of Fwd wrappers for the same reservation search", () => {
    const sorted = prioritizeOriginalEmails([
      {
        id: "forwarded",
        from: "sender@example.com",
        subject: "Fwd: Holiday Inn Auckland Airport confirmation",
        receivedAt: "2026-08-10T05:37:08.000Z",
        body: "Begin forwarded message:\nFrom: Hotel"
      },
      {
        id: "original",
        from: "Holiday Inn <hotel@example.com>",
        subject: "Holiday Inn Auckland Airport confirmation",
        receivedAt: "2026-08-10T02:55:22.000Z",
        body: "Original reservation body"
      }
    ]);

    expect(sorted.map((email) => email.id)).toEqual(["original", "forwarded"]);
  });

  it("chooses the original vendor email for attachments when the current candidate is a Fwd wrapper", () => {
    const selected = choosePreferredReservationSourceEmail(
      [
        {
          id: "original",
          from: "Holiday Inn <hotel@example.com>",
          subject: "Holiday Inn Auckland Airport confirmation",
          receivedAt: "2026-08-10T02:55:22.000Z",
          body: "Original reservation body"
        }
      ],
      {
        id: "forwarded",
        from: "sender@example.com",
        subject: "Fwd: Holiday Inn Auckland Airport confirmation",
        receivedAt: "2026-08-10T05:37:08.000Z",
        body: ""
      }
    );

    expect(selected?.id).toBe("original");
  });

  it("keeps the original vendor email ahead of newer user-authored generated or forwarded emails", () => {
    const sorted = prioritizeOriginalEmails([
      {
        id: "generated",
        from: "Sample Traveler <sender@example.com>",
        subject: "Hotel reservation confirmation: Holiday Inn Auckland Airport, check in Monday, November 9, 2026, check out Tuesday, November 10, 2026",
        receivedAt: "2026-08-10T06:00:00.000Z",
        body: "Forwarding reference:\nBooking Site / Reservation Number: IHG / 41700582"
      },
      {
        id: "forwarded",
        from: "Sample Traveler <sender@example.com>",
        subject: "Fwd: Holiday Inn Auckland Airport confirmation",
        receivedAt: "2026-08-10T05:37:08.000Z",
        body: "Begin forwarded message:\nFrom: Hotel"
      },
      {
        id: "original",
        from: "\"Holiday Inn Hotels & Resorts\" <HolidayInn@tx.ihg.com>",
        subject: "Holiday Inn Auckland Airport confirmation",
        receivedAt: "2026-08-10T02:55:22.000Z",
        body: "Original reservation body"
      }
    ]);

    expect(sorted.map((email) => email.id)).toEqual(["original", "generated", "forwarded"]);
  });

  it("accepts a vendor-authored original reservation email as a safe attachment source", () => {
    expect(() =>
      assertOriginalReservationAttachmentEmail(
        {
          id: "original",
          from: "\"Holiday Inn Hotels & Resorts\" <HolidayInn@tx.ihg.com>",
          subject: "Holiday Inn Auckland Airport のご宿泊予約が確定しました。# 41700582 ： 9 Nov 2026",
          receivedAt: "2026-08-10T02:55:22.000Z",
          body: "予約確認番号: 41700582\nHoliday Inn Auckland Airport"
        },
        { reservationNumber: "41700582", hotelName: "Holiday Inn Auckland Airport" }
      )
    ).not.toThrow();
  });

  it("rejects forwarded or self-generated reservation emails as attachment sources", () => {
    expect(() =>
      assertOriginalReservationAttachmentEmail(
        {
          id: "forwarded",
          from: "Sample Traveler <sender@example.com>",
          subject: "Fwd: Holiday Inn Auckland Airport confirmation",
          receivedAt: "2026-08-10T05:37:08.000Z",
          body: "Begin forwarded message:\nFrom: Hotel"
        },
        { reservationNumber: "41700582", hotelName: "Holiday Inn Auckland Airport" }
      )
    ).toThrow("not the original reservation");

    expect(() =>
      assertOriginalReservationAttachmentEmail(
        {
          id: "generated",
          from: "Sample Traveler <sender@example.com>",
          subject: "Hotel reservation confirmation: Holiday Inn Auckland Airport, check in Monday, November 9, 2026, check out Tuesday, November 10, 2026",
          receivedAt: "2026-08-10T06:00:00.000Z",
          body: "Forwarding reference:\nBooking Site / Reservation Number: IHG / 41700582"
        },
        { reservationNumber: "41700582", hotelName: "Holiday Inn Auckland Airport" }
      )
    ).toThrow("ZenForwarder-generated");
  });
});

describe("extractLowerRateButtonUrl", () => {
  it("extracts the HotelSlash offer URL from a forwarded markdown link", () => {
    expect(
      extractLowerRateButtonUrl(
        "[View Your Lower Rate](https://www.hotelslash.com/offer/78038516-4d78-43c8-91f5-b9756a3f8c5a)"
      )
    ).toBe("https://www.hotelslash.com/offer/78038516-4d78-43c8-91f5-b9756a3f8c5a");
  });

  it("prefers the actual HotelSlash offer URL over unrelated links in the same email", () => {
    expect(
      extractLowerRateButtonUrl(
        [
          "[Need a rental too? Book a car with AutoSlash](https://www.autoslash.com/)",
          "[Begin Step 1](https://www.hotelslash.com/offer/78038516-4d78-43c8-91f5-b9756a3f8c5a)",
          "[click here to unsubscribe.](https://www.hotelslash.com/tracking/ViewOfferDetails/78038516-4d78-43c8-91f5-b9756a3f8c5a/true)"
        ].join("\n")
      )
    ).toBe("https://www.hotelslash.com/offer/78038516-4d78-43c8-91f5-b9756a3f8c5a");
  });

  it("derives the offer URL from tracking links instead of returning the HotelSlash homepage", () => {
    expect(
      extractLowerRateButtonUrl(
        [
          "https://www.hotelslash.com/",
          "https://www.hotelslash.com/tracking/ViewOfferDetails/78038516-4d78-43c8-91f5-b9756a3f8c5a/true",
          "https://www.hotelslash.com/Privacy"
        ].join("\n")
      )
    ).toBe("https://www.hotelslash.com/offer/78038516-4d78-43c8-91f5-b9756a3f8c5a");
  });
});

describe("createRawEmailWithOriginalAttachment", () => {
  it("attaches the full original confirmation email for TripIt submissions", () => {
    const originalEmail = [
      "From: Expedia <expedia@example.com>",
      "Subject: Expedia travel confirmation",
      "",
      "Original vendor confirmation body"
    ].join("\r\n");

    const raw = createRawEmailWithOriginalAttachment(
      "plans@tripit.com",
      "Hotel Reservation - Sample Hotel - 2026-07-10 to 2026-07-12",
      "Booking Site / Reservation Number:\nExpedia / 123456789012",
      Buffer.from(originalEmail).toString("base64url")
    );
    const decoded = Buffer.from(raw, "base64url").toString("utf8");

    expect(decoded).toContain("To: plans@tripit.com");
    expect(decoded).toContain("Content-Type: multipart/mixed;");
    expect(decoded).toContain('Content-Type: message/rfc822; name="original-confirmation.eml"');
    expect(decoded).toContain('Content-Disposition: attachment; filename="original-confirmation.eml"');
    expect(decoded.replace(/\r?\n/g, "")).toContain(Buffer.from(originalEmail).toString("base64"));
  });

  it("can also build an attached-message forward for HotelSlash submissions", () => {
    const raw = createRawEmailWithOriginalAttachment(
      "checknow@hotelslash.com",
      "Hotel Reservation - Sample Hotel - Jul 10, 2026 to Jul 12, 2026",
      "Check-in:\nJul 10, 2026",
      Buffer.from("Subject: Original confirmation\r\n\r\nBody").toString("base64url")
    );
    const decoded = Buffer.from(raw, "base64url").toString("utf8");

    expect(decoded).toContain("To: checknow@hotelslash.com");
    expect(decoded).toContain('filename="original-confirmation.eml"');
  });
});

describe("createForwardLikeEmail", () => {
  it("builds an inline forwarded email without nesting the original as a .eml attachment", () => {
    const raw = createForwardLikeEmail("plans@tripit.com", {
      id: "original",
      from: "\"Holiday Inn Hotels & Resorts\" <HolidayInn@tx.ihg.com>",
      subject: "Holiday Inn Auckland Airport のご宿泊予約が確定しました。# 41700582 ： 9 Nov 2026",
      receivedAt: "2026-08-10T02:55:22.000Z",
      dateHeader: "Mon, 10 Aug 2026 13:54:35 +0900",
      to: "sender@example.com",
      textBody: "予約確認番号: 41700582\nHoliday Inn Auckland Airport\nCheck-in 3:00 pm / Check-out 11:00 am"
    });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");

    expect(decoded).toContain("To: plans@tripit.com");
    expect(decoded).toContain("Subject: Fwd: Holiday Inn Auckland Airport のご宿泊予約が確定しました。# 41700582 ： 9 Nov 2026");
    expect(decoded).toContain("---------- Forwarded message ---------");
    expect(decoded).toContain("From: \"Holiday Inn Hotels & Resorts\" <HolidayInn@tx.ihg.com>");
    expect(decoded).not.toContain('Content-Type: message/rfc822; name="original-confirmation.eml"');
    expect(decoded).not.toContain('filename="original-confirmation.eml"');
  });

  it("can force a plain-text-only forward for HotelSlash submissions", () => {
    const raw = createForwardLikeEmail(
      "save@hotelslash.com",
      {
        id: "original",
        from: "\"Holiday Inn Hotels & Resorts\" <HolidayInn@tx.ihg.com>",
        subject: "Your reservation at Holiday Inn Auckland Airport is confirmed. #41700582 - 9 Nov 2026",
        receivedAt: "2026-08-10T07:07:40.000Z",
        dateHeader: "Mon, 10 Aug 2026 01:07:40 -0600",
        to: "sender@example.com",
        textBody: "Dates\n9 Nov 2026 - 10 Nov 2026\nCheck in 3:00 pm / Check out 11:00 am",
        htmlBody: "<!DOCTYPE html><html><head><title>ignored</title></head><body><p>Visible HTML body</p></body></html>"
      },
      { plainTextOnly: true }
    );
    const decoded = Buffer.from(raw, "base64url").toString("utf8");

    expect(decoded).toContain("To: save@hotelslash.com");
    expect(decoded).toContain("Content-Type: text/plain; charset=utf-8");
    expect(decoded).not.toContain("multipart/alternative");
    expect(decoded).toContain("Dates");
    expect(decoded).toContain("9 Nov 2026 - 10 Nov 2026");
  });

  it("embeds only the source body fragment when the original HTML is a full document", () => {
    const raw = createForwardLikeEmail("plans@tripit.com", {
      id: "original",
      from: "\"Holiday Inn Hotels & Resorts\" <HolidayInn@tx.ihg.com>",
      subject: "Your reservation at Holiday Inn Auckland Airport is confirmed. #41700582 - 9 Nov 2026",
      receivedAt: "2026-08-10T07:07:40.000Z",
      dateHeader: "Mon, 10 Aug 2026 01:07:40 -0600",
      to: "sender@example.com",
      textBody: "Plain body",
      htmlBody: "<!DOCTYPE html><html><head><title>ignored</title></head><body><table><tr><td>Reservation body</td></tr></table></body></html>"
    });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");

    expect(decoded).toContain("Content-Type: multipart/alternative");
    expect(decoded).toContain("<table><tr><td>Reservation body</td></tr></table>");
    expect(decoded).not.toContain("<!DOCTYPE html>");
    expect(decoded).not.toContain("<head><title>ignored</title></head>");
  });
});
