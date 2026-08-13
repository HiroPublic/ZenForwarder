import { describe, expect, it } from "vitest";
import { HotelSlashRatesUnavailableError, parseTopHotelSlashOffer, shouldAbortHotelSlashPolling } from "../hotelslash";

describe("parseTopHotelSlashOffer", () => {
  it("extracts the top HotelSlash proposal from rendered page text", () => {
    const text = `
      Hello, Traveler!
      Your HotelSlash Rates
      Rebook your 4-night stay at a lower rate:
      Suite (2 Bed)
      Breakfast Included
      Fully Refundable
      JPY 125,559
      Save JPY38,989
      PAY DEPOSIT
      Photos, Amenities, Description
      Other deals for Jun 7 - Jun 11 at this hotel:
      Suite (1 Bed)
      JPY 125,559
    `;

    expect(parseTopHotelSlashOffer(text, "https://hotelslash.com/rates")).toEqual({
      pageUrl: "https://hotelslash.com/rates",
      priceCurrency: "JPY",
      priceAmount: 125559,
      roomType: "Suite (2 Bed)",
      conditions: ["Breakfast Included", "Fully Refundable", "Pay Deposit"],
      currentReservation: undefined
    });
  });

  it("extracts local-currency proposals without relying on JPY", () => {
    const text = `
      Your HotelSlash Rates
      Rebook your 2-night stay at a lower rate:
      Deluxe Cave Room
      Breakfast included
      Fully Refundable
      TRY 12.345,67
      PAY DEPOSIT
      Photos, Amenities, Description
    `;

    expect(parseTopHotelSlashOffer(text, "https://hotelslash.com/rates")).toEqual({
      pageUrl: "https://hotelslash.com/rates",
      priceCurrency: "TRY",
      priceAmount: 12345.67,
      roomType: "Deluxe Cave Room",
      conditions: ["Breakfast Included", "Fully Refundable", "Pay Deposit"],
      currentReservation: undefined
    });
  });

  it("ignores SlashCash and extracts current reservation details", () => {
    const text = `
      Here are the details of your current reservation.
      Jun 7 - Jun 11, 2 adults
      Suite
      Room Only
      Cancel before May 17, 2026
      $1,048
      4 nights
      PREPAID
      at the
      Aydinli Cave House
      Your HotelSlash Rates
      Rebook your 4-night stay at a lower rate:
      Suite (1 Bed)
      Breakfast Included
      Fully Refundable
      $799
      Save $248
      PAY DEPOSIT
      Earn $7.99 SlashCash
      Photos, Amenities, Description
    `;

    expect(parseTopHotelSlashOffer(text, "https://hotelslash.com/rates")).toEqual({
      pageUrl: "https://hotelslash.com/rates",
      priceCurrency: "USD",
      priceAmount: 799,
      roomType: "Suite (1 Bed)",
      conditions: ["Breakfast Included", "Fully Refundable", "Pay Deposit"],
      currentReservation: {
        priceCurrency: "USD",
        priceAmount: 1048,
        roomType: "Suite",
        conditions: ["Room Only"],
        cancellationDeadline: "Cancel before May 17, 2026",
        paymentTerms: "PREPAID"
      }
    });
  });

  it("extracts compact currency-code prices from HotelSlash", () => {
    const text = `
      Your HotelSlash Rates
      Rebook your 4-night stay at a lower rate:
      Suite (1 Bed)
      Breakfast Included
      Fully Refundable
      JPY125,559
      Save JPY38,989
      PAY DEPOSIT
      Earn $7.99 SlashCash
      Photos Amenities Description
    `;

    expect(parseTopHotelSlashOffer(text, "https://hotelslash.com/rates")).toMatchObject({
      priceCurrency: "JPY",
      priceAmount: 125559,
      roomType: "Suite (1 Bed)"
    });
  });

  it("extracts offers when HotelSlash collapses the header and offer into one line", () => {
    const text = `
      HotelSlash Tell us what you think! About HotelSlash Privacy Policy Terms and Conditions Sign out USD $ CAD $ EUR € NZD $ $0.00 SlashCash Hello, Traveler! We found you a better price! Your HotelSlash Rates Rebook your 4-night stay at a lower rate: Suite (2 Bed) Breakfast Included Fully Refundable JPY 125,559 Save JPY38,989 PAY DEPOSIT Photos, Amenities, Description Other deals for Jun 7 - Jun 11 at this hotel:
    `;

    expect(parseTopHotelSlashOffer(text, "https://hotelslash.com/rates")).toEqual({
      pageUrl: "https://hotelslash.com/rates",
      priceCurrency: "JPY",
      priceAmount: 125559,
      roomType: "Suite (2 Bed)",
      conditions: ["Breakfast Included", "Fully Refundable", "Pay Deposit"],
      currentReservation: undefined
    });
  });

  it("extracts the offer when marketing copy and current reservation appear before HotelSlash Rates", () => {
    const text = `
      HotelSlash Tell us what you think! About HotelSlash Privacy Policy Terms and Conditions Sign out USD $ CAD $ EUR € ------ AED د.إ.‏ AUD $ BRL R$ CHF Fr CNY ¥ DKK kr. GBP £ INR ₹ JPY ￥ MXN $ NZD $ SEK kr SGD $ THB THB NZD $ $0.00 SlashCash Hello, Traveler! We found you a better price! Rates can change at any time, so don't delay! Keep in mind that HotelSlash displays rates for the duration of your entire stay, including taxes and fees upfront, unlike many other websites that often hide them until you get to the final checkout page. That's just one way that HotelSlash tries to be one of the "good guys" in the travel industry! Got it! Here are the details of your current reservation. Oct 28 - Nov 2, 2 adults Superior Room, Queen Bed Room Only Cancel before Oct 27, 2026 NZD2,185 5 nights PAY LATER at the Copthorne Hotel and Apartments Queenstown Lakeview Hotel Overview Location Amenities Address 88 Frankton Road Queenstown, 9300 New Zealand Your HotelSlash Rates Change Rebook your 5-night stay at a lower rate: Superior Room with 2 Queen Beds and Lake View Room Only Fully Refundable NZD1,907 Save NZD278 PAY DEPOSIT Earn $11.33 SlashCash Photos Amenities Description
    `;

    expect(parseTopHotelSlashOffer(text, "https://hotelslash.com/rates")).toEqual({
      pageUrl: "https://hotelslash.com/rates",
      priceCurrency: "NZD",
      priceAmount: 1907,
      roomType: "Superior Room with 2 Queen Beds and Lake View",
      conditions: ["Room Only", "Fully Refundable", "Pay Deposit"],
      currentReservation: {
        priceCurrency: "NZD",
        priceAmount: 2185,
        roomType: "Superior Room, Queen Bed",
        conditions: ["Room Only"],
        cancellationDeadline: "Cancel before Oct 27, 2026",
        paymentTerms: "PAY LATER"
      }
    });
  });

  it("identifies HotelSlash rates-not-found pages as an expired offer instead of a parse failure", () => {
    const text = `
      HotelSlash Tell us what you think! About HotelSlash Privacy Policy Terms and Conditions Sign out Hello, Traveler!
      Hotel rates can change quickly at any time. Unfortunately, the rates we found are no longer available!
      No worries, we'll continue to look for better deals and we'll be in touch if we find further savings.
    `;

    const error = new HotelSlashRatesUnavailableError({
      requestedUrl: "https://www.hotelslash.com/offer/a0a58ab3-3227-4ec0-95bf-260326dddd07",
      finalUrl:
        "https://www.hotelslash.com/Offer/RatesNotFound?identifier=a0a58ab3-3227-4ec0-95bf-260326dddd07&SessionId=%2F191%2F137134%2FD20260511T220038%2F5888fde4e59d4bd893f65535d7a37d34",
      pageTitle: "Rate Not Found | HotelSlash | Hotel Price Tracker"
    });

    expect(error.message).toMatch(
      new RegExp(
        [
          "HotelSlash says the lower rates are no longer available\\.",
          "Requested URL: https://www\\.hotelslash\\.com/offer/a0a58ab3-3227-4ec0-95bf-260326dddd07",
          "Final URL: https://www\\.hotelslash\\.com/Offer/RatesNotFound\\?identifier=a0a58ab3-3227-4ec0-95bf-260326dddd07",
          "Title: Rate Not Found \\| HotelSlash \\| Hotel Price Tracker",
          "No proposal was created because the offer expired before it could be reviewed\\."
        ].join(".*")
      )
    );
    expect(() => parseTopHotelSlashOffer(text, "https://hotelslash.com/rates")).toThrow(
      "HotelSlash price could not be extracted from the rendered rates page."
    );
  });

  it("identifies stable marketing pages as safe to abort early", () => {
    expect(
      shouldAbortHotelSlashPolling(
        "About Gift Cards Blog Your Trips Hello, Traveler Settings $0.00 SlashCash Where would you like to stay? STEP 1 Choose where you'd like to stay. STEP 2 Our algorithm finds you the best deal possible."
      )
    ).toBe(true);
  });

  it("does not abort early when offer text is already visible", () => {
    expect(
      shouldAbortHotelSlashPolling("Hello, Traveler! We found you a better price! Your HotelSlash Rates Rebook your 4-night stay at a lower rate:")
    ).toBe(false);
  });
});
