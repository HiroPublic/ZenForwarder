export interface WaitForUrlOptions {
  url: string;
  timeoutMs: number;
  pollIntervalMs: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface WaitForUrlResult {
  status: number;
  elapsedMs: number;
  attempts: number;
}

export async function waitForUrl(options: WaitForUrlOptions): Promise<WaitForUrlResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + options.timeoutMs;
  let attempts = 0;

  while (true) {
    attempts += 1;

    try {
      const response = await fetchFn(options.url, {
        method: "GET",
        redirect: "manual"
      });

      if (response.status >= 200 && response.status < 400) {
        return {
          status: response.status,
          elapsedMs: now() - startedAt,
          attempts
        };
      }
    } catch {
      // Keep polling until timeout.
    }

    if (now() >= deadline) {
      throw new Error(`Timed out waiting for ${options.url} after ${options.timeoutMs}ms`);
    }

    await sleep(options.pollIntervalMs);
  }
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
