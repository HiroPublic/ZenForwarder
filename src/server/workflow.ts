import type { ForwardResult, NotionOnlyResult, PendingForward, SyncError, SyncProgress, SyncReservationsResult } from "../shared/types";
import { extractReservationJson, generateForwardEmail, NonHotelReservationEmailError, type SourceEmail } from "./services/ai";
import { audit } from "./services/audit";
import { normalizeReservationDates } from "./services/date-normalization";
import { convertToJpy } from "./services/exchange";
import {
  ensureSendAsAlias,
  extractLowerRateButtonUrl,
  fetchCandidateEmails,
  isLowerRateEmail,
  markProcessed,
  searchEmailsByReservationNumber,
  sendForward
} from "./services/gmail";
import { extractTopHotelSlashOffer, isHotelSlashRatesUnavailableError } from "./services/hotelslash";
import { extractReservationConfirmationUrl } from "./services/links";
import {
  createLowPriceProposalRecord,
  findNonHotelSlashBookingSiteForCheckIn,
  createReservationRecord,
  hasCheckedHotelArrangementForCheckIn,
  ensureReservationDatabaseSchema,
  findLatestProposalByNameAndCheckIn,
  findRelatedReservation,
  updateReservationEmailType
} from "./services/notion";

const pending = new Map<string, PendingForward>();
const excludedMessageIds = new Set<string>();
const processedMessageIds = new Set<string>();
const excludedReservationKeys = new Set<string>();
const processedReservationKeys = new Set<string>();
let syncProgress: SyncProgress = createIdleSyncProgress();

interface SyncReservationOptions {
  forceReload?: boolean;
  reservationNumber?: string;
}

export function getSyncProgress() {
  return syncProgress;
}

