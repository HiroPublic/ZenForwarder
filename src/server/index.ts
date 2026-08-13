import cookieSession from "cookie-session";
import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config, isLiveMode } from "./config";
import { buildOAuthClient, getAuthUrl, hasGmailTokens, isGmailConfigured } from "./services/gmail";
import { finishHotelSlashLoginSession, getHotelSlashLoginStatus, startHotelSlashLoginSession } from "./services/hotelslash";
import {
  acknowledgeUnavailableLowPriceProposal,
  approveForward,
  decideLowPriceProposal,
  dismissForwardAndReload,
  getSyncProgress,
  listPending,
  registerForwardInNotionOnly,
  syncReservations
} from "./workflow";
import { applyBookingSiteBackfill, applyConfirmationUrlBackfill, planBookingSiteBackfill, planConfirmationUrlBackfill } from "./services/backfill";
import { archiveRecordedReservationEmails } from "./services/archive";

const app = express();
const clientDist = path.resolve(process.cwd(), "dist/client");
const devClientRedirectUrl = resolveDevClientRedirectUrl();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(
  cookieSession({
    name: "zenforwarder",
    keys: [config.SESSION_SECRET],
    httpOnly: true,
    sameSite: "lax",
    secure: config.APP_URL.startsWith("https://")
  })
);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, liveMode: isLiveMode });
});

app.post("/api/shutdown", (_req, res) => {
  res.json({ ok: true });

  setTimeout(() => {
    const parentPid = process.ppid;
    try {
      process.kill(parentPid, "SIGTERM");
    } catch {
      // Fall through and stop this process as a last resort.
    }
    process.exit(0);
  }, 100);
});

app.get("/api/auth/status", (req, res) => {
  res.json({
    gmailConfigured: isGmailConfigured(),
    gmailAuthenticated: hasGmailTokens(req.session?.tokens),
    account: config.GMAIL_AUTH_ACCOUNT
  });
});

app.get("/api/hotelslash/status", (_req, res) => {
  res.json(getHotelSlashLoginStatus());
});

app.post("/api/hotelslash/login/start", async (_req, res, next) => {
  try {
    res.json(await startHotelSlashLoginSession());
  } catch (error) {
    next(error);
  }
});

app.post("/api/hotelslash/login/finish", async (_req, res, next) => {
  try {
    res.json(await finishHotelSlashLoginSession());
  } catch (error) {
    next(error);
  }
});

app.get("/auth/google", (_req, res) => {
  res.redirect(getAuthUrl());
});

