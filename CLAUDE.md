# fit2bsky-cw

Fitbit で測定した体重データを Google Health API から取得し、Bluesky に自動投稿するボット。Cloudflare Workers で稼働。日付はすべて JST で扱う（`src/date.ts`）。

## 技術スタック

- **ランタイム**: Cloudflare Workers
- **フレームワーク**: Hono
- **言語**: TypeScript
- **主な依存**: `@atproto/api`（Bluesky）、`web-auth-library`（シート書き込み用のサービスアカウント認証。Google Health の OAuth は `src/health.ts` が自前で行う）

## ファイル構成

```
src/
├── index.ts      # エントリーポイント、ルーティング、cronハンドラ
├── daily.ts      # その日の処理（体重取得・投稿・シート書き込み）とKVのフラグ。/post・/sheet・cron で共有
├── dashboard.ts  # ダッシュボードのHTML（hono/html でエスケープ）
├── health.ts     # Google Health API連携（Google OAuth2、体重・体脂肪率の取得、BMIの計算）
├── date.ts       # JSTの日付の計算
├── ai.ts         # 投稿に添えるAIコメントの選択
├── comments.ts   # AIコメントの文例
├── bluesky.ts    # Bluesky投稿
├── sheet.ts      # Google Spreadsheet書き込み
├── fx.ts         # ドル円レート取得（Bitfinex API）
└── bindings.d.ts # 環境変数の型定義
```

## エンドポイント

| パス | 説明 |
|------|------|
| `/` | ダッシュボード（ステータス・体重データ・各機能へのリンク） |
| `/auth` | Google Health API の OAuth2 認証開始 |
| `/oauth/callback` | OAuth2コールバック |
| `POST /post` | Bluesky 投稿 + シート書き込み（各 1 日 1 回制限） |
| `POST /sheet` | シートへの書き込みのみ（1 日 1 回制限） |
| `/fx` | ドル円レート表示 |
| `/weight` | 体重データJSON |
| `/status` | 本日の投稿・書き込み状況JSON |
| `/errors` | エラーログ確認（`?date=YYYY-MM-DD`で日付指定可） |

## 定期実行

以下の時間にcron triggerで実行：

| UTC | JST | 動作 |
|-----|-----|------|
| 0:00 | 9:00 | Bluesky投稿 + シート書き込み |
| 3:00 | 12:00 | Bluesky投稿（リトライ） + シート書き込み（リトライ） |
| 12:00 | 21:00 | Bluesky投稿（リトライ） + シート書き込み（リトライ） |

## 動作仕様

### Bluesky投稿
- 全てのcron実行時に未投稿であれば投稿を試みる
- 1 日 1 回のみ投稿（KV で `BSKY_POST_{date}` を管理）。KV は結果整合なので、cron の最中に手で `/post` を実行すると二重に投稿し得るが、個人用の bot なので許容している
- `/post`エンドポイントでも投稿可能（未投稿の場合のみ）

### シート書き込み
- 1日1回のみ書き込み（KVで `SHEET_WRITE_{date}` を管理）
- 全てのcron実行時に未書き込みであれば書き込みを試みる
- `/post`または`/sheet`エンドポイントでも手動実行可能

### エラーハンドリング
- エラーはKVに `ERROR_LOG_{date}` として7日間保存
- `/errors`エンドポイントで確認可能

## 環境変数

### wrangler.toml で設定

| 変数名 | 説明 |
|--------|------|
| `TARGET_WEIGHT` | 目標体重（kg） |
| `HEIGHT_CM` | 身長（cm）。BMI の計算に使う |

### Cloudflare Secrets で設定

| 変数名 | 説明 |
|--------|------|
| `GOOGLE_HEALTH_CLIENT_ID` | Google Health API の OAuth Client ID |
| `GOOGLE_HEALTH_CLIENT_SECRET` | Google Health API の OAuth Client Secret |
| `BSKY_HANDLE` | Blueskyハンドル |
| `BSKY_PASSWORD` | Blueskyパスワード |
| `SHEET_ID` | Google SpreadsheetのID |
| `SHEET_NAME` | 書き込み先シート名 |
| `GOOGLE_CREDENTIALS` | Google Service Account JSON |

## 開発コマンド

```sh
npm run dev           # ローカル開発サーバー
npm run deploy        # デプロイ
npm test              # テスト実行
npm run lint          # ESLintチェック
npm run lint:fix      # ESLint自動修正
npm run format        # Prettierフォーマット
npm run format:check  # フォーマットチェック
npm run cf-typegen    # Cloudflare型定義生成
```

## CI

`.github/workflows/ci.yml` が main への push と PR で `lint`、`format:check`、テスト（`npm test -- --run`）を回す。
デプロイは CI に入れず、手元で `npm run deploy` する。依存の更新は Dependabot（`.github/dependabot.yml`）が
npm と GitHub Actions のそれぞれで週に 1 度、1 本の PR にまとめて出す。

action の `uses:` は完全な版のタグ（`@v7.0.1`）で書き、実際に動く commit は `.github/workflows/actions.lock` が
固定する。lockfile は手で編集しない。`uses:` を変えたら repo のルートで `gh actions-lock` を実行し、workflow と
一緒にコミットする（`verify-lockfile.yml` が検査する。運用の正本は kan/dotfiles の `docs/github-actions.md`）。

## KVキー

| キー | TTL | 説明 |
|------|-----|------|
| `GOOGLE_HEALTH_REFRESH_TOKEN` | なし | Google Health API の OAuth refresh token |
| `BSKY_POST_{date}` | 24h | Bluesky投稿済みフラグ |
| `SHEET_WRITE_{date}` | 24h | シート書き込み済みフラグ |
| `ERROR_LOG_{date}` | 7日 | エラーログ（JSON配列） |
| `MEASUREMENT_STREAK` | なし | 連続記録の日数 |
| `LAST_MEASUREMENT_DATE` | なし | 連続記録を最後に数えた日 |
