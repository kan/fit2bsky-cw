import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import health, { WeightRecord } from './health';
import bluesky from './bluesky';
import sheet from './sheet';
import { getJPYRate } from './fx';
import { generateComment, WeightContext } from './ai';
import { Bindings } from './bindings';
import { jstDate } from './date';

const app = new Hono<{ Bindings: Bindings }>();

const BSKY_POST_KEY_PREFIX = 'BSKY_POST_';
const SHEET_WRITE_KEY_PREFIX = 'SHEET_WRITE_';
const ERROR_LOG_KEY_PREFIX = 'ERROR_LOG_';
const STREAK_KEY = 'MEASUREMENT_STREAK';
const LAST_MEASUREMENT_KEY = 'LAST_MEASUREMENT_DATE';
const OAUTH_STATE_COOKIE = 'oauth_state';

function getToday(): string {
	return jstDate();
}

async function logError(kv: KVNamespace, context: string, error: unknown): Promise<void> {
	const day = getToday();
	const key = `${ERROR_LOG_KEY_PREFIX}${day}`;
	const existing = await kv.get(key);
	const logs = existing ? JSON.parse(existing) : [];
	logs.push({
		timestamp: new Date().toISOString(),
		context,
		error: error instanceof Error ? error.message : String(error),
	});
	await kv.put(key, JSON.stringify(logs), { expirationTtl: 86400 * 7 });
}

async function isBlueskyPosted(kv: KVNamespace): Promise<boolean> {
	const day = getToday();
	return (await kv.get(`${BSKY_POST_KEY_PREFIX}${day}`)) !== null;
}

async function markBlueskyPosted(kv: KVNamespace): Promise<void> {
	const day = getToday();
	await kv.put(`${BSKY_POST_KEY_PREFIX}${day}`, 'posted', { expirationTtl: 86400 });
}

async function isSheetWritten(kv: KVNamespace): Promise<boolean> {
	const day = getToday();
	return (await kv.get(`${SHEET_WRITE_KEY_PREFIX}${day}`)) !== null;
}

async function markSheetWritten(kv: KVNamespace): Promise<void> {
	const day = getToday();
	await kv.put(`${SHEET_WRITE_KEY_PREFIX}${day}`, 'written', { expirationTtl: 86400 });
}

async function getStreak(kv: KVNamespace): Promise<number> {
	const streak = await kv.get(STREAK_KEY);
	return streak ? parseInt(streak, 10) : 0;
}

async function updateStreak(kv: KVNamespace): Promise<number> {
	const today = getToday();
	const lastDate = await kv.get(LAST_MEASUREMENT_KEY);
	let streak = await getStreak(kv);

	if (lastDate === today) {
		return streak;
	}

	if (lastDate === jstDate(-1)) {
		streak += 1;
	} else {
		streak = 1;
	}

	await kv.put(STREAK_KEY, streak.toString());
	await kv.put(LAST_MEASUREMENT_KEY, today);

	return streak;
}

function formatFat(fat: number | null): string {
	return fat !== null ? `${fat.toFixed(2)}%` : '-';
}

function formatPostMessage(weight: WeightRecord, streakDays: number, jpy: number, aiComment: string): string {
	return `今日の体重: ${weight.weight.toFixed(1)}kg (BMI: ${weight.bmi.toFixed(2)}) 体脂肪率: ${formatFat(weight.fat)}
連続${streakDays}日目 | 1$=${jpy.toFixed(1)}円

AI「${aiComment}」`;
}

async function buildWeightContext(env: Bindings, token: string, current: WeightRecord, streakDays: number): Promise<WeightContext> {
	const oneMonthAgo = await health.getWeight(env, token, jstDate(-30)).catch(() => null);
	const targetWeight = parseFloat(env.TARGET_WEIGHT);

	return {
		current,
		oneMonthAgo,
		targetWeight,
		streakDays,
	};
}

/** access token を 1 回だけ取り、今日の体重を取る。token は続く取得で使い回し、day はシートの行に使う。 */
async function getTodayWeight(env: Bindings): Promise<{ token: string; day: string; data: WeightRecord }> {
	const day = getToday();
	const token = await health.getAccessToken(env);
	const data = await health.getWeight(env, token, day);
	return { token, day, data };
}

app.get('/auth', (c) => {
	const state = crypto.randomUUID();
	setCookie(c, OAUTH_STATE_COOKIE, state, { path: '/oauth', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600 });
	return c.redirect(health.getAuthURL(c.env, c.req.url, state));
});

