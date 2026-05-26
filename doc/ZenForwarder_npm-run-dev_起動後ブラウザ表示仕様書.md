# ZenForwarder `npm run dev` 起動後ブラウザ表示仕様書

## 1. 目的

`ZenForwarder` をローカルで `npm run dev` 起動したとき、開発用フロントエンドが利用可能になったタイミングで、既定ブラウザに自動表示する。

対象は開発体験の改善であり、毎回手動で `localhost` を開く操作をなくすことを目的とする。

## 2. 前提

### 2.1 現在の起動方法

```bash
cd ~/VScode/ZenForwarder
npm run dev
```

### 2.2 技術スタック

- フロントエンド: React 19, Vite, Framer Motion, Lucide React, Tailwind CSS
- バックエンド: Node.js, Express, TypeScript
- テスト: Vitest

### 2.3 現在の構成

現在の `npm run dev` は親 bootstrap プロセスから以下を起動する。

- `npm run dev:server`
  - `tsx watch src/server/index.ts`
- `npm run dev:client`
  - `vite --host 0.0.0.0`

親 bootstrap がフロントエンド起動待機とブラウザ自動表示を担当する。

## 3. スコープ

対象:

- `npm run dev` 実行時の起動制御
- フロントエンド URL の決定
- フロントエンド起動完了待機
- 既定ブラウザ起動
- 多重起動防止
- 開発時ログ出力

対象外:

- 本番デプロイ時のブラウザ起動
- 業務ロジック
- Playwright 自動化処理
- Gmail / OpenAI / Notion / HotelSlash 連携処理

## 4. 実現したいユーザー体験

ユーザーがターミナルで `npm run dev` を実行すると、数秒後に `ZenForwarder` の開発用画面がブラウザで自動的に開く。

ただし、以下は避ける。

- サーバー未起動の URL を早すぎるタイミングで開くこと
- ホットリロードや再コンパイルのたびに新しいタブが増えること
- CI やヘッドレス環境でブラウザ起動して失敗すること

## 5. 用語定義

- `dev command`: `npm run dev`
- `frontend url`: ユーザーが最初に見るべきフロントエンド URL
- `healthcheck url`: 起動完了判定のために監視する URL
- `auto open`: 起動完了後に既定ブラウザで `frontend url` を開く処理

## 6. 要件

### 6.1 機能要件

1. `npm run dev` 実行時のみ自動ブラウザ表示を行うこと。
2. 開く対象は API URL ではなく、React/Vite 側の画面 URL であること。
3. フロントエンドが応答可能になるまで待ってからブラウザを開くこと。
4. ブラウザ起動は 1 回の開発起動につき 1 回までとすること。
5. 自動表示を設定で無効化できること。
6. ブラウザ起動失敗時も `npm run dev` 全体は失敗扱いにしないこと。

### 6.2 非機能要件

1. macOS を優先対応とすること。
2. 実装は TypeScript で保守しやすい構成にすること。
3. Vite と Express が別プロセスでも対応できること。
4. ログで起動待機とブラウザ起動結果が確認できること。

## 7. URL と設定

### 7.1 必須設定

- `APP_URL`
  - 自動表示対象のフロントエンド URL
  - 例: `http://localhost:5173`

`APP_URL` が未設定なら、開発既定値を使ってよい。

現在の開発既定値:

```env
APP_URL=http://localhost:5173
```

### 7.2 任意設定

- `AUTO_OPEN_BROWSER`
  - `true` / `false`
  - 既定値: `true`

- `HEALTHCHECK_URL`
  - 起動完了判定専用 URL
  - 未設定時は `APP_URL` を使う

- `STARTUP_TIMEOUT_MS`
  - 起動待機タイムアウト
  - 既定値: `30000`

- `STARTUP_POLL_INTERVAL_MS`
  - 起動待機ポーリング間隔
  - 既定値: `250`

- `AUTO_OPEN_BROWSER_DELAY_MS`
  - 起動完了後にブラウザを開くまでの追加待機
  - 既定値: `300`

### 7.3 URL の決定ルール

1. `APP_URL` があれば最優先で使う
2. `APP_URL` がなければ Vite の開発 URL 既定値を使う
3. API サーバー URL を誤って開かないこと

補足:

- Express が `localhost:3000`、Vite が `localhost:5173` のように分かれている場合、自動表示対象は通常 `5173` 側
- 逆プロキシ構成で Express 経由の単一 URL に統合しているなら、その統合 URL を `APP_URL` とする

## 8. 起動シーケンス

### 8.1 基本フロー

1. `npm run dev` が開始される
2. 親 bootstrap が設定を読む
3. `frontend url` と `healthcheck url` を決定する
4. `npm run dev:server` と `npm run dev:client` を子プロセスとして起動する
5. 親 bootstrap が `healthcheck url` に対して起動完了待機を行う
6. 応答可能になったら既定ブラウザで `frontend url` を 1 回だけ開く
7. 以後も親 bootstrap が子プロセスの終了を監視し、どちらかが止まったら全体を終了する

### 8.2 起動完了判定

起動完了は以下のいずれかを満たした時点とする。

- `healthcheck url` へ HTTP アクセスして `200` 台が返る
- `healthcheck url` へ HTTP アクセスして `300` 台が返る

推奨は HTTP 判定である。

理由:

- Vite は起動途中にポートだけ空くより、実際に HTML を返せるかを見る方が安全
- SPA の初期 HTML が返れば、ブラウザ起動条件として十分

