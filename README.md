# fit2bsky-cw

Fitbit で測定した体重（と体脂肪率）のデータを、Google Health API から取得して Bluesky へ投稿する bot。Cloudflare Workers で稼働させることを前提にしている。
おまけで、GoogleSpreadsheetにも体重データを書き込む。

## 動かし方

wranglerでCloudflare Workersへデプロイする。

```sh
npm run deploy
```

Cloudflare secretで以下の変数を設定しておく必要がある。（dashboardか、wrangler secret putで設定）

- GOOGLE_HEALTH_CLIENT_ID（Google Health API 用の OAuth クライアント）
- GOOGLE_HEALTH_CLIENT_SECRET
- BSKY_HANDLE
- BSKY_PASSWORD
- SHEET_ID
- SHEET_NAME
- GOOGLE_CREDENTIALS
- ANTHROPIC_API_KEY（投稿に添えるコメントを Claude に作らせる）

この一覧は `wrangler.jsonc` の `secrets.required` にもあり、未設定のものがあると deploy が止まる。

また、Cloudflare KV も作成して wrangler.jsonc の設定を書き換える必要がある。BMI は体重と wrangler.jsonc の `HEIGHT_CM`（身長）から計算する。

`ANTHROPIC_API_KEY` は、Claude Console で bot 専用のワークスペースを作り、月の利用額の上限を付けてから、そのワークスペースで発行する（Default ワークスペースには上限を付けられない）。キーが使えなくなっても投稿は止まらず、文例のコメントで投稿してエラーログに残る。期限付きのキーにしたときは、切れる前に `wrangler secret put ANTHROPIC_API_KEY` で入れ替える。

Google Health API の OAuth クライアントは、Google Cloud で Google Health API を有効にしたうえで「ウェブアプリケーション」として作り、redirect URI に `<デプロイ先>/oauth/callback` を登録する。同意画面の公開状態が「テスト」のままだと refresh token が 7 日で切れるので、「本番」にする。

## 使い方

Cloudflare Workersでwebアプリとして（も）動作する。

### /

ダッシュボード。本日のステータス、体重データ、各機能へのリンクを表示する。

### /auth

Google Health API の OAuth2 の認証を行なう。事前にこれを実行しておく。

### POST /post

体重データを Bluesky に投稿し、sheet に書き込む。各処理は 1 日 1 回のみ実行される。

### POST /sheet

体重データを sheet に書き込む。1 日 1 回のみ実行される。

### POST /comment/test

今日の材料で、投稿に添えるコメントを試しに作って表示する。ダッシュボードから、Claude のモデル（本番のモデルと、その fallback 先）か文例を選んで実行する。作ったコメントは保存せず、投稿にも使わない。Claude を選ぶと API の料金がかかる。

### /weight

Google Health API を叩いて当日（JST）の体重その他の測定データを JSON で返す。

### /status

本日の投稿・書き込み状況をJSONで返す。

### /errors

エラーログを表示する。`?date=YYYY-MM-DD`で日付指定可能。

### /fx

本日のドル円レートを表示する。

## 定期実行

cron trigger で次の時間に実行される。

| UTC | JST | 動作 |
|-----|-----|------|
| 0:00 | 9:00 | Bluesky 投稿 + シート書き込み |
| 3:00 | 12:00 | 未完了なら Bluesky 投稿とシート書き込みを再試行 |
| 12:00 | 21:00 | 未完了なら Bluesky 投稿とシート書き込みを再試行 |

投稿とシート書き込みがどちらも済んでいれば、体重を取得せずに終わる。

## 開発

```sh
npm run dev           # ローカル開発サーバー
npm run deploy        # デプロイ
npm test              # テスト実行
npm run lint          # ESLintチェック
npm run typecheck     # 型検査
npm run format        # Prettierフォーマット
```
