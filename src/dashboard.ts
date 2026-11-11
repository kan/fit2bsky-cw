import { html, raw } from 'hono/html';
import { WeightRecord } from './health';
import { DailyStatus, formatFat } from './daily';
import { AiComment, TEST_MODELS, formatComment } from './ai';

export interface DashboardProps {
	day: string;
	status: DailyStatus;
	errorCount: number;
	streakDays: number;
	targetWeight: number;
	weight: WeightRecord | null;
	weightError: string | null;
	aiComment: AiComment | null;
}

const STYLE = `
	* { box-sizing: border-box; }
	body {
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		max-width: 800px;
		margin: 0 auto;
		padding: 20px;
		background: #f5f5f5;
		color: #333;
	}
	h1 { color: #1a85ff; margin-bottom: 10px; }
	.subtitle { color: #666; margin-bottom: 30px; }
	.card {
		background: white;
		border-radius: 8px;
		padding: 20px;
		margin-bottom: 20px;
		box-shadow: 0 2px 4px rgba(0,0,0,0.1);
	}
	.card h2 { margin-top: 0; color: #444; font-size: 1.2em; }
	table { width: 100%; border-collapse: collapse; }
	th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
	th { color: #666; font-weight: normal; width: 40%; }
	.status-ok { color: #22c55e; font-weight: bold; }
	.status-ng { color: #ef4444; font-weight: bold; }
	.status-warn { color: #f59e0b; font-weight: bold; }
	.links { display: flex; flex-wrap: wrap; gap: 10px; }
	.links form { margin: 0; }
	.links a, .links button {
		display: inline-block;
		padding: 10px 20px;
		background: #1a85ff;
		color: white;
		text-decoration: none;
		border: none;
		border-radius: 6px;
		font: inherit;
		font-size: 0.9em;
		cursor: pointer;
	}
	.links a:hover, .links button:hover { background: #1570d6; }
	.links .secondary { background: #6b7280; }
	.links .secondary:hover { background: #4b5563; }
	.links select { padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font: inherit; font-size: 0.9em; }
	.note { color: #666; font-size: 0.9em; margin-top: 0; }
	.footer { text-align: center; margin-top: 30px; color: #888; font-size: 0.9em; }
	.footer a { color: #1a85ff; }
	.ai-comment {
		background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
		color: white;
		padding: 15px 20px;
		border-radius: 8px;
		font-size: 1.1em;
		margin-top: 15px;
	}
	.diff-positive { color: #ef4444; }
	.diff-negative { color: #22c55e; }
`;

function statusCell(ok: boolean, okText: string, ngText: string) {
	return html`<td class="${ok ? 'status-ok' : 'status-ng'}">${ok ? okText : ngText}</td>`;
}

function weightCard(props: DashboardProps) {
	const { weight, weightError, targetWeight, streakDays, aiComment } = props;
	if (!weight) {
		return html`<p class="status-ng">データ取得エラー: ${weightError}</p>`;
	}
	const diff = weight.weight - targetWeight;
	return html`<table>
			<tr>
				<th>体重</th>
				<td><strong>${weight.weight.toFixed(1)} kg</strong></td>
			</tr>
			<tr>
				<th>BMI</th>
				<td>${weight.bmi.toFixed(2)}</td>
			</tr>
			<tr>
				<th>体脂肪率</th>
				<td>${formatFat(weight.fat)}</td>
			</tr>
			<tr>
				<th>測定時刻</th>
				<td>${weight.time}</td>
			</tr>
			<tr>
				<th>目標体重</th>
				<td>${targetWeight.toFixed(1)} kg</td>
			</tr>
			<tr>
				<th>目標との差</th>
				<td class="${diff > 0 ? 'diff-positive' : 'diff-negative'}">${(diff > 0 ? '+' : '') + diff.toFixed(1)} kg</td>
			</tr>
			<tr>
				<th>連続記録</th>
				<td>${streakDays} 日</td>
			</tr>
		</table>
		${aiComment ? html`<div class="ai-comment">💬 ${formatComment(aiComment)}</div>` : ''}`;
}

/** ダッシュボードの HTML。埋め込む値は html タグがエスケープする。 */
export function renderDashboard(props: DashboardProps) {
	const { day, status, errorCount } = props;
	return html`<!DOCTYPE html>
		<html lang="ja">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>fit2bsky-cw Dashboard</title>
				<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
				<style>
					${raw(STYLE)}
				</style>
			</head>
			<body>
				<h1>fit2bsky-cw</h1>
				<p class="subtitle">Google Health（Fitbit）体重データ → Bluesky投稿 Bot</p>

				<div class="card">
					<h2>本日のステータス (${day})</h2>
					<table>
						<tr>
							<th>Bluesky投稿</th>
							${statusCell(status.blueskyPosted, '投稿済み', '未投稿')}
						</tr>
						<tr>
							<th>シート書き込み</th>
							${statusCell(status.sheetWritten, '書き込み済み', '未書き込み')}
						</tr>
						<tr>
							<th>エラー</th>
							<td class="${errorCount > 0 ? 'status-warn' : 'status-ok'}">${errorCount > 0 ? `${errorCount}件のエラー` : 'なし'}</td>
						</tr>
					</table>
				</div>

				<div class="card">
					<h2>本日の体重データ</h2>
					${weightCard(props)}
				</div>

				<div class="card">
					<h2>アクション</h2>
					<div class="links">
						<form method="post" action="/post"><button type="submit">投稿実行</button></form>
						<form method="post" action="/sheet"><button type="submit" class="secondary">シート書き込み</button></form>
						<a href="/auth" class="secondary">Google Health認証</a>
					</div>
				</div>

				<div class="card">
					<h2>コメントのテスト生成</h2>
					<p class="note">今日の材料で作ります。保存も投稿もしません（Claude を選ぶと API の料金がかかります）</p>
					<form method="post" action="/comment/test" class="links">
						<select name="source">
							${TEST_MODELS.map((m) => html`<option value="${m}">${m}</option>`)}
							<option value="template">定型文（src/comments.ts）</option>
						</select>
						<button type="submit" class="secondary">試しに作る</button>
					</form>
				</div>

				<div class="card">
					<h2>データ・ログ</h2>
					<div class="links">
						<a href="/status" class="secondary">ステータスJSON</a>
						<a href="/weight" class="secondary">体重データJSON</a>
						<a href="/errors" class="secondary">エラーログ</a>
						<a href="/fx" class="secondary">為替レート</a>
					</div>
				</div>

				<div class="footer">
					<a href="https://github.com/kan/fit2bsky-cw" target="_blank">GitHub Repository</a>
				</div>
			</body>
		</html>`;
}
