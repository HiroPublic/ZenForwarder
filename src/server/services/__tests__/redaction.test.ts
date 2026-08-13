import { describe, expect, it } from "vitest";
import { generateForwardEmail, inferMealPlanFromEmailBody } from "../ai";
import { redactPersonalInformation } from "../redaction";

describe("redactPersonalInformation", () => {
  it("redacts member identifiers and credit card numbers on card-labeled lines", () => {
    const redacted = redactPersonalInformation(
      [
        "Guest Name: Sample Guest",
        "Membership: ABCD-1234",
        "Card: 4111 1111 1111 1111",
        "Reservation Number: 73434701251484",
        "Hotel Phone: +81-3-0000-0000"
      ].join("\n")
    );

    expect(redacted).toContain("Guest Name: Sample Guest");
    expect(redacted).toContain("Membership: [Redacted]");
    expect(redacted).toContain("Card: [Redacted]");
    expect(redacted).toContain("Reservation Number: 73434701251484");
    expect(redacted).toContain("Hotel Phone: +81-3-0000-0000");
  });

  it("keeps hotel phone, reservation number, and guest name in generated TripIt and HotelSlash body", async () => {
    const email = await generateForwardEmail({
      hotelName: "Sample Hotel Tokyo",
      hotelPhone: "+81-3-0000-0000",
      bookingSite: "Expedia",
      reservationNumber: "73434701251484",
      guestName: "Sample Guest",
      adultCount: 2,
      childCount: 1,
      reservationConfirmationUrl: "https://www.expedia.com/trips/73434701251484",
      status: "Confirmed",
      emailType: "Reservation Confirmation",
      mealPlan: "Breakfast for 2, Free dinner for 2 per day",
      originalCurrency: "USD",
      originalAmount: 671.42,
      jpyAmount: 100817,
      exchangeRate: 150.15,
      exchangeRateDate: "2026-04-30"
    });

    expect(email.body).toContain("Hotel phone:\n+81-3-0000-0000");
    expect(email.body).toContain("Booking site:\nExpedia");
    expect(email.body).toContain("Confirmation number:\n73434701251484");
    expect(email.body).toContain("Guest name:\nSample Guest");
    expect(email.body).toContain("Guests:\n2 adults, 1 child");
    expect(email.body).toContain("Meal plan:\nBreakfast for 2, Free dinner for 2 per day");
    expect(email.body).toContain("Booking Site / Reservation Number: Expedia / 73434701251484");
    expect(email.body).not.toContain("Reservation Confirmation URL:");
    expect(email.body).not.toContain("https://www.expedia.com/trips/73434701251484");
    expect(email.body).not.toContain("Approx. JPY");
    expect(email.body).not.toContain("100817");
  });

  it("formats stay dates in English and strips stray HTML fragments from forwarded fields", async () => {
    const email = await generateForwardEmail({
      hotelName: "Holiday Inn Auckland Airport",
      bookingSite: "IHG",
      reservationNumber: "41700582",
      guestName: "Sample Guest",
      status: "Confirmed",
      emailType: "Reservation Confirmation",
      checkIn: "2026-11-09",
      checkOut: "2026-11-10",
      room: "1 King Bed</p></td></tr>",
      mealPlan: "ご滞在中のお食事場所を探す, ご滞在中のお食事場所を探す</p></td></tr><tr>",
      cancellationPolicy: "2026年11月6日 18:00までは無料でキャンセルできます。</p>"
    });

    expect(email.subject).toContain("check in Monday, November 9, 2026");
    expect(email.subject).toContain("check out Tuesday, November 10, 2026");
    expect(email.body).toContain("Check in date:\nMonday, November 9, 2026");
    expect(email.body).toContain("Check out date:\nTuesday, November 10, 2026");
    expect(email.body).toContain("Check-in: Nov 9, 2026");
    expect(email.body).toContain("Check-out: Nov 10, 2026");
    expect(email.body).not.toContain("</p>");
    expect(email.body).not.toContain("</td>");
    expect(email.body).not.toContain("</tr>");
  });

  it("extracts meal-plan lines from reservation emails", () => {
    const mealPlan = inferMealPlanFromEmailBody(
      [
        "Accommodation details",
        "Standard Room, 2 Queen Beds",
        "Breakfast for 2",
        "Free dinner for 2 per day",
        "Total price: USD 516.12"
      ].join("\n")
    );

    expect(mealPlan).toBe("Breakfast for 2, Free dinner for 2 per day");
  });
});
