import { openBrowser } from "./openBrowser";
import type { DevBrowserConfig } from "./config";
import { waitForUrl } from "./waitForUrl";

export function createAutoOpenBrowserRunner(
  dependencies: {
    waitForUrlFn?: typeof waitForUrl;
    openBrowserFn?: typeof openBrowser;
    sleep?: (ms: number) => Promise<void>;
    log?: (message: string) => void;
    warn?: (message: string) => void;
  } = {}
) {
  const waitForUrlFn = dependencies.waitForUrlFn ?? waitForUrl;
  const openBrowserFn = dependencies.openBrowserFn ?? openBrowser;
  const sleep = dependencies.sleep ?? defaultSleep;
  const log = dependencies.log ?? console.log;
  const warn = dependencies.warn ?? console.warn;
  let hasOpened = false;

  return async function autoOpenBrowser(config: DevBrowserConfig) {
    log(`[dev:auto-open] resolved appUrl=${config.appUrl ?? "unavailable"}`);
    log(`[dev:auto-open] resolved healthcheckUrl=${config.healthcheckUrl ?? "unavailable"}`);

    if (config.skipReason) {
      log(`[dev:auto-open] skipped: ${config.skipReason}`);
      return { opened: false, reason: config.skipReason };
    }

    if (hasOpened) {
      log("[dev:auto-open] skipped: browser already opened for this dev session");
      return { opened: false, reason: "already-opened" };
    }

    if (!config.appUrl || !config.healthcheckUrl) {
      log("[dev:auto-open] skipped: URL not available");
      return { opened: false, reason: "url-unavailable" };
    }

    log("[dev:auto-open] waiting for frontend startup");

    try {
      const result = await waitForUrlFn({
        url: config.healthcheckUrl,
        timeoutMs: config.startupTimeoutMs,
        pollIntervalMs: config.startupPollIntervalMs
      });
      log(
        `[dev:auto-open] startup wait succeeded: status=${result.status} elapsedMs=${result.elapsedMs} attempts=${result.attempts}`
      );
    } catch (error) {
      warn(
        `[dev:auto-open] startup wait failed: ${error instanceof Error ? error.message : String(error)}`
      );
      warn(`[dev:auto-open] open manually if needed: ${config.appUrl}`);
      return { opened: false, reason: "startup-timeout" };
    }

    if (config.autoOpenBrowserDelayMs > 0) {
      await sleep(config.autoOpenBrowserDelayMs);
    }

    try {
      await openBrowserFn(config.appUrl);
      hasOpened = true;
      log("[dev:auto-open] browser launch succeeded");
      return { opened: true, reason: null };
    } catch (error) {
      warn(
        `[dev:auto-open] browser launch failed: ${error instanceof Error ? error.message : String(error)}`
      );
      warn(`[dev:auto-open] open manually if needed: ${config.appUrl}`);
      return { opened: false, reason: "browser-launch-failed" };
    }
  };
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
