import { describe, expect, it } from "vitest";
import { assertLooksLikeHotelReservation, assertSupportedHotelReservationCandidate, NonHotelReservationEmailError, type SourceEmail } from "../ai";
import type { ReservationMetadata } from "../../../shared/types";

function buildMetadata(overrides: Partial<ReservationMetadata> = {}): ReservationMetadata {
  return {
    hotelName: "Sample Hotel",
    hotelAddress: "1-1-1 Sample Street",
    hotelPhone: "+81-3-0000-0000",
    bookingSite: "Expedia",
    reservationNumber: "ABC123",
    guestName: "Sample Guest",
    adultCount: 2,
    childCount: null as never,
    reservationConfirmationUrl: "https://example.com/reservation",
    status: "Confirmed",
    emailType: "Reservation Confirmation",
    checkIn: "2026-07-21",
    checkOut: "2026-07-23",
    nights: 2,
    room: "Deluxe Room",
    mealPlan: "Breakfast Included",
    originalCurrency: "USD",
    originalAmount: 450,
    cancellationPolicy: "Free cancellation before July 20, 2026",
    notes: null as never,
    ...overrides
  };
}

describe("hotel reservation classification", () => {
  it("rejects transfer bookings that only mention a hotel as the drop-off location", () => {
    const email: SourceEmail = {
      id: "taxi-1",
      from: "noreply@taxidatum.com",
      subject: "Booking confirmation: TD265565",
      receivedAt: "2026-05-12T00:00:00.000Z",
      body: `
        This message is to confirm your reservation, one of our drivers will be waiting for you.
        Passenger(s) reservation details:
        Date: 21-Jul-2026
        Time: 14:20
        Pick up address: Ollantaytambo Train Station
        Drop off address: Hilton Garden Inn Cusco
        Phone/whatsApp: +819016678280
        Vehicle type: Sedan
      `
    };

    expect(() =>
      assertLooksLikeHotelReservation(
        email,
        buildMetadata({
          hotelName: "Hilton Garden Inn Cusco",
          checkIn: undefined,
          checkOut: undefined,
          nights: undefined,
          room: undefined,
          mealPlan: undefined,
          cancellationPolicy: undefined
        })
      )
    ).toThrow(NonHotelReservationEmailError);
  });

  it("rejects obvious transfer bookings before hotel extraction", () => {
    const email: SourceEmail = {
      id: "taxi-prefilter-1",
      from: "noreply@taxidatum.com",
      subject: "Booking confirmation: TD265565",
      receivedAt: "2026-05-12T00:00:00.000Z",
      body: `
        One of our drivers will be waiting for you.
        Fare is $35.
        Pick up address: Ollantaytambo Train Station
        Drop off address: Hilton Garden Inn Cusco
      `
    };

    expect(() => assertSupportedHotelReservationCandidate(email)).toThrow(NonHotelReservationEmailError);
  });

  it("rejects obvious restaurant bookings before hotel extraction", () => {
    const email: SourceEmail = {
      id: "restaurant-prefilter-1",
      from: "bookings@restaurant.example",
      subject: "Dinner reservation confirmed",
      receivedAt: "2026-05-12T00:00:00.000Z",
      body: `
        Restaurant reservation confirmation
        Table for 2
        Dining time: 19:30
        Tasting menu selected
      `
    };

    expect(() => assertSupportedHotelReservationCandidate(email)).toThrow(NonHotelReservationEmailError);
  });

  it("rejects obvious church bookings before hotel extraction", () => {
    const email: SourceEmail = {
      id: "church-prefilter-1",
      from: "tickets@church.example",
      subject: "Cathedral entry reservation confirmed",
      receivedAt: "2026-05-12T00:00:00.000Z",
      body: `
        Basilica reservation confirmation
        Cathedral entry at 10:00
        Chapel access included
      `
    };

    expect(() => assertSupportedHotelReservationCandidate(email)).toThrow(NonHotelReservationEmailError);
  });

  it("rejects obvious ruins bookings before hotel extraction", () => {
    const email: SourceEmail = {
      id: "ruins-prefilter-1",
      from: "tickets@heritage.example",
      subject: "Ruins visit reservation confirmed",
      receivedAt: "2026-05-12T00:00:00.000Z",
      body: `
        Archaeological site reservation
        Citadel entry at 08:00
        Heritage site ticket for 2 visitors
      `
    };

    expect(() => assertSupportedHotelReservationCandidate(email)).toThrow(NonHotelReservationEmailError);
  });

  it("rejects obvious museum bookings before hotel extraction", () => {
    const email: SourceEmail = {
      id: "museum-prefilter-1",
      from: "tickets@museum.example",
      subject: "Museum ticket reservation confirmed",
      receivedAt: "2026-05-12T00:00:00.000Z",
      body: `
        Museum reservation confirmation
        Exhibition entry ticket
        Audio guide included
      `
    };

    expect(() => assertSupportedHotelReservationCandidate(email)).toThrow(NonHotelReservationEmailError);
  });

  it("rejects obvious attraction timed-entry bookings before hotel extraction", () => {
    const email: SourceEmail = {
      id: "attraction-prefilter-1",
      from: "tickets@tower.example",
      subject: "Observation deck timed entry confirmed",
      receivedAt: "2026-05-12T00:00:00.000Z",
      body: `
        Attraction reservation confirmation
        Observation deck timed entry
        Time slot: 18:00
      `
    };

    expect(() => assertSupportedHotelReservationCandidate(email)).toThrow(NonHotelReservationEmailError);
  });

  it("rejects obvious tour or activity bookings before hotel extraction", () => {
    const email: SourceEmail = {
      id: "tour-prefilter-1",
      from: "bookings@tour.example",
      subject: "Walking tour booking confirmed",
      receivedAt: "2026-05-12T00:00:00.000Z",
      body: `
        Guided walking tour confirmation
        Day trip activity
        Meeting point: Main square
      `
    };

    expect(() => assertSupportedHotelReservationCandidate(email)).toThrow(NonHotelReservationEmailError);
  });

  it("rejects obvious performance or sports bookings before hotel extraction", () => {
    const email: SourceEmail = {
      id: "event-prefilter-1",
      from: "tickets@arena.example",
      subject: "Concert ticket confirmed",
      receivedAt: "2026-05-12T00:00:00.000Z",
      body: `
        Performance reservation
        Stadium entry
        Seat number: A12
      `
    };

    expect(() => assertSupportedHotelReservationCandidate(email)).toThrow(NonHotelReservationEmailError);
  });

  it("keeps genuine hotel reservations that include stay-specific signals", () => {
    const email: SourceEmail = {
      id: "hotel-1",
      from: "booking@example.com",
      subject: "Hotel reservation confirmed",
      receivedAt: "2026-05-12T00:00:00.000Z",
      body: `
        Hotel: Hilton Garden Inn Cusco
        Check-in: 2026-07-21
        Check-out: 2026-07-23
        Room: King Room
        Breakfast Included
        Cancellation: Free cancellation before July 20, 2026
      `
    };

    expect(() => assertLooksLikeHotelReservation(email, buildMetadata())).not.toThrow();
  });

  it("keeps forwarded hotel confirmation emails whose subject includes airport in the hotel name", () => {
    const email: SourceEmail = {
      id: "hotel-forward-1",
      from: "Sample Traveler <sender@example.com>",
      subject: "Fwd: Holiday Inn Auckland Airport のご宿泊予約が確定しました。# 41700582 ： 9 Nov 2026",
      receivedAt: "2026-08-10T05:37:08.000Z",
      body: `
        Forwarded message
        Holiday Inn Auckland Airport
        Reservation confirmed
        Confirmation number: 41700582
        Check-in: 2026-11-09
        Check-out: 2026-11-10
        Room: 1 Bedroom Suite
      `
    };

    expect(() => assertSupportedHotelReservationCandidate(email)).not.toThrow();
  });

  it("rejects restaurant bookings even when a hotel name appears nearby", () => {
    const email: SourceEmail = {
      id: "restaurant-1",
      from: "bookings@restaurant.example",
      subject: "Reservation confirmed for dinner",
      receivedAt: "2026-05-12T00:00:00.000Z",
      body: `
        Restaurant reservation confirmation
        Venue: Hilton Garden Inn Cusco Restaurant
        Table for 2
        Dining time: 19:30
        Tasting menu selected
      `
    };

    expect(() =>
      assertLooksLikeHotelReservation(
        email,
        buildMetadata({
          hotelName: "Hilton Garden Inn Cusco Restaurant",
          checkIn: undefined,
          checkOut: undefined,
          nights: undefined,
          room: undefined,
          mealPlan: undefined,
          cancellationPolicy: undefined
        })
      )
    ).toThrow(NonHotelReservationEmailError);
  });

  it("rejects church bookings", () => {
    const email: SourceEmail = {
      id: "church-1",
      from: "tickets@church.example",
      subject: "Cathedral visit reservation confirmed",
      receivedAt: "2026-05-12T00:00:00.000Z",
      body: `
        Basilica reservation confirmation
        Cathedral entry at 10:00
        Visitors: 2
        Chapel access included
      `
    };

    expect(() =>
      assertLooksLikeHotelReservation(
        email,
        buildMetadata({
          hotelName: "Cusco Cathedral",
          checkIn: undefined,
          checkOut: undefined,
          nights: undefined,
          room: undefined,
          mealPlan: undefined,
          cancellationPolicy: undefined
        })
      )
    ).toThrow(NonHotelReservationEmailError);
  });

  it("rejects museum bookings", () => {
    const email: SourceEmail = {
      id: "museum-1",
      from: "tickets@museum.example",
      subject: "Museum ticket reservation confirmed",
      receivedAt: "2026-05-12T00:00:00.000Z",
      body: `
        Museum reservation confirmation
        Exhibition: Modern Art of Cusco
        Entry ticket time: 14:00
        Audio guide included
        Visitors: 2
      `
    };

    expect(() =>
      assertLooksLikeHotelReservation(
        email,
        buildMetadata({
          hotelName: "Cusco Art Museum",
          checkIn: undefined,
          checkOut: undefined,
          nights: undefined,
          room: undefined,
          mealPlan: undefined,
          cancellationPolicy: undefined
        })
      )
    ).toThrow(NonHotelReservationEmailError);
  });

  it("rejects ruins bookings", () => {
    const email: SourceEmail = {
      id: "ruins-1",
      from: "tickets@heritage.example",
      subject: "Archaeological site reservation confirmed",
      receivedAt: "2026-05-12T00:00:00.000Z",
      body: `
        Ruins reservation confirmation
        Heritage site ticket
        Citadel entry at 08:00
        Visitors: 2
      `
    };

    expect(() =>
      assertLooksLikeHotelReservation(
        email,
        buildMetadata({
          hotelName: "Historic Citadel",
          checkIn: undefined,
          checkOut: undefined,
          nights: undefined,
          room: undefined,
          mealPlan: undefined,
          cancellationPolicy: undefined
        })
      )
    ).toThrow(NonHotelReservationEmailError);
  });
});
