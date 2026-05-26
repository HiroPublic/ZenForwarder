export const DEFAULT_DEV_APP_URL = "http://localhost:5173";
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_STARTUP_POLL_INTERVAL_MS = 250;
export const DEFAULT_AUTO_OPEN_BROWSER_DELAY_MS = 300;

export interface DevBrowserConfig {
  appUrl: string | null;
  healthcheckUrl: string | null;
  autoOpenBrowser: boolean;
  startupTimeoutMs: number;
  startupPollIntervalMs: number;
  autoOpenBrowserDelayMs: number;
  skipReason: string | null;
}

export function resolveDevBrowserConfig(
  env: NodeJS.ProcessEnv,
  options: {
    defaultAppUrl?: string;
    platform?: NodeJS.Platform;
    isTTY?: boolean;
  } = {}
): DevBrowserConfig {
  const defaultAppUrl = options.defaultAppUrl ?? DEFAULT_DEV_APP_URL;
  const platform = options.platform ?? process.platform;
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);

  const appUrl = normalizeUrl(env.APP_URL, defaultAppUrl);
  const healthcheckUrl = normalizeUrl(env.HEALTHCHECK_URL, appUrl);

  const skipReason = resolveSkipReason({
    env,
    appUrl,
    healthcheckUrl,
    platform,
    isTTY
  });

  return {
    appUrl,
    healthcheckUrl,
    autoOpenBrowser: parseBoolean(env.AUTO_OPEN_BROWSER, true),
    startupTimeoutMs: parsePositiveInteger(env.STARTUP_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS),
    startupPollIntervalMs: parsePositiveInteger(env.STARTUP_POLL_INTERVAL_MS, DEFAULT_STARTUP_POLL_INTERVAL_MS),
    autoOpenBrowserDelayMs: parsePositiveInteger(
      env.AUTO_OPEN_BROWSER_DELAY_MS,
      DEFAULT_AUTO_OPEN_BROWSER_DELAY_MS
    ),
    skipReason
  };
}

function resolveSkipReason({
  env,
  appUrl,
  healthcheckUrl,
  platform,
  isTTY
}: {
  env: NodeJS.ProcessEnv;
  appUrl: string | null;
  healthcheckUrl: string | null;
  platform: NodeJS.Platform;
  isTTY: boolean;
}) {
  if (!parseBoolean(env.AUTO_OPEN_BROWSER, true)) {
    return "AUTO_OPEN_BROWSER=false";
  }

  if (parseBoolean(env.CI, false)) {
    return "CI environment";
  }

  if (!appUrl) {
    return "APP_URL is invalid";
  }

  if (!healthcheckUrl) {
    return "HEALTHCHECK_URL is invalid";
  }

  if (parseBoolean(env.HEADLESS, false)) {
    return "headless environment";
  }

  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return "headless environment";
  }

  if (!isTTY && platform !== "darwin" && platform !== "win32") {
    return "headless environment";
  }

  return null;
}

function normalizeUrl(value: string | undefined, fallback: string | null) {
  const candidate = value?.trim() || fallback;
  if (!candidate) {
    return null;
  }

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function parseBoolean(value: string | undefined, defaultValue: boolean) {
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parsePositiveInteger(value: string | undefined, defaultValue: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
