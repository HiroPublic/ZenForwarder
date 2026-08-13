import { describe, expect, it, vi } from "vitest";
import { createAutoOpenBrowserRunner } from "../autoOpenBrowser";
import { resolveDevBrowserConfig } from "../config";

describe("createAutoOpenBrowserRunner", () => {
  it("skips before waiting when auto open is disabled", async () => {
    const waitForUrlFn = vi.fn();
    const openBrowserFn = vi.fn();
    const autoOpenBrowser = createAutoOpenBrowserRunner({
      waitForUrlFn,
      openBrowserFn,
      sleep: async () => {}
    });

    const result = await autoOpenBrowser(
      resolveDevBrowserConfig(
        {
          AUTO_OPEN_BROWSER: "false"
        },
        { platform: "darwin", isTTY: true }
      )
    );

    expect(result).toEqual({ opened: false, reason: "AUTO_OPEN_BROWSER=false" });
    expect(waitForUrlFn).not.toHaveBeenCalled();
    expect(openBrowserFn).not.toHaveBeenCalled();
  });

  it("opens the browser only once across repeated calls", async () => {
    const waitForUrlFn = vi.fn().mockResolvedValue({ status: 200, elapsedMs: 100, attempts: 1 });
    const openBrowserFn = vi.fn().mockResolvedValue(undefined);
    const autoOpenBrowser = createAutoOpenBrowserRunner({
      waitForUrlFn,
      openBrowserFn,
      sleep: async () => {}
    });
    const config = resolveDevBrowserConfig({}, { platform: "darwin", isTTY: true });

    const first = await autoOpenBrowser(config);
    const second = await autoOpenBrowser(config);

    expect(first).toEqual({ opened: true, reason: null });
    expect(second).toEqual({ opened: false, reason: "already-opened" });
    expect(waitForUrlFn).toHaveBeenCalledTimes(2);
    expect(openBrowserFn).toHaveBeenCalledTimes(1);
  });
});