export async function syncReservations(tokens?: unknown, options: SyncReservationOptions = {}): Promise<SyncReservationsResult> {
  const syncStartedAt = Date.now();
  const forceReload = options.forceReload === true;
  const reservationNumber = options.reservationNumber?.trim();
  const bypassDuplicateGuards = forceReload || Boolean(reservationNumber);
  startSyncProgress();
  try {
    updateSyncProgress({
      stage: reservationNumber
        ? `予約番号 ${reservationNumber} のメールを検索しています`
        : forceReload
          ? "確認用の再取込で Gmail 候補メールを取得しています"
          : "Gmail候補メールを取得しています"
    });
    const emails = reservationNumber
      ? await searchEmailsByReservationNumber(tokens, reservationNumber, {
          includeProcessed: true,
          inboxOnly: false,
          lookbackDays: 365,
          excludeUserAuthored: true,
          maxResults: 20
        })
      : await fetchCandidateEmails(tokens, { includeProcessed: forceReload });
    updateSyncProgress({
      totalCandidates: emails.length,
      stage: emails.length
        ? reservationNumber
          ? `予約番号 ${reservationNumber} の候補メールを処理します`
          : forceReload
            ? "確認用の再取込を開始します"
            : "候補メールの処理を開始します"
        : "候補メールはありません"
    });
    console.info(
      `[sync] fetched ${emails.length} candidate emails`,
      JSON.stringify(
        emails.map((email) => ({
          id: email.id,
          from: email.from,
          subject: email.subject,
          receivedAt: email.receivedAt,
          lowerRate: isLowerRateEmail(email)
        }))
      )
    );
    refreshPendingForwardCandidates(emails);
    const errors: SyncError[] = [];

    for (const [index, email] of emails.entries()) {
      updateSyncProgress({
        currentIndex: index + 1,
        currentEmailId: email.id,
        currentEmailSubject: email.subject,
        currentEmailFrom: email.from,
        stage: isLowerRateEmail(email) ? "HotelSlash候補メールを分類しています" : "予約メールを分類しています",
        currentStepLabel: "候補メールを分類しています",
        currentStepIndex: 1,
        currentStepTotal: isLowerRateEmail(email) ? 6 : 5
      });
      if (!bypassDuplicateGuards && processedMessageIds.has(email.id)) {
        incrementSyncProgressCompletion("処理済みメールをスキップしました");
        emitSyncAuditLog(email, [audit("sync.skip", "info", "Skipped because the Gmail message was already processed.")], "skip:processed");
        continue;
      }
      if (!bypassDuplicateGuards && excludedMessageIds.has(email.id)) {
        incrementSyncProgressCompletion("除外済みメールをスキップしました");
        emitSyncAuditLog(email, [audit("sync.skip", "info", "Skipped because the Gmail message was manually excluded.")], "skip:excluded");
        continue;
      }
      if (!bypassDuplicateGuards && [...pending.values()].some((item) => item.gmailMessageId === email.id)) {
        incrementSyncProgressCompletion("既存の承認待ちメールをスキップしました");
        emitSyncAuditLog(email, [audit("sync.skip", "info", "Skipped because the Gmail message is already pending review.")], "skip:already-pending");
        continue;
      }
      const emailStartedAt = Date.now();
      const log = [audit("gmail.fetch", "ok", "Fetched candidate Gmail message", { messageId: email.id })];
      try {
        if (isLowerRateEmail(email)) {
          const lowPriceItem = await buildLowPriceProposal(email, log);
          pending.set(lowPriceItem.id, lowPriceItem);
          emitSyncAuditLog(email, lowPriceItem.auditLog, "pending:low-price");
          incrementSyncProgressCompletion("HotelSlash提案を承認待ちに追加しました");
          console.info(`[sync] low-price email ${email.id} processed in ${Date.now() - emailStartedAt}ms`);
          continue;
        }
        setSyncSubstep("AIで予約情報を抽出しています", 2, 5);
        const extractedMetadata = await measure(log, "ai.extract", "Extracted internal reservation JSON", () => extractReservationJson(email));
        const metadata = normalizeReservationDates(extractedMetadata, email.receivedAt);
        metadata.reservationConfirmationUrl ??= extractReservationConfirmationUrl(email.body);
        const reservationKey = getReservationKeyFromMetadata(metadata);
        if (!bypassDuplicateGuards && reservationKey && (processedReservationKeys.has(reservationKey) || excludedReservationKeys.has(reservationKey))) {
          log.push(audit("sync.skip", "info", "Skipped because the reservation key was already processed or excluded.", { reservationKey }));
          emitSyncAuditLog(email, log, "skip:reservation-key-blocked");
          incrementSyncProgressCompletion("処理済み予約をスキップしました");
          continue;
        }
        if (
          reservationKey &&
          [...pending.values()].some(
            (item) =>
              item.kind !== "lowPriceProposal" &&
              item.kind !== "unavailableLowPriceProposal" &&
              getReservationKeyFromMetadata(item.metadata) === reservationKey
          )
        ) {
          log.push(audit("sync.skip", "info", "Skipped because the same reservation is already pending review.", { reservationKey }));
          emitSyncAuditLog(email, log, "skip:duplicate-reservation");
          incrementSyncProgressCompletion("重複予約をスキップしました");
          continue;
        }
        setSyncSubstep("為替を確認しています", 3, 5);
        const quote = await measure(log, "exchange.convert", "Converted original amount to JPY", () =>
          convertToJpy(metadata.originalCurrency, metadata.originalAmount)
        );
        if (quote) {
          metadata.exchangeRate = quote.rate;
          metadata.exchangeRateDate = quote.date;
          metadata.jpyAmount = quote.jpyAmount;
        }
        setSyncSubstep("関連予約をNotionで確認しています", 4, 5);
        const relatedReservationId = await measure(log, "notion.relate", "Checked for a related reservation", () => findRelatedReservation(metadata));
        if (relatedReservationId) {
          metadata.relatedReservationId = relatedReservationId;
        }
        setSyncSubstep("TripIt / HotelSlash 向け英語本文を生成しています", 5, 5);
        const generated = await measure(log, "ai.generate", "Generated redacted English forward body", () => generateForwardEmail(metadata));
        const item: PendingForward = {
          id: crypto.randomUUID(),
          gmailMessageId: email.id,
          gmailUrl: `https://mail.google.com/mail/u/0/#inbox/${email.id}`,
          from: email.from,
          receivedAt: email.receivedAt,
          subject: email.subject,
          metadata,
          generatedSubject: generated.subject,
          generatedBody: generated.body,
          internalJson: metadata,
          state: "pending",
          auditLog: log
        };
        pending.set(item.id, item);
        emitSyncAuditLog(email, item.auditLog, "pending:reservation");
        incrementSyncProgressCompletion("承認待ちメールを追加しました");
        console.info(`[sync] reservation email ${email.id} processed in ${Date.now() - emailStartedAt}ms`);
      } catch (error) {
        if (error instanceof NonHotelReservationEmailError) {
          log.push(audit("sync.skip", "info", "Skipped because the email was classified as a non-hotel reservation.", { error: error.message }));
          emitSyncAuditLog(email, log, "skip:non-hotel");
          incrementSyncProgressCompletion("ホテル予約ではないメールをスキップしました");
          console.info(`[sync] skipped non-hotel email ${email.id} in ${Date.now() - emailStartedAt}ms`);
          continue;
        }
        if (isLowerRateEmail(email) && isHotelSlashRatesUnavailableError(error)) {
          const unavailableItem = await buildUnavailableLowPriceProposal(email, log, error);
          pending.set(unavailableItem.id, unavailableItem);
          emitSyncAuditLog(email, unavailableItem.auditLog, "pending:unavailable-low-price");
          incrementSyncProgressCompletion("失効したHotelSlash提案を承認待ちに追加しました");
          console.info(`[sync] unavailable low-price email ${email.id} processed in ${Date.now() - emailStartedAt}ms`);
          continue;
        }
        log.push(
          audit("sync.error", "error", "Failed while building a pending review item.", {
            error: error instanceof Error ? error.message : "Unexpected error"
          })
        );
        errors.push({
          gmailMessageId: email.id,
          from: email.from,
          receivedAt: email.receivedAt,
          subject: email.subject,
          message: error instanceof Error ? error.message : "Unexpected error"
        });
        emitSyncAuditLog(email, log, "error");
        incrementSyncProgressFailure("メール処理でエラーが発生しました");
        console.info(`[sync] failed email ${email.id} after ${Date.now() - emailStartedAt}ms`);
      }
    }

    console.info(`[sync] completed ${emails.length} candidate emails in ${Date.now() - syncStartedAt}ms`);
    completeSyncProgress(errors.length ? "同期は完了しました（一部エラーあり）" : "同期が完了しました");
    return {
      items: [...pending.values()].filter((item) => item.state === "pending"),
      errors
    };
  } catch (error) {
    failSyncProgress(error instanceof Error ? error.message : "同期に失敗しました");
    throw error;
  }
}

