import { describe, expect, it } from "vitest";
import { waitForUrl } from "../waitForUrl";

describe("waitForUrl", () => {
  it("treats HTTP 3xx as a successful startup signal", async () => {
    let now = 0;
    let attempts = 0;

    const result = await waitForUrl({
      url: "http://localhost:5173",
      timeoutMs: 1000,
      pollIntervalMs: 10,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      fetchFn: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("not ready");
        }
        return new Response(null, { status: 302 });
      }
    });

    expect(result.status).toBe(302);
    expect(result.attempts).toBe(2);
  });

  it("times out when the target never becomes available", async () => {
    let now = 0;

    await expect(
      waitForUrl({
        url: "http://localhost:5173",
        timeoutMs: 30,
        pollIntervalMs: 10,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        fetchFn: async () => {
          throw new Error("still booting");
        }
      })
    ).rejects.toThrow("Timed out waiting for http://localhost:5173 after 30ms");
  });
});