app.get("/auth/google/callback", async (req, res, next) => {
  try {
    const code = z.string().parse(req.query.code);
    const oauth = buildOAuthClient();
    const { tokens } = await oauth.getToken(code);
    req.session = { ...(req.session ?? {}), tokens };
    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

app.post("/api/sync", async (req, res, next) => {
  try {
    const body = z
      .object({
        forceReload: z.boolean().optional(),
        reservationNumber: z.string().trim().min(1).optional()
      })
      .parse(req.body ?? {});
    const result = await syncReservations(req.session?.tokens, {
      forceReload: body.forceReload,
      reservationNumber: body.reservationNumber
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/sync/progress", (_req, res) => {
  res.json(getSyncProgress());
});

app.get("/api/pending", (_req, res) => {
  res.json({ items: listPending() });
});

app.post("/api/forward/:id/approve", async (req, res, next) => {
  try {
    const body = z.object({ editedBody: z.string().min(1) }).parse(req.body);
    const result = await approveForward(req.params.id, body.editedBody, req.session?.tokens);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/forward/:id/notion-only", async (req, res, next) => {
  try {
    const result = await registerForwardInNotionOnly(req.params.id, req.session?.tokens);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/forward/:id/dismiss-and-reload", async (req, res, next) => {
  try {
    const items = await dismissForwardAndReload(req.params.id, req.session?.tokens);
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.post("/api/proposal/:id/decision", async (req, res, next) => {
  try {
    const body = z.object({ decision: z.enum(["accepted", "unaccepted"]) }).parse(req.body);
    const result = await decideLowPriceProposal(req.params.id, body.decision, req.session?.tokens);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/proposal/:id/acknowledge-unavailable", async (req, res, next) => {
  try {
    const result = await acknowledgeUnavailableLowPriceProposal(req.params.id, req.session?.tokens);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/notion/backfill-confirmation-urls", async (req, res, next) => {
  try {
    const candidates = await planConfirmationUrlBackfill(req.session?.tokens);
    if (req.query.format === "html" || (req.accepts("html") && !req.accepts("json"))) {
      res.type("html").send(renderBackfillPage(candidates));
      return;
    }
    res.json({ dryRun: true, candidates });
  } catch (error) {
    next(error);
  }
});

app.post("/api/notion/backfill-confirmation-urls", async (req, res, next) => {
  try {
    const result = await applyConfirmationUrlBackfill(req.session?.tokens);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/notion/backfill-booking-sites", async (req, res, next) => {
  try {
    const candidates = await planBookingSiteBackfill(req.session?.tokens);
    res.json({ dryRun: true, candidates });
  } catch (error) {
    next(error);
  }
});

app.post("/api/notion/backfill-booking-sites", async (req, res, next) => {
  try {
    const result = await applyBookingSiteBackfill(req.session?.tokens);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/gmail/archive-recorded-reservations", async (req, res, next) => {
  try {
    const result = await archiveRecordedReservationEmails(req.session?.tokens);
    if (req.accepts("html") && !req.accepts("json")) {
      res.type("html").send(renderArchiveResultPage(result));
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/gmail/archive-recorded-reservations", (_req, res) => {
  res.type("html").send(`<!doctype html>
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Archive Recorded Reservations</title>
        <style>
          body { font-family: system-ui, sans-serif; margin: 32px; color: #1f2933; }
          button { min-height: 40px; border: 0; border-radius: 8px; padding: 0 16px; background: #285f55; color: white; font-weight: 700; cursor: pointer; }
        </style>
      </head>
      <body>
        <h1>Archive Recorded Reservation Emails</h1>
        <p>Notionに記録済みのGmail message idを ZenForwarder/Processed に移動します。</p>
        <form method="post" action="/api/gmail/archive-recorded-reservations">
          <button type="submit">現在の記録済みメールを移動</button>
        </form>
      </body>
    </html>`);
});

if (devClientRedirectUrl) {
  app.get("/", (req, res, next) => {
    if (!acceptsHtml(req)) {
      next();
      return;
    }
    res.redirect(devClientRedirectUrl);
  });
}

if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
}

app.use((req, res) => {
  if (devClientRedirectUrl && acceptsHtml(req)) {
    res.redirect(devClientRedirectUrl);
    return;
  }
  const indexPath = path.resolve(clientDist, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
    return;
  }
  res.status(404).send("ZenForwarder client is not built. Run npm run dev or npm run build first.");
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(500).json({ error: message });
});

function renderBackfillPage(candidates: Awaited<ReturnType<typeof planConfirmationUrlBackfill>>) {
  const rows = candidates
    .map(
      (candidate) => `<tr>
        <td>${escapeHtml(candidate.title)}</td>
        <td>${escapeHtml(candidate.reservationNumber ?? "")}</td>
        <td>${candidate.url ? `<a href="${escapeAttribute(candidate.url)}">${escapeHtml(candidate.url)}</a>` : "Not found"}</td>
        <td>${candidate.status}</td>
      </tr>`
    )
    .join("");
  const readyCount = candidates.filter((candidate) => candidate.status === "ready").length;
  return `<!doctype html>
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Reservation URL Backfill</title>
        <style>
          body { font-family: system-ui, sans-serif; margin: 32px; color: #1f2933; }
          table { border-collapse: collapse; width: 100%; margin-top: 20px; }
          th, td { border: 1px solid #d8dee4; padding: 10px; text-align: left; vertical-align: top; }
          th { background: #f3f5f7; }
          button { min-height: 40px; border: 0; border-radius: 8px; padding: 0 16px; background: #285f55; color: white; font-weight: 700; cursor: pointer; }
          button:disabled { opacity: .65; cursor: wait; }
          .status { margin-top: 14px; font-weight: 700; }
          a { color: #0969da; word-break: break-all; }
        </style>
      </head>
      <body>
        <h1>Reservation Confirmation URL Backfill</h1>
        <p>${readyCount}件のNotionページへ追記できます。</p>
        <button id="apply" ${readyCount === 0 ? "disabled" : ""}>Notionへ追記</button>
        <div class="status" id="status"></div>
        <table>
          <thead><tr><th>Page</th><th>Reservation Number</th><th>URL</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <script>
          document.getElementById("apply")?.addEventListener("click", async () => {
            const button = document.getElementById("apply");
            const status = document.getElementById("status");
            button.disabled = true;
            status.textContent = "Updating Notion...";
            const response = await fetch("/api/notion/backfill-confirmation-urls", { method: "POST" });
            const data = await response.json();
            status.textContent = response.ok ? "Updated " + data.updated + " page(s)." : (data.error || "Update failed.");
          });
        </script>
      </body>
    </html>`;
}

function renderArchiveResultPage(result: Awaited<ReturnType<typeof archiveRecordedReservationEmails>>) {
  const rows = result.results
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.title)}</td>
        <td>${escapeHtml(item.messageId ?? "")}</td>
        <td>${escapeHtml(item.status)}</td>
        <td>${escapeHtml(item.error ?? "")}</td>
      </tr>`
    )
    .join("");
  return `<!doctype html>
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Archive Result</title>
        <style>
          body { font-family: system-ui, sans-serif; margin: 32px; color: #1f2933; }
          table { border-collapse: collapse; width: 100%; margin-top: 20px; }
          th, td { border: 1px solid #d8dee4; padding: 10px; text-align: left; }
          th { background: #f3f5f7; }
        </style>
      </head>
      <body>
        <h1>Archive Result</h1>
        <p>Archived ${result.archived} message(s).</p>
        <table>
          <thead><tr><th>Page</th><th>Gmail Message ID</th><th>Status</th><th>Error</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </body>
    </html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}

function resolveDevClientRedirectUrl() {
  const isDevServer = process.env.NODE_ENV !== "production";
  if (!isDevServer) return null;
  try {
    const appUrl = new URL(config.APP_URL);
    if (appUrl.origin === "http://localhost:5173") {
      return config.APP_URL;
    }
  } catch {
    return null;
  }
  return null;
}

function acceptsHtml(req: express.Request) {
  return req.method === "GET" && Boolean(req.accepts("html"));
}

app.listen(3000, () => {
  console.log(`ZenForwarder API listening on http://localhost:3000`);
});