app.get('/oauth/callback', async (c) => {
	const expectedState = getCookie(c, OAUTH_STATE_COOKIE);
	deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/oauth' });
	if (!expectedState || c.req.query('state') !== expectedState) {
		return c.text('state が一致しません。/auth からやり直してください', 400);
	}

	const error = c.req.query('error');
	if (error) {
		return c.text(`認可されませんでした: ${error}`, 400);
	}
	const code = c.req.query('code');
	if (!code) {
		return c.text('認証コードを取得できませんでした', 400);
	}

	try {
		await health.exchangeCode(c.env, c.req.url, code);
		return c.text('Google Health の refresh token を保存しました');
	} catch (e) {
		await logError(c.env.FIT2BSKY_KV, 'oauth_callback', e);
		return c.text('Error: ' + e, 500);
	}
});

app.get('/post', async (c) => {
	const results: string[] = [];

	try {
		const { token, day, data } = await getTodayWeight(c.env);
		const streakDays = await updateStreak(c.env.FIT2BSKY_KV);

		// Bluesky投稿（未投稿の場合のみ）
		if (await isBlueskyPosted(c.env.FIT2BSKY_KV)) {
			results.push('Bluesky: 本日は投稿済みです');
		} else {
			try {
				const jpy = await getJPYRate();
				const context = await buildWeightContext(c.env, token, data, streakDays);
				const aiComment = generateComment(context);
				const msg = formatPostMessage(data, streakDays, jpy, aiComment);
				await bluesky.postMessage(c.env, msg);
				await markBlueskyPosted(c.env.FIT2BSKY_KV);
				results.push('Bluesky: 投稿完了');
				results.push(`AIコメント: ${aiComment}`);
			} catch (e) {
				await logError(c.env.FIT2BSKY_KV, 'bluesky_post', e);
				results.push(`Bluesky: エラー - ${e}`);
			}
		}

		// シート書き込み（未書き込みの場合のみ）
		if (await isSheetWritten(c.env.FIT2BSKY_KV)) {
			results.push('Sheet: 本日は書き込み済みです');
		} else {
			try {
				await sheet.Update(c.env, day, data.weight);
				await markSheetWritten(c.env.FIT2BSKY_KV);
				results.push('Sheet: 書き込み完了');
			} catch (e) {
				await logError(c.env.FIT2BSKY_KV, 'sheet_write', e);
				results.push(`Sheet: エラー - ${e}`);
			}
		}

		return c.text(results.join('\n'));
	} catch (e) {
		await logError(c.env.FIT2BSKY_KV, 'health_get_weight', e);
		return c.text('Error: ' + e, 500);
	}
});

app.get('/sheet', async (c) => {
	try {
		if (await isSheetWritten(c.env.FIT2BSKY_KV)) {
			return c.text('本日は書き込み済みです');
		}

		const { day, data } = await getTodayWeight(c.env);
		await sheet.Update(c.env, day, data.weight);
		await markSheetWritten(c.env.FIT2BSKY_KV);
		return c.text('シートへの書き込みが完了しました');
	} catch (e) {
		await logError(c.env.FIT2BSKY_KV, 'sheet_write', e);
		return c.text('Error: ' + e, 500);
	}
});

app.get('/fx', async (c) => {
	try {
		const jpy = await getJPYRate();
		return c.text(`${jpy.toFixed(1)}円`);
	} catch (e) {
		return c.text('Error: ' + e, 500);
	}
});

app.get('/errors', async (c) => {
	const day = c.req.query('date') || getToday();
	const key = `${ERROR_LOG_KEY_PREFIX}${day}`;
	const logs = await c.env.FIT2BSKY_KV.get(key);
	if (!logs) {
		return c.text('エラーログはありません');
	}
	return c.json(JSON.parse(logs));
});

app.get('/status', async (c) => {
	const day = getToday();
	const bskyPosted = await isBlueskyPosted(c.env.FIT2BSKY_KV);
	const sheetWritten = await isSheetWritten(c.env.FIT2BSKY_KV);
	const errorKey = `${ERROR_LOG_KEY_PREFIX}${day}`;
	const errors = await c.env.FIT2BSKY_KV.get(errorKey);

	return c.json({
		date: day,
		blueskyPosted: bskyPosted,
		sheetWritten: sheetWritten,
		hasErrors: errors !== null,
	});
});

app.get('/weight', async (c) => {
	try {
		const { data } = await getTodayWeight(c.env);
		return c.json(data);
	} catch (e) {
		return c.text('Error: ' + e, 500);
	}
});