## 9. 多重起動防止

### 9.1 必須ルール

ホットリロード、ファイル監視、再コンパイルによってブラウザが複数回開かないこと。

### 9.2 採用手段

- 親 bootstrap だけが auto open を実行する
- `autoOpenBrowser.ts` がプロセス内 `hasOpened` フラグを持つ
- watch 再起動は子プロセス内に閉じる

### 9.3 注意点

`tsx watch` や `vite` の再起動側にブラウザ起動コードを置くとタブが増えやすい。

そのため、`npm run dev` の統括側に auto open を置く。

## 10. 自動表示抑止条件

以下のいずれかに該当する場合はブラウザを開かない。

- `AUTO_OPEN_BROWSER=false`
- `CI=true`
- GUI のないヘッドレス環境
- `APP_URL` または既定 `frontend url` が不正
- 同一開発起動ですでに 1 回開いている

## 11. エラー時の扱い

### 11.1 起動待機タイムアウト

- ブラウザ自動起動はしない
- `npm run dev` 自体は継続する
- ログに警告を出す
- 手動アクセス先として `frontend url` を出す

### 11.2 ブラウザ起動失敗

- `npm run dev` 自体は継続する
- ログに失敗内容を出す
- 手動アクセス先として `frontend url` を出す

### 11.3 URL 解決失敗

- 自動表示はスキップする
- ログに設定不備として出す

## 12. 実装方針

### 12.1 実装配置

- `src/server/dev/openBrowser.*`
  - 既定ブラウザ起動

- `src/server/dev/waitForUrl.*`
  - URL 起動待機

- `src/server/dev/config.*`
  - `APP_URL`、`HEALTHCHECK_URL`、`AUTO_OPEN_BROWSER` などの設定解決

- `src/server/dev/autoOpenBrowser.*`
  - 起動待機、遅延、起動、ログ、多重起動防止

- `src/server/dev/bootstrap-dev.*`
  - `npm run dev` 用の統括処理

責務分離はこの構成で実装済み。

### 12.2 OS ごとのブラウザ起動

macOS:

- `open <url>`

Windows:

- `start <url>`

Linux:

- `xdg-open <url>`

現在実装では追加ライブラリは使わず、Node.js の `child_process.spawn` で OS ごとの既定ブラウザ起動コマンドを呼び出している。

### 12.3 Vite と Express が別プロセスの場合

`healthcheck url` はフロントエンド側を指すこと。

例:

- Express API: `http://localhost:3000`
- Vite frontend: `http://localhost:5173`

この場合:

- `APP_URL=http://localhost:5173`
- `HEALTHCHECK_URL=http://localhost:5173`

とする。

### 12.4 Express 経由の単一 URL 構成の場合

Express が Vite のアセットを仲介し、ユーザーが最終的に `http://localhost:3000` を開く構成なら、以下でよい。

- `APP_URL=http://localhost:3000`
- `HEALTHCHECK_URL=http://localhost:3000`

## 13. 実装メモ

現在の実装ポイント:

- `package.json` の `dev` は `tsx src/server/dev/bootstrap-dev.ts`
- `APP_URL` 未設定時は `http://localhost:5173`
- `HEALTHCHECK_URL` 未設定時は `APP_URL`
- `AUTO_OPEN_BROWSER=false`、`CI=true`、ヘッドレス相当環境、URL不正時はスキップ
- 成功判定は HTTP 200 台または 300 台
- 待機失敗やブラウザ起動失敗でも `npm run dev` 全体は継続
- ログは `resolved appUrl`、`resolved healthcheckUrl`、`waiting for frontend startup`、`startup wait succeeded`、`browser launch succeeded/failed`、`skipped` を出力

参考コードイメージ:

```ts
let hasOpenedBrowser = false;

export async function bootstrapDevAutoOpenBrowser() {
  const appUrl = resolveAppUrl();
  const healthcheckUrl = resolveHealthcheckUrl() ?? appUrl;
  const autoOpen = resolveBooleanEnv("AUTO_OPEN_BROWSER", true);

  if (!autoOpen || process.env.CI === "true" || !appUrl) {
    logInfo("skip auto open browser", { appUrl, autoOpen });
    return;
  }

  if (hasOpenedBrowser) {
    logInfo("browser already opened", { appUrl });
    return;
  }

  const ready = await waitForUrl(healthcheckUrl, {
    timeoutMs: 30000,
    intervalMs: 250,
    successStatus: [200, 201, 202, 204, 301, 302, 307, 308],
  });

  if (!ready) {
    logWarn("frontend did not become ready in time", { appUrl, healthcheckUrl });
    logInfo("open manually if needed", { appUrl });
    return;
  }

  await sleep(300);

  try {
    await openBrowser(appUrl);
    hasOpenedBrowser = true;
    logInfo("browser opened", { appUrl });
  } catch (error) {
    logWarn("failed to open browser", { appUrl, error });
    logInfo("open manually if needed", { appUrl });
  }
}
```

## 14. 受け入れ条件

1. `npm run dev` 実行後、フロントエンドが利用可能になったタイミングでブラウザが自動で開く。
2. 起動待機前にブラウザが開いて白画面や接続失敗にならない。
3. 保存やホットリロードのたびにタブが増えない。
4. `AUTO_OPEN_BROWSER=false` で無効化できる。
5. CI では自動起動しない。
6. 起動失敗時も開発サーバーは継続する。
7. ログから `appUrl`、待機、成功、失敗が確認できる。