export function listPending() {
  return dedupePending();
}

export async function dismissForwardAndReload(id: string, tokens?: unknown): Promise<PendingForward[]> {
  const item = pending.get(id);
  if (!item) throw new Error("Pending forward was not found");
  excludedMessageIds.add(item.gmailMessageId);
  const reservationKey = getReservationKeyFromMetadata(item.metadata);
  if (reservationKey) excludedReservationKeys.add(reservationKey);
  pending.delete(id);
  return (await syncReservations(tokens)).items;
}

export async function approveForward(id: string, editedBody: string, tokens?: unknown): Promise<ForwardResult> {
  const item = pending.get(id);
  if (!item) throw new Error("Pending forward was not found");
  item.auditLog.push(audit("approval", "ok", "User approved generated body"));
  await ensureReservationDatabaseSchema();
  item.auditLog.push(audit("notion.schema", "ok", "Verified Notion reservation history database schema"));
  await ensureSendAsAlias(tokens);
  item.auditLog.push(audit("gmail.alias", "ok", "Verified Gmail send-as alias"));
  await sendForward(tokens, item, editedBody);
  const now = new Date().toISOString();
  item.auditLog.push(audit("gmail.send", "ok", "Forwarded email to TripIt and HotelSlash"));
  const hotelArrangement = await hasCheckedHotelArrangementForCheckIn(item.metadata.checkIn);
  if (hotelArrangement) {
    item.auditLog.push(audit("notion.match", "ok", "Inherited checked Hotel Arrangement from same Check-in"));
  }
  const notionPageId = await createReservationRecord(item, { tripIt: now, hotelSlash: now, hotelArrangement });
  item.auditLog.push(audit("notion.create", "ok", "Created Notion reservation history record", { notionPageId }));
  const processedMessageIdsForReservation = await markRelatedReservationEmailsProcessed(tokens, item);
  item.auditLog.push(
    audit("gmail.label", "ok", "Applied processed Gmail label to the approved reservation emails", {
      messageIds: processedMessageIdsForReservation
    })
  );
  for (const messageId of processedMessageIdsForReservation) {
    processedMessageIds.add(messageId);
  }
  const reservationKey = getReservationKeyFromMetadata(item.metadata);
  if (reservationKey) processedReservationKeys.add(reservationKey);
  item.state = "processed";
  for (const messageId of processedMessageIdsForReservation) {
    removePendingByMessageId(messageId);
  }
  if (reservationKey) removePendingByReservationKey(reservationKey);
  return { item, tripItSentAt: now, hotelSlashSentAt: now, notionPageId };
}

