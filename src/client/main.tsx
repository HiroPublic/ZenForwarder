import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, motion } from "framer-motion";
import { Check, KeyRound, Loader2, MailSearch, Power, RefreshCw, Send, ShieldCheck, ThumbsDown, ThumbsUp, XCircle } from "lucide-react";
import type { PendingForward, SyncError, SyncProgress } from "../shared/types";
import "./styles.css";

type ApiState = "idle" | "loading" | "error";
type ShutdownState = "idle" | "closing" | "closed";
type PendingAction =
  | "none"
  | "sync"
  | "hotelslash-login-start"
  | "hotelslash-login-finish"
  | "approve"
  | "notion-only"
  | "proposal-decision"
  | "proposal-ack"
  | "dismiss-and-reload";

interface AuthStatus {
  gmailConfigured: boolean;
  gmailAuthenticated: boolean;
  account: string;
}

interface HotelSlashStatus {
  profileDir: string;
  profileExists: boolean;
  loginWindowOpen: boolean;
}

interface SyncResponse {
  items?: PendingForward[];
  errors?: SyncError[];
  error?: string;
}

function App() {
  const [items, setItems] = useState<PendingForward[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [editedBody, setEditedBody] = useState("");
  const [apiState, setApiState] = useState<ApiState>("idle");
  const [pendingAction, setPendingAction] = useState<PendingAction>("none");
  const [shutdownState, setShutdownState] = useState<ShutdownState>("idle");
  const [authStatus, setAuthStatus] = useState<AuthStatus>();
  const [hotelSlashStatus, setHotelSlashStatus] = useState<HotelSlashStatus>();
  const [syncProgress, setSyncProgress] = useState<SyncProgress>();
  const [shouldPollSyncProgress, setShouldPollSyncProgress] = useState(false);
  const [message, setMessage] = useState("未処理メールを同期してください。");
  const [reloadReservationNumber, setReloadReservationNumber] = useState("");
  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? items[0], [items, selectedId]);
  const syncOverlayVisible = pendingAction === "sync" || shouldPollSyncProgress || Boolean(syncProgress?.active);

  useEffect(() => {
    void loadAuthStatus();
    void loadHotelSlashStatus();
    void loadPending();
  }, []);

  useEffect(() => {
    if (selected) {
      setSelectedId(selected.id);
      setEditedBody(selected.generatedBody);
    }
  }, [selected?.id]);

  useEffect(() => {
    if (!syncOverlayVisible) return;
    let cancelled = false;

    async function pollOnce() {
      try {
        const response = await fetch("/api/sync/progress");
        const data = (await response.json()) as SyncProgress;
        if (!cancelled) setSyncProgress(data);
      } catch {
        // Keep polling while sync is active.
      }
    }

    void pollOnce();
    const intervalId = window.setInterval(() => {
      void pollOnce();
    }, 400);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [syncOverlayVisible]);

  async function loadPending() {
    const response = await fetch("/api/pending");
    const data = (await response.json()) as { items: PendingForward[] };
    setItems(data.items);
  }

  async function loadAuthStatus() {
    const response = await fetch("/api/auth/status");
    const data = (await response.json()) as AuthStatus;
    setAuthStatus(data);
    if (data.gmailConfigured && !data.gmailAuthenticated) {
      setMessage("Gmail連携が未完了です。先にGmail連携を実行してください。");
    }
  }

  async function loadHotelSlashStatus() {
    const response = await fetch("/api/hotelslash/status");
    const data = (await response.json()) as HotelSlashStatus;
    setHotelSlashStatus(data);
  }

  async function startHotelSlashLogin() {
    setPendingAction("hotelslash-login-start");
    setApiState("loading");
    setMessage("HotelSlashログイン用ブラウザを開いています。開いた画面で手動ログインし、ブラウザは閉じずにこのアプリへ戻ってください。");
    try {
      const response = await fetch("/api/hotelslash/login/start", { method: "POST" });
      const data = (await response.json()) as HotelSlashStatus & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "HotelSlashログイン画面を開けませんでした。");
      setHotelSlashStatus(data);
      setMessage("HotelSlashログイン画面を開きました。ログイン後、ブラウザは閉じずにこのアプリで「ログイン完了」を押してください。確認できたら自動で閉じます。");
      setApiState("idle");
    } catch (error) {
      setApiState("error");
      setMessage(error instanceof Error ? error.message : "HotelSlashログイン画面を開けませんでした。");
    } finally {
      setPendingAction("none");
    }
  }

  async function finishHotelSlashLogin() {
    setPendingAction("hotelslash-login-finish");
    setApiState("loading");
    setMessage("HotelSlashログイン状態を確認しています。確認できたらブラウザを自動で閉じます。");
    try {
      const response = await fetch("/api/hotelslash/login/finish", { method: "POST" });
      const data = (await response.json()) as HotelSlashStatus & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "HotelSlashログイン状態の保存に失敗しました。");
      setHotelSlashStatus(data);
      setMessage("HotelSlashログインを確認し、ブラウザを自動で閉じてプロファイルを保存しました。Gmail同期を再実行できます。");
      setApiState("idle");
    } catch (error) {
      setApiState("error");
      setMessage(error instanceof Error ? error.message : "HotelSlashログイン状態の保存に失敗しました。");
    } finally {
      setPendingAction("none");
    }
  }

  async function sync(forceReload = false, reservationNumber?: string) {
    if (authStatus?.gmailConfigured && !authStatus.gmailAuthenticated) {
      setApiState("error");
      setMessage("Gmail連携が未完了です。先にGmail連携を実行してください。");
      return;
    }
    const normalizedReservationNumber = reservationNumber?.trim();
    if (forceReload && !normalizedReservationNumber) {
      setApiState("error");
      setMessage("確認用の再取込には予約番号を入力してください。");
      return;
    }
    setPendingAction("sync");
    setApiState("loading");
    setShouldPollSyncProgress(true);
    setSyncProgress({
      active: true,
      stage: "同期を開始しています",
      currentStepLabel: "同期を開始しています",
      currentStepIndex: 0,
      currentStepTotal: 0,
      totalCandidates: 0,
      completedCandidates: 0,
      failedCandidates: 0,
      currentIndex: 0,
      lastUpdatedAt: new Date().toISOString()
    });
    setMessage(
      forceReload && normalizedReservationNumber
        ? `予約番号 ${normalizedReservationNumber} を指定して Gmail を確認しています。`
        : "Gmail からホテル予約メールを確認しています。"
    );
    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forceReload, reservationNumber: normalizedReservationNumber })
      });
      const data = (await response.json()) as SyncResponse;
      if (!response.ok) throw new Error(data.error ?? "同期に失敗しました。");
      setItems(data.items ?? []);
      if ((data.errors?.length ?? 0) > 0) {
        setMessage(formatSyncWarning(data.errors ?? [], data.items ?? []));
        setApiState("error");
      } else {
        setMessage(
          data.items?.length
            ? forceReload
              ? `予約番号 ${normalizedReservationNumber} の承認待ちメールを生成しました。`
              : "承認待ちメールを生成しました。"
            : forceReload
              ? `予約番号 ${normalizedReservationNumber} に一致する承認待ちメールはありませんでした。`
              : "新しい承認待ちメールはありません。"
        );
        setApiState("idle");
      }
    } catch (error) {
      setApiState("error");
      setMessage(error instanceof Error ? error.message : "同期に失敗しました。");
    } finally {
      setShouldPollSyncProgress(false);
      setSyncProgress((current) => (current ? { ...current, active: false } : current));
      setPendingAction("none");
    }
  }

  async function approve() {
    if (!selected) return;
    setPendingAction("approve");
    setApiState("loading");
    setMessage("TripIt と HotelSlash へ転送しています。");
    try {
      const response = await fetch(`/api/forward/${selected.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editedBody })
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "転送に失敗しました。");
      const remaining = items.filter((item) => item.id !== selected.id);
      setItems(remaining);
      setSelectedId(remaining[0]?.id);
      setMessage("転送、Notion登録、Gmailラベル付与が完了しました。");
      setApiState("idle");
    } catch (error) {
      setApiState("error");
      setMessage(error instanceof Error ? error.message : "転送に失敗しました。");
    } finally {
      setPendingAction("none");
    }
  }

  async function registerInNotionOnly() {
    if (!selected) return;
    setPendingAction("notion-only");
    setApiState("loading");
    setMessage("転送せず、Notion登録とGmailのProcessed移動を実行しています。");
    try {
      const response = await fetch(`/api/forward/${selected.id}/notion-only`, {
        method: "POST"
      });
      const data = (await response.json()) as { error?: string; hotelArrangement?: boolean };
      if (!response.ok) throw new Error(data.error ?? "Notion登録に失敗しました。");
      const remaining = items.filter((item) => item.id !== selected.id);
      setItems(remaining);
      setSelectedId(remaining[0]?.id);
      setMessage(data.hotelArrangement ? "Notion登録、Hotel Arrangement引き継ぎ、GmailのProcessed移動が完了しました。" : "Notion登録とGmailのProcessed移動が完了しました。");
      setApiState("idle");
    } catch (error) {
      setApiState("error");
      setMessage(error instanceof Error ? error.message : "Notion登録に失敗しました。");
    } finally {
      setPendingAction("none");
    }
  }

  async function decideProposal(decision: "accepted" | "unaccepted") {
    if (!selected) return;
    setPendingAction("proposal-decision");
    setApiState("loading");
    setMessage(decision === "accepted" ? "提案を採用として記録しています。" : "提案を不採用として記録しています。");
    try {
      const response = await fetch(`/api/proposal/${selected.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision })
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "提案ステータスの更新に失敗しました。");
      const remaining = items.filter((item) => item.id !== selected.id);
      setItems(remaining);
      setSelectedId(remaining[0]?.id);
      setMessage("Notion更新とGmailのProcessed移動が完了しました。");
      setApiState("idle");
    } catch (error) {
      setApiState("error");
      setMessage(error instanceof Error ? error.message : "提案ステータスの更新に失敗しました。");
    } finally {
      setPendingAction("none");
    }
  }

  async function acknowledgeUnavailableProposal() {
    if (!selected) return;
    setPendingAction("proposal-ack");
    setApiState("loading");
    setMessage("失効したHotelSlash提案を確認済みにして、GmailのProcessedへ移動しています。");
    try {
      const response = await fetch(`/api/proposal/${selected.id}/acknowledge-unavailable`, {
        method: "POST"
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "失効した提案の確認処理に失敗しました。");
      const remaining = items.filter((item) => item.id !== selected.id);
      setItems(remaining);
      setSelectedId(remaining[0]?.id);
      setMessage("失効した提案を確認済みにし、GmailのProcessed移動が完了しました。");
      setApiState("idle");
    } catch (error) {
      setApiState("error");
      setMessage(error instanceof Error ? error.message : "失効した提案の確認処理に失敗しました。");
    } finally {
      setPendingAction("none");
    }
  }

  async function dismissAndReload() {
    if (!selected) return;
    setPendingAction("dismiss-and-reload");
    setApiState("loading");
    setMessage("この候補を外して、次の候補を読み込んでいます。");
    try {
      const response = await fetch(`/api/forward/${selected.id}/dismiss-and-reload`, {
        method: "POST"
      });
      const data = (await response.json()) as { items?: PendingForward[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "候補の再読み込みに失敗しました。");
      setItems(data.items ?? []);
      setSelectedId(data.items?.[0]?.id);
      setMessage(data.items?.length ? "候補を外して再読み込みしました。" : "候補を外しました。新しい承認待ちメールはありません。");
      setApiState("idle");
    } catch (error) {
      setApiState("error");
      setMessage(error instanceof Error ? error.message : "候補の再読み込みに失敗しました。");
    } finally {
      setPendingAction("none");
    }
  }

  async function shutdown() {
    setShutdownState("closing");
    setMessage("アプリを終了しています。");
    try {
      await fetch("/api/shutdown", { method: "POST" });
    } catch {
      // The server may close the connection while shutting down.
    }
    setShutdownState("closed");
    setMessage("アプリを終了しました。必要に応じてこのブラウザタブを閉じてください。");
  }

  return (
    <>
      <main className="app-shell">
        <section className="sidebar">
        <div className="brand">
          <ShieldCheck size={28} />
          <div>
            <h1>ZenForwarder</h1>
            <p>予約翻訳転送</p>
          </div>
        </div>

        {authStatus?.gmailConfigured ? (
          <a className={`auth-action ${authStatus.gmailAuthenticated ? "connected" : ""}`} href="/auth/google">
            <KeyRound size={17} />
            {authStatus.gmailAuthenticated ? "Gmail連携済み" : "Gmail連携"}
          </a>
        ) : null}

        <button className="primary-action" onClick={() => void sync(false)} disabled={apiState === "loading"}>
          {pendingAction === "sync" ? <Loader2 className="spin" size={18} /> : <MailSearch size={18} />}
          Gmail同期
        </button>
        <div className="targeted-reload">
          <input
            type="text"
            value={reloadReservationNumber}
            onChange={(event) => setReloadReservationNumber(event.target.value)}
            placeholder="予約番号を入力"
            disabled={apiState === "loading"}
          />
          <button className="secondary-action" onClick={() => void sync(true, reloadReservationNumber)} disabled={apiState === "loading"}>
            {pendingAction === "sync" ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            予約番号を指定して再取込
          </button>
        </div>

        <div className="hotelslash-actions">
          <button className="auth-action" onClick={startHotelSlashLogin} disabled={apiState === "loading" || hotelSlashStatus?.loginWindowOpen}>
            {pendingAction === "hotelslash-login-start" ? <Loader2 className="spin" size={17} /> : <KeyRound size={17} />}
            HotelSlashログイン
          </button>
          <button className="auth-action connected" onClick={finishHotelSlashLogin} disabled={apiState === "loading" || !hotelSlashStatus?.profileExists}>
            {pendingAction === "hotelslash-login-finish" ? <Loader2 className="spin" size={17} /> : <Check size={17} />}
            ログイン完了
          </button>
        </div>

        <button className="shutdown-action" onClick={shutdown} disabled={shutdownState !== "idle"}>
          {shutdownState === "closing" ? <Loader2 className="spin" size={18} /> : <Power size={18} />}
          {shutdownState === "closed" ? "終了済み" : "終了"}
        </button>

        <div className={`status ${apiState}`}>
          <span>{message}</span>
          {authStatus ? <small>{authStatus.account}</small> : null}
        </div>

        <div className="queue-heading">
          <span>メール承認</span>
          <strong>{items.length}</strong>
        </div>

        <div className="queue">
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <motion.button
                layout
                key={item.id}
                className={`queue-item ${selected?.id === item.id ? "active" : ""}`}
                onClick={() => setSelectedId(item.id)}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
              >
                <span className="queue-title">{item.metadata.hotelName}</span>
                <span className="queue-meta">{item.metadata.emailType}</span>
                <span className="queue-date">
                  {formatStayDate(item.metadata.checkIn)} - {formatStayDate(item.metadata.checkOut)}
                </span>
              </motion.button>
            ))}
          </AnimatePresence>
        </div>
        </section>

        <section className="workspace">
          {selected ? (
            <>
            <header className="review-header">
              <div className="review-heading">
                <p className="eyebrow">{selected.metadata.status}</p>
                <h2>{selected.generatedSubject}</h2>
                <p className="source">
                  {selected.from} / {new Date(selected.receivedAt).toLocaleString("ja-JP")}
                </p>
              </div>
              {selected.kind === "lowPriceProposal" || selected.kind === "unavailableLowPriceProposal" ? null : (
                <div className="review-actions">
                  <button className="secondary-button" onClick={dismissAndReload} disabled={apiState === "loading"}>
                    {apiState === "loading" ? <Loader2 className="spin" size={18} /> : <XCircle size={18} />}
                    候補から外し再読み込み
                  </button>
                  <div className="primary-action-stack">
                    <button className="approve-button" onClick={approve} disabled={apiState === "loading"}>
                      {apiState === "loading" ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
                      承認して転送
                    </button>
                    <button className="notion-only-button" onClick={registerInNotionOnly} disabled={apiState === "loading"}>
                      {apiState === "loading" ? <Loader2 className="spin" size={18} /> : <Check size={18} />}
                      転送せずNOTIONに登録
                    </button>
                  </div>
                </div>
              )}
            </header>

            {selected.kind === "lowPriceProposal" && selected.proposal ? (
              <section className="proposal-panel">
                <div className="proposal-stay">
                  <h3>{selected.metadata.hotelName}</h3>
                  <p>
                    {formatStayDate(selected.metadata.checkIn)} - {formatStayDate(selected.metadata.checkOut)}
                    {proposalBookingSite(selected) ? ` / ${proposalBookingSite(selected)}` : ""}
                  </p>
                </div>
                <div className="proposal-grid">
                  <ProposalColumn
                    title="現在の予約"
                    price={currentReservationPrice(selected)}
                    roomType={selected.proposal.currentReservation?.roomType}
                    conditions={selected.proposal.currentReservation?.conditions}
                    cancellationDeadline={selected.proposal.currentReservation?.cancellationDeadline}
                    paymentTerms={selected.proposal.currentReservation?.paymentTerms}
                    hotelArrangement={selected.proposal.hotelArrangement}
                    empty={!selected.proposal.currentReservation}
                  />
                  <ProposalColumn
                    title="今回の提案"
                    receivedAt={selected.receivedAt}
                    price={`${selected.proposal.priceCurrency} ${selected.proposal.priceAmount.toLocaleString("ja-JP")}`}
                    roomType={selected.proposal.roomType}
                    conditions={selected.proposal.conditions}
                  />
                  <ProposalColumn
                    title="過去の提案条件"
                    receivedAt={selected.proposal.previousProposal?.receivedAt}
                    price={previousProposalPrice(selected)}
                    roomType={selected.proposal.previousProposal?.roomType}
                    conditions={selected.proposal.previousProposal?.conditions}
                    empty={!selected.proposal.previousProposal}
                  />
                </div>
                <div className="proposal-actions">
                  <button className="approve-button" onClick={() => decideProposal("accepted")} disabled={apiState === "loading"}>
                    {apiState === "loading" ? <Loader2 className="spin" size={18} /> : <ThumbsUp size={18} />}
                    採用
                  </button>
                  <button className="secondary-button" onClick={() => decideProposal("unaccepted")} disabled={apiState === "loading"}>
                    {apiState === "loading" ? <Loader2 className="spin" size={18} /> : <ThumbsDown size={18} />}
                    不採用
                  </button>
                </div>
              </section>
            ) : selected.kind === "unavailableLowPriceProposal" && selected.unavailableProposal ? (
              <section className="proposal-panel">
                <div className="proposal-stay">
                  <h3>{selected.metadata.hotelName}</h3>
                  <p>
                    {formatStayDate(selected.metadata.checkIn)} - {formatStayDate(selected.metadata.checkOut)}
                    {selected.metadata.bookingSite ? ` / ${selected.metadata.bookingSite}` : ""}
                  </p>
                </div>
                <div className="proposal-column">
                  <h4>HotelSlash提案は失効しました</h4>
                  <p className="proposal-empty">
                    HotelSlash側で「見つけた料金はもう利用できない」と返されています。確認後は、このメールを転送・Notion登録せずに
                    `ZenForwarder/Processed` へ移動します。
                  </p>
                  <CompactFact label="タイトル" value={selected.unavailableProposal.pageTitle} />
                  <CompactFact label="Requested URL" value={selected.unavailableProposal.requestedUrl} />
                  <CompactFact label="Final URL" value={selected.unavailableProposal.finalUrl} />
                </div>
                <div className="proposal-actions">
                  <button className="approve-button" onClick={acknowledgeUnavailableProposal} disabled={apiState === "loading"}>
                    {apiState === "loading" ? <Loader2 className="spin" size={18} /> : <Check size={18} />}
                    確認してProcessedへ移動
                  </button>
                </div>
              </section>
            ) : (
              <div className="review-grid">
                <section className="metadata-panel">
                  <h3>予約メタデータ</h3>
                  <Metadata label="ホテル" value={selected.metadata.hotelName} />
                  <Metadata label="予約サイト" value={selected.metadata.bookingSite} />
                  <Metadata label="予約番号" value={selected.metadata.reservationNumber} />
                  <Metadata label="宿泊者人数" value={guestCountLabel(selected)} />
                  <Metadata label="確認書URL" value={selected.metadata.reservationConfirmationUrl} />
                  <Metadata label="宿泊日" value={`${formatStayDate(selected.metadata.checkIn)} - ${formatStayDate(selected.metadata.checkOut)}`} />
                  <Metadata label="泊数" value={selected.metadata.nights?.toString()} />
                  <Metadata label="食事条件" value={selected.metadata.mealPlan} />
                  <Metadata label="料金" value={priceLabel(selected)} />
                  <Metadata label="住所" value={selected.metadata.hotelAddress} />
                  <Metadata label="電話" value={selected.metadata.hotelPhone} />
                </section>

                <section className="editor-panel">
                  <div className="editor-toolbar">
                    <h3>転送本文</h3>
                    <button onClick={() => setEditedBody(selected.generatedBody)}>
                      <RefreshCw size={16} />
                      元に戻す
                    </button>
                  </div>
                  <textarea value={editedBody} onChange={(event) => setEditedBody(event.target.value)} spellCheck={false} />
                </section>
              </div>
            )}

            <section className="audit-strip">
              {selected.auditLog.map((event) => (
                <span key={`${event.at}-${event.step}`}>
                  <Check size={14} />
                  {event.step}
                </span>
              ))}
            </section>
            </>
          ) : (
            <section className="empty-state">
              <MailSearch size={42} />
              <h2>承認待ちメールはありません</h2>
              <p>Gmail同期を実行すると、過去1週間のホテル予約メールを確認します。</p>
            </section>
          )}
        </section>
      </main>
      <AnimatePresence>
        {syncOverlayVisible && syncProgress ? (
          <motion.div className="sync-progress-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.section
              className="sync-progress-modal"
              initial={{ opacity: 0, y: 16, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
            >
              <div className="sync-progress-header">
                <div>
                  <p className="sync-progress-eyebrow">Gmail同期</p>
                  <h3>{syncProgress.stage}</h3>
                </div>
                <Loader2 className="spin" size={22} />
              </div>
              <div className="sync-progress-bar">
                <span style={{ width: `${syncProgressPercent(syncProgress)}%` }} />
              </div>
              <div className="sync-progress-meta">
                <strong>
                  {syncProgress.totalCandidates > 0
                    ? `${Math.min(syncProgress.completedCandidates + (syncProgress.active && syncProgress.currentEmailId ? 1 : 0), syncProgress.totalCandidates)} / ${syncProgress.totalCandidates}`
                    : "候補メールを確認中"}
                </strong>
                <span>
                  完了 {syncProgress.completedCandidates}
                  {syncProgress.failedCandidates ? ` / エラー ${syncProgress.failedCandidates}` : ""}
                </span>
              </div>
              {syncProgress.currentStepTotal > 0 ? (
                <div className="sync-progress-step">
                  <span>{syncProgress.currentStepLabel ?? syncProgress.stage}</span>
                  <strong>
                    {Math.min(syncProgress.currentStepIndex, syncProgress.currentStepTotal)} / {syncProgress.currentStepTotal}
                  </strong>
                </div>
              ) : null}
              <div className="sync-progress-current">
                <p>{syncProgress.currentEmailSubject ?? "メール一覧を取得しています"}</p>
                {syncProgress.currentEmailFrom ? <small>{syncProgress.currentEmailFrom}</small> : null}
              </div>
            </motion.section>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

function Metadata({ label, value }: { label: string; value?: string }) {
  return (
    <div className="metadata-row">
      <span>{label}</span>
      <strong>{value || "未取得"}</strong>
    </div>
  );
}

function ProposalColumn({
  title,
  receivedAt,
  price,
  roomType,
  conditions,
  cancellationDeadline,
  paymentTerms,
  hotelArrangement,
  empty
}: {
  title: string;
  receivedAt?: string;
  price?: string;
  roomType?: string;
  conditions?: string[];
  cancellationDeadline?: string;
  paymentTerms?: string;
  hotelArrangement?: boolean;
  empty?: boolean;
}) {
  return (
    <section className="proposal-column">
      <h4>{title}</h4>
      {empty ? (
        <p className="proposal-empty">同一Name・Check-inの過去提案は見つかりません。</p>
      ) : (
        <>
          {receivedAt ? <p className="proposal-subtitle">{new Date(receivedAt).toLocaleString("ja-JP")}</p> : null}
          <CompactFact label="価格" value={price} />
          <CompactFact label="部屋" value={roomType} />
          <CompactFact label="条件" value={conditions?.join(", ")} />
          <CompactFact label="取消" value={cancellationDeadline} />
          <CompactFact label="支払" value={paymentTerms} />
        </>
      )}
      {typeof hotelArrangement === "boolean" ? <ArrangementFact checked={hotelArrangement} /> : null}
    </section>
  );
}

function CompactFact({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="compact-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatSyncWarning(errors: SyncError[], items: PendingForward[]) {
  const summary = items.length ? "一部のメールは処理できませんでしたが、処理できたメールは一覧に表示しています。" : "処理できるメールはありませんでした。";
  return [
    summary,
    ...errors.map((error, index) =>
      `${index + 1}. 件名: ${error.subject} / 受信日時: ${new Date(error.receivedAt).toLocaleString("ja-JP")} / 送信者: ${error.from}\n${error.message}`
    )
  ].join("\n");
}

function syncProgressPercent(progress: SyncProgress) {
  if (progress.totalCandidates <= 0) return 12;
  const completedBase = progress.completedCandidates / progress.totalCandidates;
  const stepFraction =
    progress.active && progress.currentEmailId && progress.currentStepTotal > 0
      ? ((Math.max(progress.currentStepIndex, 1) - 1) / progress.currentStepTotal) * (1 / progress.totalCandidates)
      : 0;
  return Math.min(100, (completedBase + stepFraction) * 100);
}

function ArrangementFact({ checked }: { checked: boolean }) {
  return (
    <div className={`compact-fact arrangement-fact ${checked ? "checked" : ""}`}>
      <span>ホテル現地手配</span>
      <strong>{checked ? "あり" : "なし"}</strong>
    </div>
  );
}

function priceLabel(item: PendingForward) {
  const source = item.metadata.originalAmount
    ? `${item.metadata.originalCurrency ?? ""} ${item.metadata.originalAmount}`.trim()
    : "未取得";
  const jpy = item.metadata.jpyAmount ? ` / 約 ${item.metadata.jpyAmount.toLocaleString("ja-JP")}円` : "";
  return `${source}${jpy}`;
}

function guestCountLabel(item: PendingForward) {
  const parts = [];
  if (typeof item.metadata.adultCount === "number") parts.push(`大人 ${item.metadata.adultCount}`);
  if (typeof item.metadata.childCount === "number") parts.push(`子ども ${item.metadata.childCount}`);
  return parts.join(" / ") || undefined;
}

function previousProposalPrice(item: PendingForward) {
  const proposal = item.proposal?.previousProposal;
  if (!proposal?.priceAmount) return undefined;
  return `${proposal.priceCurrency ?? ""} ${proposal.priceAmount.toLocaleString("ja-JP")}`.trim();
}

function currentReservationPrice(item: PendingForward) {
  const current = item.proposal?.currentReservation;
  if (!current?.priceAmount) return undefined;
  return `${current.priceCurrency ?? ""} ${current.priceAmount.toLocaleString("ja-JP")}`.trim();
}

function proposalBookingSite(item: PendingForward) {
  return item.proposal?.bookingSite ?? item.metadata.bookingSite;
}

function formatStayDate(value?: string) {
  if (!value) return "TBD";
  return value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? value;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
