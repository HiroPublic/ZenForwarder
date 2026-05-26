# ZenForwarder

ZenForwarder は、日本語のホテル予約メールを Gmail から検出し、TripIt と HotelSlash が読み取りやすい英語メール本文へ変換して、ユーザー承認後に転送するローカル Web アプリです。

予約メタデータ、処理履歴、HotelSlash の低価格提案は Notion データベースにも記録します。

## 関連記事

- NOTE: [【世界一周の裏技】ホテル予約を「自動」で安くする？　私の旅を支える最強ツール](https://note.com/dr830821/n/n5c55417158a8?app_launch=false)

## 主な機能

- Gmail からホテル予約関連メールを検索
- OpenAI で予約メタデータを抽出
- TripIt / HotelSlash 向けの英語転送本文を生成
- 転送前に本文を確認・編集・承認
- Gmail API 経由で承認済みメールを転送
- Notion データベースに予約履歴を保存
- 転送せずに Notion 登録と Gmail 処理済み移動だけを行う
- Gmail ラベルで処理済みメールを管理
- exchangerate.host またはフォールバックレートで日本円換算額を保存
- HotelSlash の `Lower Rate Found on Your Trip` メールから低価格提案を抽出
- HotelSlash の保存済みブラウザプロファイルを使い、ログイン済みセッションで価格ページを表示
- 現在の予約、今回の提案、過去の提案条件を3カラムで比較し、採用/不採用を Notion に反映
- 同一チェックイン日の Notion エントリから `Hotel Arrangement` と実予約元の Booking Site を引き継いで表示・保存
- サイドバーの `終了` ボタンからローカルアプリを終了

## 技術スタック

- フロントエンド: React 19, Vite, Framer Motion, Lucide React, Tailwind CSS
- バックエンド: Node.js, Express, TypeScript
- 連携先: Gmail API, OpenAI API, Notion API, HotelSlash
- ブラウザ自動化: Playwright
- テスト: Vitest

## 必要なもの

- Node.js
- npm
- Gmail 連携用の Google OAuth クライアント情報
- OpenAI API キー
- Notion インテグレーショントークン
- Notion の予約管理データベース ID
- HotelSlash アカウント

## セットアップ

依存パッケージをインストールします。

```bash
npm install
```

Playwright の Chromium をインストールします。

```bash
npx playwright install chromium
```

プロジェクト直下に `.env` を作成します。

```bash
APP_URL=http://localhost:5173
HEALTHCHECK_URL=
AUTO_OPEN_BROWSER=true
STARTUP_TIMEOUT_MS=30000
STARTUP_POLL_INTERVAL_MS=250
AUTO_OPEN_BROWSER_DELAY_MS=300
SESSION_SECRET=change-me

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
GMAIL_AUTH_ACCOUNT=
FORWARD_FROM_EMAIL=

OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini

NOTION_API_KEY=
NOTION_HOTEL_RESERVATION_DATABASE_ID=

TRIPIT_FORWARD_EMAIL=plans@tripit.com
HOTELSLASH_FORWARD_EMAIL=save@hotelslash.com

EXCHANGE_RATE_API_KEY=
EXCHANGE_RATE_PROVIDER=mock
EXCHANGE_RATE_CACHE_PATH=.cache/exchange-rates.json
```

`FORWARD_FROM_EMAIL` は、Gmail の送信元エイリアスとして認証済みのメールアドレスを指定してください。

`EXCHANGE_RATE_PROVIDER` に `exchangerate.host` または `api.exchangerate.host` を指定し、`EXCHANGE_RATE_API_KEY` を設定すると実レートを取得します。未設定時は主要通貨のフォールバックレートを使います。取得したレートは `EXCHANGE_RATE_CACHE_PATH` に日次キャッシュされます。

## 開発環境での起動

API サーバーと Vite クライアントを同時に起動します。

```bash
npm run dev
```

`npm run dev` では、フロントエンド URL の起動完了を待ってから既定ブラウザを 1 回だけ自動で開きます。`APP_URL` を優先し、未設定時は `http://localhost:5173` を使います。`AUTO_OPEN_BROWSER=false` で無効化できます。CI やヘッドレス環境では自動起動しません。

起動コマンド自体は従来どおりです。

```bash
cd ~/VScode/ZenForwarder
npm run dev
```

アプリ画面:

```text
http://localhost:5173/
```

バックエンド API:

```text
http://localhost:3000/
```

ブラウザから終了する場合は、サイドバーの `終了` ボタンを押します。`POST /api/shutdown` が呼ばれ、バックエンドプロセスが終了し、親 bootstrap により Vite クライアントも停止します。ブラウザタブ自体はアプリから閉じません。

## HotelSlash ログイン設定

Low Price Proposal の処理では HotelSlash の価格ページを開くため、HotelSlash にログイン済みのブラウザプロファイルが必要です。

1. アプリ画面で `HotelSlashログイン` を押す
2. 開いた Chromium 画面で HotelSlash に手動ログインする
3. ブラウザは閉じずにアプリ画面へ戻り `ログイン完了` を押す
4. ログイン確認に成功すると、ログイン用ブラウザが自動で閉じる
5. 以降の Gmail 同期では `.hotelslash-profile/` と `.hotelslash-auth.json` に保存したログイン状態を使って価格ページを読み取る

`.hotelslash-profile/` と `.hotelslash-auth.json` はログイン状態を含むため Git 管理対象外です。

## npm スクリプト

```bash
npm run dev        # バックエンドとフロントエンドを watch モードで起動
npm run build      # 型チェック後にフロントエンドをビルド
npm run start      # バックエンドサーバーを起動
npm run test       # テストを実行
npm run typecheck  # TypeScript の型チェックを実行
```

## 基本ワークフロー

1. ホテルの予約通知メールをマニュアルで Gmail アカウントに転送
2. 予約転送ワークフローを実施
3. HotelSlash からの Low Price 通知メールをマニュアルで Gmail アカウントに転送
4. Low Price Proposal ワークフローを実施。必要ならホテルを再予約
5. HotelSlash から追加価格監視通知メールがきたら、HotelSlash の Web にログインして古い監視設定を削除。合わせて、TripIt の Web にログインして古いホテル予約記録を削除

## 予約転送ワークフロー

1. Google OAuth で Gmail 連携を行う
2. `Gmail同期` を押す
3. 抽出された予約メタデータと生成された英語本文を確認する
4. 必要に応じて本文を編集する
5. `承認して転送` を押す
6. TripIt と HotelSlash へメールが転送され、Notion に履歴が作成される
7. 元メールに処理済み Gmail ラベルが付与される

`転送せずNOTIONに登録` を押した場合は、TripIt と HotelSlash へは転送せず、Notion に履歴を作成して元メールを `ZenForwarder/Processed` に移動します。Notion の同一 `Check-in` エントリに `Hotel Arrangement` がチェック済みのものがある場合、新規エントリもチェック済みにします。通常の `承認して転送` でも同じ引き継ぎを行います。

## Low Price Proposal ワークフロー

1. Gmail同期で subject に `Lower Rate Found on Your Trip` を含むメールを検出する
2. メール本文の `CLICK HERE TO SEE YOUR RATES!` リンクを抽出する
3. 保存済み HotelSlash プロファイルで価格ページを開く
4. 現在の予約、最上段の提案価格、部屋タイプ、条件、無料キャンセル期限、支払い条件を抽出する
5. Notion に `Email Type = Low Price Proposal` の新規エントリを作成する
6. 同一 `Name` かつ同一 `Check-in` の最新提案を取得し、画面で比較する
7. 同一 `Check-in` の Notion エントリから `Hotel Arrangement` と HotelSlash 以外の Booking Site があれば取得し、比較画面へ表示する
8. `採用` で `Proposal accepted`、`不採用` で `Proposal Unaccepted` に Notion の Email Type を更新する
9. 採用/不採用時も同一 `Check-in` の `Hotel Arrangement` がチェック済みなら提案エントリへ反映する
10. 元Gmailを `ZenForwarder/Processed` に移動する

## ドキュメント

詳細仕様は [doc/AppSpec.md](doc/AppSpec.md)、技術説明は [doc/TechnicalGuide.md](doc/TechnicalGuide.md) を参照してください。

## セキュリティ上の注意

- `.env` は Git 管理に含めないでください。
- `.hotelslash-profile/` は Git 管理に含めないでください。
- `.cache/` は Git 管理に含めないでください。
- API キー、OAuth シークレット、セッションシークレット、Notion データベース ID はコミットしないでください。
- 転送前に Gmail の送信元エイリアス設定を確認します。
- 生成される転送メールでは、可能な範囲で個人情報を削除またはマスクします。

# License

This project is licensed under the MIT License - see the LICENSE file for details.

## Author

Copyright (c) 2026 HiroPublic

This project was developed with assistance from generative AI.