export async function registerForwardInNotionOnly(id: string, tokens?: unknown): Promise<NotionOnlyResult> {
  const item = pending.get(id);
  if (!item) throw new Error("Pending forward was not found");
  if (item.kind === "lowPriceProposal" || item.kind === "unavailableLowPriceProposal") throw new Error("Low price proposals cannot be registered with this action.");
  item.auditLog.push(audit("approval", "ok", "User registered generated body in Notion without forwarding"));
  await ensureReservationDatabaseSchema();
  item.auditLog.push(audit("notion.schema", "ok", "Verified Notion reservation history database schema"));
  const hotelArrangement = await hasCheckedHotelArrangementForCheckIn(item.metadata.checkIn);
  if (hotelArrangement) {
    item.auditLog.push(audit("notion.match", "ok", "Inherited checked Hotel Arrangement from same Check-in"));
  }
  const notionPageId = await createReservationRecord(item, { hotelArrangement });
  item.auditLog.push(audit("notion.create", "ok", "Created Notion reservation history record without forwarding", { notionPageId }));
  await markProcessed(tokens, item.gmailMessageId);
  item.auditLog.push(audit("gmail.label", "ok", "Applied processed Gmail label"));
  processedMessageIds.add(item.gmailMessageId);
  const reservationKey = getReservationKeyFromMetadata(item.metadata);
  if (reservationKey) processedReservationKeys.add(reservationKey);
  item.state = "processed";
  removePendingByMessageId(item.gmailMessageId);
  if (reservationKey) removePendingByReservationKey(reservationKey);
  return { item, notionPageId, hotelArrangement };
}

export async function acknowledgeUnavailableLowPriceProposal(
  id: string,
  tokens?: unknown
): Promise<{ item: PendingForward }> {
  const item = pending.get(id);
  if (!item) throw new Error("Pending low price proposal notice was not found");
  if (item.kind !== "unavailableLowPriceProposal" || !item.unavailableProposal) {
    throw new Error("Selected item is not an unavailable low price proposal.");
  }
  item.auditLog.push(audit("approval", "ok", "User acknowledged unavailable HotelSlash proposal"));
  await markProcessed(tokens, item.gmailMessageId);
  item.auditLog.push(audit("gmail.label", "ok", "Applied processed Gmail label"));
  processedMessageIds.add(item.gmailMessageId);
  item.state = "processed";
  removePendingByMessageId(item.gmailMessageId);
  return { item };
}

export async function decideLowPriceProposal(
  id: string,
  decision: "accepted" | "unaccepted",
  tokens?: unknown
): Promise<{ item: PendingForward; notionPageId?: string }> {
  const item = pending.get(id);
  if (!item) throw new Error("Pending low price proposal was not found");
  if (item.kind !== "lowPriceProposal" || !item.proposal?.notionPageId) {
    throw new Error("Selected item is not a low price proposal.");
  }
  const emailType = decision === "accepted" ? "Proposal accepted" : "Proposal Unaccepted";
  item.auditLog.push(audit("approval", "ok", `User marked low price proposal as ${emailType}`));
  const hotelArrangement = await hasCheckedHotelArrangementForCheckIn(item.metadata.checkIn);
  if (hotelArrangement) {
    item.auditLog.push(audit("notion.match", "ok", "Inherited checked Hotel Arrangement from same Check-in"));
  }
  await updateReservationEmailType(item.proposal.notionPageId, emailType, { hotelArrangement });
  item.proposal.hotelArrangement = hotelArrangement;
  item.auditLog.push(audit("notion.update", "ok", "Updated proposal Email Type", { emailType, hotelArrangement }));
  await markProcessed(tokens, item.gmailMessageId);
  item.auditLog.push(audit("gmail.label", "ok", "Applied processed Gmail label"));
  processedMessageIds.add(item.gmailMessageId);
  item.metadata.emailType = emailType;
  item.state = "processed";
  removePendingByMessageId(item.gmailMessageId);
  return { item, notionPageId: item.proposal.notionPageId };
}

