# fit2bsky-cw

Fitbitで測定した体重（と体脂肪率）のデータをBlueskyへ投稿するbot。Cloudflare Workersで稼働させることを前提にしている。
おまけで、GoogleSpreadsheetにも体重データを書き込む。

## 動かし方

wranglerでCloudflare Workersへデプロイする。

```sh
npm run deploy
```

Cloudflare secretで以下の変数を設定しておく必要がある。（dashboardか、wrangler secret putで設定）

- CLIENT_ID
- CLIENT_SECRET
- BSKY_HANDLE
- BSKY_PASSWORD
- SHEET_ID
- SHEET_NAME
- GOOGLE_CREDENTIALS

また、Cloudflare KVも作成してwrangler.tomlの設定を書き換える必要がある。

## 使い方

Cloudflare Workersでwebアプリとして（も）動作する。

### /

ダッシュボード。本日のステータス、体重データ、各機能へのリンクを表示する。

### /auth

Fitbit の OAuth2 の認証を行なう。事前にこれを実行しておく。

### /post

Fitbit APIのデータをBlueskyに投稿し、sheetに書き込む。各処理は1日1回のみ実行される。

### /sheet

Fitbit APIのデータをsheetに書き込む。1日1回のみ実行される。

### /weight

Fitbit APIを叩いて当日の体重その他の測定データをJSONで返す。

### /status

本日の投稿・書き込み状況をJSONで返す。

### /errors

エラーログを表示する。`?date=YYYY-MM-DD`で日付指定可能。

### /fx

本日のドル円レートを表示する。

## 定期実行

cron triggerで以下の時間に実行される：

| UTC | JST | 動作 |
|-----|-----|------|
| 0:00 | 9:00 | Bluesky投稿 + シート書き込み |
| 3:00 | 12:00 | シート書き込みのみ（リトライ） |
| 12:00 | 21:00 | シート書き込みのみ（リトライ） |

9:00時点で体重データがない場合、12:00と21:00にシート書き込みを再試行する。Bluesky投稿は9:00のみ。

## 開発

```sh
npm run dev           # ローカル開発サーバー
npm run deploy        # デプロイ
npm test              # テスト実行
npm run lint          # ESLintチェック
npm run format        # Prettierフォーマット
```
