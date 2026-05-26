# ZenForwarder 技術説明書

## 1. 構成

ZenForwarderは、React/ViteのフロントエンドとExpressのバックエンドで構成されるローカルWebアプリです。

- フロントエンド: `src/client/main.tsx`, `src/client/styles.css`
- バックエンド: `src/server/index.ts`
- 開発起動統括: `src/server/dev/bootstrap-dev.ts`
- 開発用ブラウザ自動表示: `src/server/dev/`
- ワークフロー制御: `src/server/workflow.ts`
- 共通型: `src/shared/types.ts`
- 外部連携サービス: `src/server/services/`

開発時は`npm run dev`で、親プロセスのbootstrapがViteクライアントとAPIサーバーを起動します。Viteクライアントは`http://localhost:5173/`、APIサーバーは`http://localhost:3000/`です。フロントエンド URL が応答可能になったあと、既定ブラウザを1回だけ自動表示します。

### 開発起動時のブラウザ自動表示

`npm run dev`は`src/server/dev/bootstrap-dev.ts`を起点に動作します。

- `bootstrap-dev.ts`
  - `npm run dev:server`と`npm run dev:client`を子プロセスで起動
  - 子プロセスの終了シグナルを監視し、片方が落ちたら全体を終了
- `config.ts`
  - `APP_URL`、`HEALTHCHECK_URL`、`AUTO_OPEN_BROWSER`、各種タイムアウト設定を解決
  - `APP_URL`未設定時は`http://localhost:5173`へフォールバック
  - CIやヘッドレス相当環境では自動表示をスキップ
- `waitForUrl.ts`
  - `HEALTHCHECK_URL`または`APP_URL`へHTTPポーリング
  - 200台と300台を起動成功扱い
- `openBrowser.ts`
  - macOSは`open`、Windowsは`cmd /c start`、Linuxは`xdg-open`で既定ブラウザを起動
- `autoOpenBrowser.ts`
  - 起動待機、追加遅延、ブラウザ起動、ログ出力、多重起動防止を担当

開発用の主な環境変数:

- `APP_URL`
- `HEALTHCHECK_URL`
- `AUTO_OPEN_BROWSER`
- `STARTUP_TIMEOUT_MS`
- `STARTUP_POLL_INTERVAL_MS`
- `AUTO_OPEN_BROWSER_DELAY_MS`

## 2. 主要サービス

### Gmail

`src/server/services/gmail.ts`がGmail API連携を担当します。

- OAuth URL生成
- 候補メール検索
- メール本文デコード
- 送信元エイリアス確認
- TripIt/HotelSlashへの転送
- `ZenForwarder/Processed`ラベル付与

候補検索では、ホテル予約関連語と`Lower Rate Found on Your Trip`を含むメールを対象にします。

### OpenAI

`src/server/services/ai.ts`が予約メールから内部JSONを抽出し、TripIt/HotelSlash向け英語転送本文を生成します。

生成本文はユーザー承認画面に表示されますが、Low Price Proposalでは転送本文ではなく価格提案比較画面を表示します。

### Notion

`src/server/services/notion.ts`がNotion DBとの同期を担当します。

- DBスキーマ補完
- 予約履歴レコード作成
- Low Price Proposalレコード作成
- 同一`Name`/`Check-in`の過去提案検索
- 同一`Check-in`の`Hotel Arrangement`チェック済み判定
- 同一`Check-in`のHotelSlash以外の`Booking Site`検索
- Proposal採用/不採用時の`Email Type`と`Hotel Arrangement`更新

Low Price Proposalで使う追加フィールドは以下です。

- `Proposal Room Type`
- `Proposal Conditions`
- `Hotel Arrangement`
- `Email Type = Low Price Proposal`
- `Email Type = Proposal accepted`
- `Email Type = Proposal Unaccepted`

`createReservationRecord`は通常転送と転送なしNotion登録で共用し、`tripIt`/`hotelSlash`転送日時と`hotelArrangement`を任意オプションとして受け取ります。転送なし登録では転送日時を空にし、`Hotel Arrangement`だけを必要に応じて引き継ぎます。