function dedupePending() {
  const seen = new Set<string>();
  const seenReservationKeys = new Set<string>();
  for (const [id, item] of pending.entries()) {
    const reservationKey = getReservationKeyFromMetadata(item.metadata);
    if (item.state !== "pending" || processedMessageIds.has(item.gmailMessageId) || excludedMessageIds.has(item.gmailMessageId)) {
      pending.delete(id);
      continue;
    }
    if (reservationKey && (processedReservationKeys.has(reservationKey) || excludedReservationKeys.has(reservationKey))) {
      pending.delete(id);
      continue;
    }
    if (seen.has(item.gmailMessageId)) {
      pending.delete(id);
      continue;
    }
    if (reservationKey && item.kind !== "lowPriceProposal" && item.kind !== "unavailableLowPriceProposal" && seenReservationKeys.has(reservationKey)) {
      pending.delete(id);
      continue;
    }
    seen.add(item.gmailMessageId);
    if (reservationKey && item.kind !== "lowPriceProposal" && item.kind !== "unavailableLowPriceProposal") seenReservationKeys.add(reservationKey);
  }
  return [...pending.values()].filter((item) => item.state === "pending");
}

function refreshPendingForwardCandidates(emails: SourceEmail[]) {
  const currentMessageIds = new Set(emails.map((email) => email.id));
  for (const [id, item] of pending.entries()) {
    if (item.kind === "lowPriceProposal" || item.kind === "unavailableLowPriceProposal") continue;
    if (currentMessageIds.has(item.gmailMessageId)) {
      pending.delete(id);
    }
  }
}

function removePendingByMessageId(messageId: string) {
  for (const [id, item] of pending.entries()) {
    if (item.gmailMessageId === messageId) {
      pending.delete(id);
    }
  }
}

function removePendingByReservationKey(reservationKey: string) {
  for (const [id, item] of pending.entries()) {
    if (getReservationKeyFromMetadata(item.metadata) === reservationKey) {
      pending.delete(id);
    }
  }
}

function getReservationKeyFromMetadata(metadata: PendingForward["metadata"]) {
  const reservationNumber = cleanKeyPart(metadata.reservationNumber);
  if (reservationNumber) return `reservation:${reservationNumber}`;
  const hotelName = cleanKeyPart(metadata.hotelName);
  const checkIn = cleanKeyPart(metadata.checkIn);
  const checkOut = cleanKeyPart(metadata.checkOut);
  if (hotelName && checkIn && checkOut) return `stay:${hotelName}:${checkIn}:${checkOut}`;
  return undefined;
}

async function markRelatedReservationEmailsProcessed(tokens: unknown, item: PendingForward) {
  const messageIds = await findRelatedReservationMessageIds(tokens, item);
  for (const messageId of messageIds) {
    await markProcessed(tokens, messageId);
  }
  return messageIds;
}

async function findRelatedReservationMessageIds(tokens: unknown, item: PendingForward) {
  const relatedMessageIds = new Set<string>([item.gmailMessageId]);
  const reservationKey = getReservationKeyFromMetadata(item.metadata);

  if (item.metadata.reservationNumber) {
    const matches = await searchEmailsByReservationNumber(tokens, item.metadata.reservationNumber);
    for (const email of matches) {
      relatedMessageIds.add(email.id);
    }
  }

  if (!reservationKey) return [...relatedMessageIds];

  const candidates = await fetchCandidateEmails(tokens, { includeProcessed: true });
  for (const email of candidates) {
    if (relatedMessageIds.has(email.id)) continue;
    try {
      const extracted = await extractReservationJson(email);
      const normalized = normalizeReservationDates(extracted, email.receivedAt);
      if (getReservationKeyFromMetadata(normalized) === reservationKey) {
        relatedMessageIds.add(email.id);
      }
    } catch {
      // Ignore unrelated or unparseable emails while collecting related reservation messages.
    }
  }

  return [...relatedMessageIds];
}

