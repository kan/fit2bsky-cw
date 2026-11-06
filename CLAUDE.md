# fit2bsky-cw

Fitbitで測定した体重データをBlueskyに自動投稿するボット。Cloudflare Workersで稼働。

## 技術スタック

- **ランタイム**: Cloudflare Workers
- **フレームワーク**: Hono
- **言語**: TypeScript
- **主な依存**: `@atproto/api`（Bluesky）、`web-auth-library`（Google認証）

## ファイル構成

```
src/
├── index.ts      # エントリーポイント、ルーティング、cronハンドラ、ダッシュボード
├── fitbit.ts     # Fitbit API連携（OAuth2、体重取得）
├── bluesky.ts    # Bluesky投稿
├── sheet.ts      # Google Spreadsheet書き込み
├── fx.ts         # ドル円レート取得（Bitfinex API）
└── bindings.d.ts # 環境変数の型定義
```

## エンドポイント

| パス | 説明 |
|------|------|
| `/` | ダッシュボード（ステータス・体重データ・各機能へのリンク） |
| `/auth` | Fitbit OAuth2認証開始 |
| `/oauth/callback` | OAuth2コールバック |
| `/post` | Bluesky投稿 + シート書き込み（各1日1回制限） |
| `/sheet` | シートへの書き込みのみ（1日1回制限） |
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
- 1日1回のみ投稿（KVで `BSKY_POST_{date}` を管理）
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
| `BASE_URL` | アプリケーションのベースURL |

### Cloudflare Secrets で設定

| 変数名 | 説明 |
|--------|------|
| `CLIENT_ID` | Fitbit OAuth Client ID |
| `CLIENT_SECRET` | Fitbit OAuth Client Secret |
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
| `FITBIT_REFRESH_TOKEN` | なし | Fitbit OAuth refresh token |
| `BSKY_POST_{date}` | 24h | Bluesky投稿済みフラグ |
| `SHEET_WRITE_{date}` | 24h | シート書き込み済みフラグ |
| `ERROR_LOG_{date}` | 7日 | エラーログ（JSON配列） |