### HotelSlash

`src/server/services/hotelslash.ts`がHotelSlash価格ページの取得と抽出を担当します。

Playwrightの`launchPersistentContext`を使い、ローカルの`.hotelslash-profile/`をHotelSlash専用ブラウザプロファイルとして使います。

ログイン処理は自動化しません。ユーザーがアプリの`HotelSlashログイン`ボタンからブラウザを開き、手動ログインしたあと`ログイン完了`を押してプロファイルを保存します。

### Exchange

`src/server/services/exchange.ts`が現地通貨からJPYへの換算を担当します。

- `EXCHANGE_RATE_PROVIDER=exchangerate.host`または`api.exchangerate.host`かつ`EXCHANGE_RATE_API_KEY`設定済みの場合は外部APIを使用
- 同一日・同一通貨のレートは`EXCHANGE_RATE_CACHE_PATH`へ保存
- 外部API未設定時は主要通貨のフォールバックレートを使用
- JPYはレート1として処理

## 3. Low Price Proposal処理

`workflow.ts`の`syncReservations`でGmail候補を走査し、`isLowerRateEmail`がtrueの場合は通常の転送フローではなくLow Price Proposalフローへ分岐します。

処理手順:

1. Gmail本文から`CLICK HERE TO SEE YOUR RATES!`リンクを抽出
2. HotelSlash永続プロファイルで価格ページを開く
3. 描画後テキストから現在予約と最上段提案を抽出
4. Notionに`Low Price Proposal`レコードを作成
5. 同一`Name`/`Check-in`の最新過去提案を取得
6. 同一`Check-in`の`Hotel Arrangement`チェック済み有無を取得し、提案レコードと画面表示へ反映
7. Booking Siteが`HotelSlash`の場合、同一`Check-in`のNotionエントリからHotelSlash以外の`Booking Site`を検索し、画面表示用に保持
8. アプリ画面で3カラム比較を表示
9. 採用/不採用のボタン操作でNotionの`Email Type`を更新し、`Hotel Arrangement`も再判定して反映
10. Gmailを`ZenForwarder/Processed`へ移動

## 4. HotelSlash抽出仕様

抽出対象は描画後の`document.body.innerText`です。HTML構造はHotelSlash側の変更に影響されやすいため、DOMセレクタ依存を避け、テキストの見出しと行構造から抽出します。

### 現在の予約

`Here are the details of your current reservation.`から`Your HotelSlash Rates`までを左側カード相当として扱います。カード終端は`at the`や`Hotel Overview`などで切ります。

抽出項目:

- 価格
- 部屋タイプ
- 条件
- キャンセル期限
- 支払い条件

### 今回の提案

`Your HotelSlash Rates`または`Rebook your ... lower rate`以降、`Other deals`または`Photos Amenities Description`までを最上段提案として扱います。

抽出項目:

- 価格
- 部屋タイプ
- 条件

価格抽出では以下に対応します。

- `JPY125,559`
- `JPY 125,559`
- `$799`
- `USD 799`
- `TRY 12.345,67`

`Earn $7.99 SlashCash`や`Save JPY38,989`は提案価格ではないため価格候補から除外します。`$799 Save $248`のように同一行に差額が含まれる場合は、`Save`より前を提案価格として扱います。

### 抽出待機

HotelSlash価格ページはクライアント描画のため、本文を最大75秒ポーリングし、`parseTopHotelSlashOffer`が成功した時点で抽出完了とします。ログイン画面へリダイレクトされた場合は即座にログイン要求エラーを返します。

## 5. API

### 認証

- `GET /api/auth/status`
- `GET /auth/google`
- `GET /auth/google/callback`

### 同期と承認

- `POST /api/sync`
- `GET /api/pending`
- `POST /api/forward/:id/approve`
- `POST /api/forward/:id/notion-only`
- `POST /api/forward/:id/dismiss-and-reload`
- `POST /api/proposal/:id/decision`

`POST /api/forward/:id/notion-only`はTripIt/HotelSlashへ転送せず、Notionに予約履歴を作成してGmailを`ZenForwarder/Processed`へ移動します。通常転送と同じく、同一`Check-in`の既存Notionエントリに`Hotel Arrangement`チェック済みがあれば新規レコードへ引き継ぎます。