async function buildLowPriceProposal(email: SourceEmail, log: PendingForward["auditLog"]) {
  const { metadata, ratesUrl } = await extractLowPriceProposalContext(email, log);

  setSyncSubstep("HotelSlashの料金ページを解析しています", 3, 6);
  const offer = await measure(log, "hotelslash.render", "Rendered HotelSlash rates page and extracted top offer", () =>
    extractTopHotelSlashOffer(ratesUrl)
  );
  metadata.room = offer.roomType;
  metadata.originalCurrency = offer.priceCurrency;
  metadata.originalAmount = offer.priceAmount;
  if (offer.priceCurrency === "JPY") metadata.jpyAmount = offer.priceAmount;
  metadata.cancellationPolicy = offer.conditions.join(", ");

  setSyncSubstep("過去のHotelSlash提案をNotionで確認しています", 4, 6);
  const previousProposal = await measure(log, "notion.match", "Checked for the latest prior proposal with the same Name and Check-in", () =>
    findLatestProposalByNameAndCheckIn(metadata)
  );
  if (previousProposal) {
    log.push(audit("notion.match.result", "ok", "Found latest prior proposal with the same Name and Check-in", { pageId: previousProposal.pageId }));
  }
  setSyncSubstep("Hotel Arrangement を確認しています", 5, 6);
  const hotelArrangement = await measure(log, "notion.arrangement", "Checked Hotel Arrangement for the same Check-in", () =>
    hasCheckedHotelArrangementForCheckIn(metadata.checkIn)
  );
  log[log.length - 1] = appendAuditDetails(log[log.length - 1]!, { checkIn: metadata.checkIn, hotelArrangement });
  const bookingSite =
    metadata.bookingSite === "HotelSlash"
      ? (
          await measure(log, "notion.bookingSite", "Resolved booking site for proposal display", () =>
            findNonHotelSlashBookingSiteForCheckIn(metadata.checkIn)
          )
        ) ?? metadata.bookingSite
      : metadata.bookingSite;
  log.push(audit("notion.bookingSite", "ok", "Resolved booking site for proposal display", { checkIn: metadata.checkIn, bookingSite }));
  const relatedReservationId = await findRelatedReservation(metadata);
  const item: PendingForward = {
    id: crypto.randomUUID(),
    kind: "lowPriceProposal",
    gmailMessageId: email.id,
    gmailUrl: `https://mail.google.com/mail/u/0/#inbox/${email.id}`,
    from: email.from,
    receivedAt: email.receivedAt,
    subject: email.subject,
    metadata,
    generatedSubject: `Low Price Proposal - ${metadata.hotelName}`,
    generatedBody: [
      `Hotel: ${metadata.hotelName}`,
      `Stay: ${metadata.checkIn ?? "TBD"} - ${metadata.checkOut ?? "TBD"}`,
      `Proposed Price: ${offer.priceCurrency} ${offer.priceAmount.toLocaleString("ja-JP")}`,
      `Room Type: ${offer.roomType}`,
      `Conditions: ${offer.conditions.join(", ") || "Not provided"}`
    ].join("\n"),
    internalJson: metadata,
    proposal: { ...offer, previousProposal, hotelArrangement, bookingSite },
    state: "pending",
    auditLog: log
  };
  setSyncSubstep("Low Price Proposal をNotionに保存しています", 6, 6);
  const notionPageId = await measure(item.auditLog, "notion.create", "Created Low Price Proposal record", () =>
    createLowPriceProposalRecord(item, relatedReservationId)
  );
  item.proposal = { ...item.proposal!, notionPageId };
  return item;
}

async function buildUnavailableLowPriceProposal(
  email: SourceEmail,
  log: PendingForward["auditLog"],
  error: Error
) {
  const { metadata, ratesUrl } = await extractLowPriceProposalContext(email, log);
  log.push(
    audit("hotelslash.render", "ok", "Rendered HotelSlash rates page and detected that the offer is no longer available", {
      requestedUrl: ratesUrl
    })
  );
  log.push(audit("hotelslash.unavailable", "info", error.message));
  const item: PendingForward = {
    id: crypto.randomUUID(),
    kind: "unavailableLowPriceProposal",
    gmailMessageId: email.id,
    gmailUrl: `https://mail.google.com/mail/u/0/#inbox/${email.id}`,
    from: email.from,
    receivedAt: email.receivedAt,
    subject: email.subject,
    metadata,
    generatedSubject: `失効した Low Price Proposal - ${metadata.hotelName}`,
    generatedBody: error.message,
    internalJson: metadata,
    unavailableProposal: {
      requestedUrl: ratesUrl,
      finalUrl: "finalUrl" in error && typeof error.finalUrl === "string" ? error.finalUrl : ratesUrl,
      pageTitle: "pageTitle" in error && typeof error.pageTitle === "string" ? error.pageTitle : undefined,
      message: error.message
    },
    state: "pending",
    auditLog: log
  };
  return item;
}

