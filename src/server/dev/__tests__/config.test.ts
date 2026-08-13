import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_OPEN_BROWSER_DELAY_MS,
  DEFAULT_DEV_APP_URL,
  DEFAULT_STARTUP_POLL_INTERVAL_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  resolveDevBrowserConfig
} from "../config";

describe("resolveDevBrowserConfig", () => {
  it("prefers APP_URL and HEALTHCHECK_URL when provided", () => {
    const config = resolveDevBrowserConfig(
      {
        APP_URL: "http://localhost:4173",
        HEALTHCHECK_URL: "http://localhost:4173/ready",
        STARTUP_TIMEOUT_MS: "5000",
        STARTUP_POLL_INTERVAL_MS: "100",
        AUTO_OPEN_BROWSER_DELAY_MS: "50"
      },
      { platform: "darwin", isTTY: true }
    );

    expect(config.appUrl).toBe("http://localhost:4173");
    expect(config.healthcheckUrl).toBe("http://localhost:4173/ready");
    expect(config.apiHealthcheckUrl).toBe("http://localhost:3000/api/health");
    expect(config.startupTimeoutMs).toBe(5000);
    expect(config.startupPollIntervalMs).toBe(100);
    expect(config.autoOpenBrowserDelayMs).toBe(50);
    expect(config.skipReason).toBeNull();
  });

  it("falls back to the Vite dev URL and default healthcheck when APP_URL is unset", () => {
    const config = resolveDevBrowserConfig({}, { platform: "darwin", isTTY: true });

    expect(config.appUrl).toBe(DEFAULT_DEV_APP_URL);
    expect(config.healthcheckUrl).toBe(DEFAULT_DEV_APP_URL);
    expect(config.apiHealthcheckUrl).toBe("http://localhost:3000/api/health");
    expect(config.startupTimeoutMs).toBe(DEFAULT_STARTUP_TIMEOUT_MS);
    expect(config.startupPollIntervalMs).toBe(DEFAULT_STARTUP_POLL_INTERVAL_MS);
    expect(config.autoOpenBrowserDelayMs).toBe(DEFAULT_AUTO_OPEN_BROWSER_DELAY_MS);
  });

  it("marks invalid URLs as a skip reason", () => {
    const config = resolveDevBrowserConfig(
      {
        APP_URL: "not a url"
      },
      { platform: "darwin", isTTY: true }
    );

    expect(config.appUrl).toBeNull();
    expect(config.skipReason).toBe("APP_URL is invalid");
  });

  it("marks invalid API healthcheck URLs as a skip reason", () => {
    const config = resolveDevBrowserConfig(
      {
        API_HEALTHCHECK_URL: "not a url"
      },
      { platform: "darwin", isTTY: true }
    );

    expect(config.apiHealthcheckUrl).toBeNull();
    expect(config.skipReason).toBe("API_HEALTHCHECK_URL is invalid");
  });

  it("skips auto open when disabled or on CI", () => {
    const disabled = resolveDevBrowserConfig(
      {
        AUTO_OPEN_BROWSER: "false"
      },
      { platform: "darwin", isTTY: true }
    );
    const ci = resolveDevBrowserConfig(
      {
        CI: "true"
      },
      { platform: "darwin", isTTY: true }
    );

    expect(disabled.skipReason).toBe("AUTO_OPEN_BROWSER=false");
    expect(ci.skipReason).toBe("CI environment");
  });
});
