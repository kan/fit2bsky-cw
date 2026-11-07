# fit2bsky-cw

Fitbit で測定した体重データを Google Health API から取得し、Bluesky に自動投稿するボット。Cloudflare Workers で稼働。日付はすべて JST で扱う（`src/date.ts`）。

## 技術スタック

- **ランタイム**: Cloudflare Workers
- **フレームワーク**: Hono
- **言語**: TypeScript
- **主な依存**:
  - `@atproto/api`（Bluesky）
  - `@anthropic-ai/sdk`（AI コメントの生成）
  - `jose`（シート書き込み用のサービスアカウントの JWT の署名。token との交換は `src/sheet.ts` が行う。Google Health の OAuth は `src/health.ts` が自前で行う）

## ファイル構成

```
src/
├── index.ts      # エントリーポイント、ルーティング、cronハンドラ
├── daily.ts      # その日の処理（体重取得・投稿・シート書き込み）とKVのフラグ。/post・/sheet・cron で共有
├── dashboard.ts  # ダッシュボードのHTML（hono/html でエスケープ）
├── health.ts     # Google Health API連携（Google OAuth2、体重・体脂肪率の取得、BMIの計算）
├── date.ts       # JSTの日付の計算
├── ai.ts         # 投稿に添えるAIコメントの生成（Claude のプロンプトと応答の検査）
├── comments.ts   # AIコメントの文例（生成に失敗したときに使う）
├── bluesky.ts    # Bluesky投稿
├── sheet.ts      # Google Spreadsheet書き込み
├── fx.ts         # ドル円レート取得（Bitfinex API）
└── http.ts       # 外部 API の fetch に共通のタイムアウトとエラー（fetchOk / fetchWithTimeout）
```

外部 API は `src/http.ts` の `fetchOk`（2xx 以外やタイムアウトを、label 付きの例外にする）か `fetchWithTimeout` を
通して呼ぶ。素の `fetch` はタイムアウトが付かないので、src では ESLint が止める。fetch を差し替えられるライブラリ
（`@atproto/api` の `CredentialSession` など）にも `fetchWithTimeout` を渡す。

環境変数の型は、`wrangler.jsonc` から `npm run cf-typegen`（`wrangler types --strict-vars=false`）で生成した
`worker-configuration.d.ts` のグローバルな `Env` を使う。`Env` を手で書かない。生成したファイルは commit し、
`wrangler.jsonc` を変えたら作り直す（CI の `npm run typecheck` が `wrangler types --check` で検査する）。
`--check` は生成に使った workerd の版も比べるので、wrangler を上げる Dependabot の PR は CI が落ちる。
その PR のブランチで `npm run cf-typegen` を実行し、`worker-configuration.d.ts` を commit して直す。

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

### AI コメント
- 投稿の末尾の `AI「…」` は、Claude（モデルは `src/ai.ts` の `MODEL`）がその日の体重と、前日、1 か月前、
  1 年前との差、目標までの残り、連続記録の日数から作る。モデルを選んだときの比較（Workers AI、OpenAI など）は #8 にある
- 作るのは投稿するときだけで、1 日 1 回。作ったコメントは KV の `AI_COMMENT_{date}` に保存し、投稿の再試行と
  ダッシュボードで使い回す。ダッシュボードは保存済みのものを表示するだけで、生成しない
- 安全の判定で拒否されたときは、API が別のモデルで作り直す（server-side fallback、`fallbacks: 'default'`）
- API のエラー、作り直しも含めた拒否、60 字超え、JSON でない応答のときは `src/comments.ts` の文例から選んで投稿し、
  エラーログ（context は `ai_comment`）に残す。文例は投稿に成功したときだけ KV に保存する（投稿が失敗したら、
  再試行のときに Claude で作り直す）

### シート書き込み
- 1日1回のみ書き込み（KVで `SHEET_WRITE_{date}` を管理）
- 全てのcron実行時に未書き込みであれば書き込みを試みる
- `/post`または`/sheet`エンドポイントでも手動実行可能

### エラーハンドリング
- エラーはKVに `ERROR_LOG_{date}` として7日間保存
- `/errors`エンドポイントで確認可能
- 同じエラーを `console.error` にも出す。Workers Logs（`wrangler.jsonc` の `observability`）に cron の実行と合わせて残る。
  ダッシュボードのエラー件数と `/status` の `hasErrors` は KV の方を読む
- `/fx`、`/weight`、ダッシュボードでの体重の取得の失敗は、`console.error` だけに出す（ダッシュボードは表示のたびに
  体重を取るので、KV に入れると件数が膨らむ）

## 環境変数

### wrangler.jsonc の vars で設定

| 変数名 | 説明 |
|--------|------|
| `TARGET_WEIGHT` | 目標体重（kg） |
| `HEIGHT_CM` | 身長（cm）。BMI の計算に使う |

### Cloudflare Secrets で設定

名前は `wrangler.jsonc` の `secrets.required` にも並べてある。deploy の時点で未設定のものがあれば止まる。

| 変数名 | 説明 |
|--------|------|
| `GOOGLE_HEALTH_CLIENT_ID` | Google Health API の OAuth Client ID |
| `GOOGLE_HEALTH_CLIENT_SECRET` | Google Health API の OAuth Client Secret |
| `BSKY_HANDLE` | Blueskyハンドル |
| `BSKY_PASSWORD` | Blueskyパスワード |
| `SHEET_ID` | Google SpreadsheetのID |
| `SHEET_NAME` | 書き込み先シート名 |
| `GOOGLE_CREDENTIALS` | Google Service Account JSON |
| `ANTHROPIC_API_KEY` | Claude API のキー。bot 専用のワークスペースで発行し、月の上限を付けておく |

## 開発コマンド

```sh
npm run dev           # ローカル開発サーバー
npm run deploy        # デプロイ
npm test              # テスト実行
npm run lint          # ESLintチェック
npm run lint:fix      # ESLint自動修正
npm run format        # Prettierフォーマット
npm run format:check  # フォーマットチェック
npm run cf-typegen    # Cloudflare型定義生成（worker-configuration.d.ts）
npm run typecheck     # 生成した型の鮮度、src と test の型を検査
```

## テスト

`test/` は `@cloudflare/vitest-plugin` の上で動き、外部 API（Google Health、Bluesky、Sheets、Bitfinex、Claude）は
`@msw/cloudflare` でモックする。ハンドラは `test/helpers.ts` の `mockHealth`、`mockDaily` などにまとめてある。
`test/setup.ts` は受け皿のハンドラを初期のハンドラとして置く。モックの無いリクエストは本物へ出ず、
599 が返る。`setupNetwork()` はハンドラの無いリクエストをそのまま本物へ通すので、この受け皿は外さない。
KV は各テストの後で `reset()` して空にする。`setup.ts` は時刻も JST 2026-11-07 9:00 で固定する
（`vi.useFakeTimers({ toFake: ['Date'] })`）。別の時刻が要るテストは `vi.setSystemTime()` でずらす。

## CI

`.github/workflows/ci.yml` が main への push と PR で `lint`、`format:check`、テスト（`npm test -- --run`）と `typecheck` を回す。
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
| `AI_COMMENT_{date}` | 24h | その日の AI コメント |
| `MEASUREMENT_STREAK` | なし | 連続記録の日数 |
| `LAST_MEASUREMENT_DATE` | なし | 連続記録を最後に数えた日 |
