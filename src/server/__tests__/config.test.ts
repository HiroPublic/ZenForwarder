import { describe, expect, it } from "vitest";
import { parseConfig } from "../config";

describe("parseConfig", () => {
  it("falls back to safe defaults when optional .env values are blank strings", () => {
    const config = parseConfig({
      APP_URL: "",
      SESSION_SECRET: "",
      GOOGLE_REDIRECT_URI: "",
      GMAIL_AUTH_ACCOUNT: "",
      FORWARD_FROM_EMAIL: "",
      OPENAI_MODEL: "",
      TRIPIT_FORWARD_EMAIL: "",
      HOTELSLASH_FORWARD_EMAIL: "",
      EXCHANGE_RATE_PROVIDER: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      OPENAI_API_KEY: "",
      NOTION_API_KEY: "",
      NOTION_HOTEL_RESERVATION_DATABASE_ID: "",
      EXCHANGE_RATE_API_KEY: ""
    });

    expect(config.APP_URL).toBe("http://localhost:5173");
    expect(config.SESSION_SECRET).toBe("dev-session-secret-change-me");
    expect(config.GMAIL_AUTH_ACCOUNT).toBe("user@example.com");
    expect(config.FORWARD_FROM_EMAIL).toBe("sender@example.com");
    expect(config.TRIPIT_FORWARD_EMAIL).toBe("plans@tripit.com");
    expect(config.HOTELSLASH_FORWARD_EMAIL).toBe("save@hotelslash.com");
    expect(config.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(config.OPENAI_API_KEY).toBeUndefined();
  });

  it("still rejects non-empty invalid forwarding email values", () => {
    expect(() =>
      parseConfig({
        TRIPIT_FORWARD_EMAIL: "not-an-email"
      })
    ).toThrow();
  });
});