app.get('/', async (c) => {
	const day = getToday();
	const bskyPosted = await isBlueskyPosted(c.env.FIT2BSKY_KV);
	const sheetWritten = await isSheetWritten(c.env.FIT2BSKY_KV);
	const errorKey = `${ERROR_LOG_KEY_PREFIX}${day}`;
	const errorLogs = await c.env.FIT2BSKY_KV.get(errorKey);
	const hasErrors = errorLogs !== null;
	const errorCount = hasErrors ? JSON.parse(errorLogs).length : 0;
	const streakDays = await getStreak(c.env.FIT2BSKY_KV);
	const targetWeight = parseFloat(c.env.TARGET_WEIGHT);

	let weightData = null;
	let weightError = null;
	let aiComment = null;
	let diffFromTarget = null;
	try {
		const { token, data } = await getTodayWeight(c.env);
		weightData = data;
		diffFromTarget = weightData.weight - targetWeight;
		const context = await buildWeightContext(c.env, token, weightData, streakDays);
		aiComment = generateComment(context);
	} catch (e) {
		weightError = e instanceof Error ? e.message : String(e);
	}

	const html = `<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>fit2bsky-cw Dashboard</title>
	<style>
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
		.links a {
			display: inline-block;
			padding: 10px 20px;
			background: #1a85ff;
			color: white;
			text-decoration: none;
			border-radius: 6px;
			font-size: 0.9em;
		}
		.links a:hover { background: #1570d6; }
		.links a.secondary { background: #6b7280; }
		.links a.secondary:hover { background: #4b5563; }
		.links a.danger { background: #ef4444; }
		.links a.danger:hover { background: #dc2626; }
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
		.target-info { color: #666; font-size: 0.9em; margin-top: 10px; }
		.diff-positive { color: #ef4444; }
		.diff-negative { color: #22c55e; }
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
				<td class="${bskyPosted ? 'status-ok' : 'status-ng'}">${bskyPosted ? '投稿済み' : '未投稿'}</td>
			</tr>
			<tr>
				<th>シート書き込み</th>
				<td class="${sheetWritten ? 'status-ok' : 'status-ng'}">${sheetWritten ? '書き込み済み' : '未書き込み'}</td>
			</tr>
			<tr>
				<th>エラー</th>
				<td class="${hasErrors ? 'status-warn' : 'status-ok'}">${hasErrors ? errorCount + '件のエラー' : 'なし'}</td>
			</tr>
		</table>
	</div>

	<div class="card">
		<h2>本日の体重データ</h2>
		${
			weightData
				? `<table>
			<tr><th>体重</th><td><strong>${weightData.weight.toFixed(1)} kg</strong></td></tr>
			<tr><th>BMI</th><td>${weightData.bmi.toFixed(2)}</td></tr>
			<tr><th>体脂肪率</th><td>${formatFat(weightData.fat)}</td></tr>
			<tr><th>測定時刻</th><td>${weightData.time}</td></tr>
			<tr><th>目標体重</th><td>${targetWeight.toFixed(1)} kg</td></tr>
			<tr><th>目標との差</th><td class="${diffFromTarget !== null && diffFromTarget > 0 ? 'diff-positive' : 'diff-negative'}">${diffFromTarget !== null ? (diffFromTarget > 0 ? '+' : '') + diffFromTarget.toFixed(1) : '-'} kg</td></tr>
			<tr><th>連続記録</th><td>${streakDays} 日</td></tr>
		</table>
		${aiComment ? `<div class="ai-comment">💬 ${aiComment}</div>` : ''}`
				: `<p class="status-ng">データ取得エラー: ${weightError}</p>`
		}
	</div>

	<div class="card">
		<h2>アクション</h2>
		<div class="links">
			<a href="/post">投稿実行</a>
			<a href="/sheet" class="secondary">シート書き込み</a>
			<a href="/auth" class="secondary">Google Health認証</a>
		</div>
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

	return c.html(html);
});

const scheduled: ExportedHandlerScheduledHandler<Bindings> = async (_event, env) => {
	const today = await getTodayWeight(env).catch(async (e) => {
		await logError(env.FIT2BSKY_KV, 'scheduled_health_get_weight', e);
		return null;
	});
	if (!today) {
		return;
	}
	const { token, day, data } = today;

	const streakDays = await updateStreak(env.FIT2BSKY_KV);

	// Bluesky投稿（未投稿の場合のみ）
	if (!(await isBlueskyPosted(env.FIT2BSKY_KV))) {
		try {
			const jpy = await getJPYRate();
			const context = await buildWeightContext(env, token, data, streakDays);
			const aiComment = generateComment(context);
			const msg = formatPostMessage(data, streakDays, jpy, aiComment);
			await bluesky.postMessage(env, msg);
			await markBlueskyPosted(env.FIT2BSKY_KV);
		} catch (e) {
			await logError(env.FIT2BSKY_KV, 'scheduled_bluesky_post', e);
		}
	}

	// シート書き込み（未書き込みの場合のみ）
	if (!(await isSheetWritten(env.FIT2BSKY_KV))) {
		try {
			await sheet.Update(env, day, data.weight);
			await markSheetWritten(env.FIT2BSKY_KV);
		} catch (e) {
			await logError(env.FIT2BSKY_KV, 'scheduled_sheet_write', e);
		}
	}
};

export default {
	fetch: app.fetch,
	scheduled,
};
