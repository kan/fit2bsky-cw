import { Hono } from 'hono';
import fitbit from './fitbit';
import bluesky from './bluesky';
import sheet from './sheet';
import { getJPYRate } from './fx';
import { Bindings } from './bindings';

const app = new Hono<{ Bindings: Bindings }>();

const BSKY_POST_KEY_PREFIX = 'BSKY_POST_';
const SHEET_WRITE_KEY_PREFIX = 'SHEET_WRITE_';
const ERROR_LOG_KEY_PREFIX = 'ERROR_LOG_';

function getToday(): string {
	return new Date().toISOString().split('T')[0];
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

app.get('/auth', (c) => {
	return c.redirect(fitbit.GetAuthURL(c.env, c.req.url));
});

app.get('/oauth/callback', async (c) => {
	const code = c.req.query('code');
	if (!code) {
		return c.text('認証コードを取得できませんでした', 400);
	}

	try {
		await fitbit.SetAccessToken(c.env, c.req.url, code);
		return c.text('fitbitアクセストークンを取得しました');
	} catch (e) {
		return c.text('Error: ' + e, 500);
	}
});

app.get('/post', async (c) => {
	const results: string[] = [];

	try {
		const data = await fitbit.GetWeight(c.env, c.req.url, new Date());

		// Bluesky投稿（未投稿の場合のみ）
		if (await isBlueskyPosted(c.env.FIT2BSKY_KV)) {
			results.push('Bluesky: 本日は投稿済みです');
		} else {
			try {
				const jpy = await getJPYRate();
				const msg = `今日の体重: ${data.weight.toFixed(1)}kg (BMI: ${data.bmi.toFixed(2)} ) 体脂肪率: ${data.fat.toFixed(2)}% via Fitbit\n本日の1ドル: ${jpy.toFixed(1)}円`;
				await bluesky.postMessage(c.env, msg);
				await markBlueskyPosted(c.env.FIT2BSKY_KV);
				results.push('Bluesky: 投稿完了');
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
				await sheet.Update(c.env, data.weight);
				await markSheetWritten(c.env.FIT2BSKY_KV);
				results.push('Sheet: 書き込み完了');
			} catch (e) {
				await logError(c.env.FIT2BSKY_KV, 'sheet_write', e);
				results.push(`Sheet: エラー - ${e}`);
			}
		}

		return c.text(results.join('\n'));
	} catch (e) {
		await logError(c.env.FIT2BSKY_KV, 'fitbit_get_weight', e);
		return c.text('Error: ' + e, 500);
	}
});

app.get('/sheet', async (c) => {
	try {
		if (await isSheetWritten(c.env.FIT2BSKY_KV)) {
			return c.text('本日は書き込み済みです');
		}

		const data = await fitbit.GetWeight(c.env, c.req.url, new Date());
		await sheet.Update(c.env, data.weight);
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

app.get('/', async (c) => {
	try {
		const data = await fitbit.GetWeight(c.env, c.req.url, new Date());
		return c.text(JSON.stringify(data));
	} catch (e) {
		return c.text('Error: ' + e, 500);
	}
});

const scheduled: ExportedHandlerScheduledHandler<Bindings> = async (event, env) => {
	const baseUrl = env.BASE_URL || 'https://fit2bsky-cw.kan-fushihara.workers.dev/';

	// cronの実行時刻を確認（UTC 0時 = JST 9時）
	const hour = new Date(event.scheduledTime).getUTCHours();
	const isMorningRun = hour === 0;

	let data;
	try {
		data = await fitbit.GetWeight(env, baseUrl, new Date());
	} catch (e) {
		await logError(env.FIT2BSKY_KV, 'scheduled_fitbit_get_weight', e);
		return;
	}

	// Bluesky投稿（朝9時のcronかつ未投稿の場合のみ）
	if (isMorningRun && !(await isBlueskyPosted(env.FIT2BSKY_KV))) {
		try {
			const jpy = await getJPYRate();
			const msg = `今日の体重: ${data.weight.toFixed(1)}kg (BMI: ${data.bmi.toFixed(2)} ) 体脂肪率: ${data.fat.toFixed(2)}% via Fitbit\n本日の1ドル: ${jpy.toFixed(1)}円`;
			await bluesky.postMessage(env, msg);
			await markBlueskyPosted(env.FIT2BSKY_KV);
		} catch (e) {
			await logError(env.FIT2BSKY_KV, 'scheduled_bluesky_post', e);
		}
	}

	// シート書き込み（未書き込みの場合のみ）
	if (!(await isSheetWritten(env.FIT2BSKY_KV))) {
		try {
			await sheet.Update(env, data.weight);
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
