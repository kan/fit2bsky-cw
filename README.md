# fit2bsky-cw

fitbitで測定した体重(と体脂肪率)のデータをblueskyへ投稿するbot. Cloudflare Workersで稼働させることを前提にしている。
おまけで、某所のGoogleSpreadsheetにも体重データを書き込む。

# 動かし方

wranglerでCloudflare Workersへデプロイする。

```sh
wrangler deploy
```

Cloudflare secretで以下の変数を設定しておく必要がある。(dashboardか、wrangler secret putで設定)

- CLIENT_ID
- CLIENT_SECRET
- BSKY_HANDLE
- BSKY_PASSWORD
- SHEET_ID
- SHEET_NAME
- GOOGLE_CREDENTIALS

また、Cloudflare KVも作成してwrangler.tomlの設定を書き換える必要がある。

# 使い方

Cloudflare Workersでwebアプリとして(も)動作する。

## /

fitbit APIを叩いて当日の体重その他の測定データを表示する。

## /auth

fitbit の OAuth2 の認証を行なう。事前にこれを実行しておく。

## /post

fitbit APIのデータをblueskyに投稿し、sheetに書き込む。cron triggerで実行する内容と同じ。

## /sheet

fitbit APIのデータをsheetに書き込む。

# 定期実行

cron triggerのhandlerが定義されているので、wrangler.tomlの中で実行タイミングを指定すれば、その時間に実行される。
標準では朝9時ちょうどに実行する。
