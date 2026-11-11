import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import health from './health';
import { getJPYRate } from './fx';
import { jstDate } from './date';
import { getDailyStatus, getErrorLogs, getSavedComment, getStreak, getTodayWeight, logError, runDaily } from './daily';
import { renderDashboard } from './dashboard';
import { FAVICON_SVG } from './favicon';

const app = new Hono<{ Bindings: Env }>();

const OAUTH_STATE_COOKIE = 'oauth_state';

// 副作用のある POST に、他サイトから送られたフォームを通さない
app.use(csrf());

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

app.post('/post', async (c) => {
	const result = await runDaily(c.env, { post: true });
	return c.text(result.messages.join('\n'), result.ok ? 200 : 500);
});

app.post('/sheet', async (c) => {
	const result = await runDaily(c.env, { post: false });
	return c.text(result.messages.join('\n'), result.ok ? 200 : 500);
});

app.get('/fx', async (c) => {
	try {
		const jpy = await getJPYRate();
		return c.text(`${jpy.toFixed(1)}円`);
	} catch (e) {
		console.error('[fx]', e);
		return c.text('Error: ' + e, 500);
	}
});

app.get('/errors', async (c) => {
	const logs = await getErrorLogs(c.env.FIT2BSKY_KV, c.req.query('date') || jstDate());
	return logs ? c.json(logs) : c.text('エラーログはありません');
});

app.get('/status', async (c) => {
	const day = jstDate();
	const [status, errors] = await Promise.all([getDailyStatus(c.env.FIT2BSKY_KV, day), getErrorLogs(c.env.FIT2BSKY_KV, day)]);
	return c.json({ date: day, ...status, hasErrors: errors !== null });
});

app.get('/weight', async (c) => {
	try {
		const current = await getTodayWeight(c.env, jstDate());
		return c.json(current);
	} catch (e) {
		console.error('[weight]', e);
		return c.text('Error: ' + e, 500);
	}
});

// <link> を見ずに /favicon.ico を取りに来るクライアントにも同じ SVG を返す
app.on('GET', ['/favicon.svg', '/favicon.ico'], (c) =>
	c.body(FAVICON_SVG, 200, {
		'Content-Type': 'image/svg+xml',
		'Cache-Control': 'public, max-age=86400',
	}),
);

app.get('/', async (c) => {
	const kv = c.env.FIT2BSKY_KV;
	const day = jstDate();
	const targetWeight = parseFloat(c.env.TARGET_WEIGHT);
	const [status, errors, streakDays, aiComment] = await Promise.all([
		getDailyStatus(kv, day),
		getErrorLogs(kv, day),
		getStreak(kv),
		getSavedComment(kv, day),
	]);

	let weight = null;
	let weightError = null;
	try {
		weight = await getTodayWeight(c.env, day);
	} catch (e) {
		// 表示のたびに取るので KV のエラーログには入れず、Workers Logs にだけ残す
		console.error('[dashboard]', e);
		weightError = e instanceof Error ? e.message : String(e);
	}

	return c.html(
		renderDashboard({ day, status, errorCount: errors?.length ?? 0, streakDays, targetWeight, weight, weightError, aiComment }),
	);
});

const scheduled: ExportedHandlerScheduledHandler<Env> = async (_event, env) => {
	await runDaily(env, { post: true }, 'scheduled_');
};

export default {
	fetch: app.fetch,
	scheduled,
};