`POST /api/proposal/:id/decision`のbody:

```json
{ "decision": "accepted" }
```

または:

```json
{ "decision": "unaccepted" }
```

### HotelSlashログインプロファイル

- `GET /api/hotelslash/status`
- `POST /api/hotelslash/login/start`
- `POST /api/hotelslash/login/finish`

`login/start`は非headless Chromiumを起動します。ユーザーが手動ログインしたあと、`login/finish`でブラウザを閉じ、プロファイルを保存します。

### 管理系

- `POST /api/shutdown`
- `GET /api/notion/backfill-confirmation-urls`
- `POST /api/notion/backfill-confirmation-urls`
- `GET /api/notion/backfill-booking-sites`
- `POST /api/notion/backfill-booking-sites`
- `GET /api/gmail/archive-recorded-reservations`
- `POST /api/gmail/archive-recorded-reservations`

`POST /api/shutdown`はバックエンドの親プロセスへ`SIGTERM`を送り、自身も終了します。`npm run dev`では親bootstrapがこの終了を受けてViteクライアントも停止します。

## 6. データ型

主要な共通型は`src/shared/types.ts`にあります。

- `ReservationMetadata`
- `PendingForward`
- `LowPriceProposal`
- `CurrentReservationInfo`
- `PreviousProposal`

Low Price Proposalでは、`PendingForward.kind`を`lowPriceProposal`にし、`proposal`へHotelSlash抽出結果を格納します。

`LowPriceProposal`にはHotelSlash抽出結果に加えて、表示・Notion同期用の`hotelArrangement`と`bookingSite`を保持します。`bookingSite`は、HotelSlash提案メール由来のBooking Siteが`HotelSlash`の場合に、同一`Check-in`のNotion履歴からHotelSlash以外の値を補完したものです。

## 7. セキュリティとローカルデータ

`.env`、`.hotelslash-profile/`、`.cache/`はGit管理対象外です。

`.hotelslash-profile/`にはHotelSlashのログインCookieなどが保存されるため、共有やコミットをしてはいけません。パスワード入力、パスワードマネージャ操作、HotelSlashログイン送信はユーザーが手動で行います。

`.cache/exchange-rates.json`には為替レートキャッシュを保存します。認証情報は含みませんが、生成物のためコミットしません。

## 8. テスト

主なテスト:

- Gmail検索クエリとメール生成
- ワークフローの重複排除、承認、却下
- 転送なしNotion登録
- `Hotel Arrangement`引き継ぎ
- Low Price Proposal表示用Booking Site補完
- 為替換算
- HotelSlash価格ページテキスト抽出
- アプリ設定のデフォルト値と空文字の扱い
- 開発用URL解決
- 自動ブラウザ起動のスキップ条件
- 起動待機の成功とタイムアウト
- 開発セッション内の多重起動防止

実行:

```bash
npm test
npm run typecheck
npm run build
```

## 9. よくある障害

### HotelSlashログイン画面へリダイレクトされる

`.hotelslash-profile/`に有効なログインセッションがありません。アプリ画面の`HotelSlashログイン`から手動ログインし、`ログイン完了`を押してください。

### Playwrightがブラウザを起動できない

Chromiumが未インストールの可能性があります。

```bash
npx playwright install chromium
```

macOSの権限やサンドボックスでブラウザ起動がブロックされる場合は、開発サーバーをサンドボックス外で起動する必要があります。

### 価格が誤抽出される

HotelSlashの表示テキストが変わった可能性があります。`src/server/services/__tests__/hotelslash.test.ts`に該当テキストを追加し、`parseTopHotelSlashOffer`を更新してください。

### 為替APIが失敗する

`EXCHANGE_RATE_PROVIDER`、`EXCHANGE_RATE_API_KEY`、`EXCHANGE_RATE_CACHE_PATH`を確認してください。外部APIを使わない場合は`EXCHANGE_RATE_PROVIDER=mock`または未設定にするとフォールバックレートを使います。