async function extractLowPriceProposalContext(email: SourceEmail, log: PendingForward["auditLog"]) {
  setSyncSubstep("AIでHotelSlash提案メールを抽出しています", 2, 6);
  const extractedMetadata = await measure(log, "ai.extract", "Extracted HotelSlash low price email metadata", () => extractReservationJson(email));
  const metadata = normalizeReservationDates(extractedMetadata, email.receivedAt);
  metadata.bookingSite = "HotelSlash";
  metadata.status = "Price Alert";
  metadata.emailType = "Low Price Proposal";
  metadata.reservationConfirmationUrl ??= extractReservationConfirmationUrl(email.body);

  const ratesUrl = extractLowerRateButtonUrl(email.body);
  if (!ratesUrl) throw new Error("HotelSlash rates button URL could not be found in the email body.");
  log.push(audit("hotelslash.link", "ok", "Extracted HotelSlash rates button URL", { ratesUrl }));
  return { metadata, ratesUrl };
}

async function measure<T>(
  log: PendingForward["auditLog"],
  step: string,
  message: string,
  run: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await run();
    log.push(audit(step, "ok", `${message} (${Date.now() - startedAt}ms)`, { durationMs: Date.now() - startedAt }));
    return result;
  } catch (error) {
    log.push(
      audit(step, "error", `${message} failed after ${Date.now() - startedAt}ms`, {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Unexpected error"
      })
    );
    throw error;
  }
}

function appendAuditDetails(event: PendingForward["auditLog"][number], details: Record<string, unknown>) {
  return {
    ...event,
    details: { ...(event.details ?? {}), ...details }
  };
}

function emitSyncAuditLog(email: SourceEmail, log: PendingForward["auditLog"], outcome: string) {
  console.info(
    `[sync.audit] ${outcome} ${email.id} ${email.subject}`,
    JSON.stringify({
      email: {
        id: email.id,
        from: email.from,
        subject: email.subject,
        receivedAt: email.receivedAt,
        lowerRate: isLowerRateEmail(email)
      },
      outcome,
      auditLog: log
    })
  );
}

function createIdleSyncProgress(): SyncProgress {
  return {
    active: false,
    stage: "待機中",
    currentStepIndex: 0,
    currentStepTotal: 0,
    totalCandidates: 0,
    completedCandidates: 0,
    failedCandidates: 0,
    currentIndex: 0,
    lastUpdatedAt: new Date().toISOString()
  };
}

function startSyncProgress() {
  syncProgress = {
    ...createIdleSyncProgress(),
    active: true,
    stage: "同期を開始しています",
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString()
  };
}

function updateSyncProgress(patch: Partial<SyncProgress>) {
  syncProgress = {
    ...syncProgress,
    ...patch,
    lastUpdatedAt: new Date().toISOString()
  };
}

function incrementSyncProgressCompletion(stage: string) {
  updateSyncProgress({
    stage,
    completedCandidates: syncProgress.completedCandidates + 1
  });
}

function incrementSyncProgressFailure(stage: string) {
  updateSyncProgress({
    stage,
    completedCandidates: syncProgress.completedCandidates + 1,
    failedCandidates: syncProgress.failedCandidates + 1
  });
}

function completeSyncProgress(stage: string) {
  updateSyncProgress({
    active: false,
    stage,
    currentStepLabel: undefined,
    currentStepIndex: syncProgress.currentStepTotal,
    currentEmailId: undefined,
    currentEmailSubject: undefined,
    currentEmailFrom: undefined,
    currentIndex: syncProgress.totalCandidates
  });
}

function failSyncProgress(stage: string) {
  updateSyncProgress({
    active: false,
    stage,
    currentStepLabel: undefined,
    currentEmailId: undefined,
    currentEmailSubject: undefined,
    currentEmailFrom: undefined
  });
}

function setSyncSubstep(stage: string, currentStepIndex: number, currentStepTotal: number) {
  updateSyncProgress({
    stage,
    currentStepLabel: stage,
    currentStepIndex,
    currentStepTotal
  });
}

function cleanKeyPart(value?: string) {
  if (!value || value === "[Redacted]" || value === "Not provided") return undefined;
  return value.trim().toLowerCase();
}
