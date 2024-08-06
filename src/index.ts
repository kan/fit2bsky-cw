import { Hono } from "hono";
import fitbit from "./fitbit";
import bluesky from "./bluesky";
import sheet from "./sheet";
import { getJPYRate } from "./fx";
import { Bindings } from "./bindings";

const app = new Hono<{ Bindings: Bindings }>();

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
	} catch(e) {
		return c.text('Error: ' + e, 500);
	}
});

app.get('/post', async (c) => {
	const day = (new Date()).toISOString().split('T')[0];
	const key = await c.env.FIT2BSKY_KV.get('BSKY_POST_'+day);
	if (key) {
		return c.text('本日は投稿済みです', 403);
	}
	await c.env.FIT2BSKY_KV.put('BSKY_POST_'+day, 'processed', { expirationTtl: 86400 });

	try {
		let data = await fitbit.GetWeight(c.env, c.req.url, new Date());
		let jpy = await getJPYRate();
		const msg = `今日の体重: ${data.weight.toFixed(1)}kg (BMI: ${data.bmi.toFixed(2)} ) 体脂肪率: ${data.fat.toFixed(2)}% via Fitbit\n本日の1ドル: ${jpy.toFixed(1)}円`;
		await bluesky.postMessage(c.env, msg);
		await sheet.Update(c.env, data.weight);
		return c.text('Blueskyへの投稿が完了しました');
	} catch(e) {
		return c.text('Error: ' + e, 500);
	}
});

app.get('/sheet', async (c) => {
	try {
		let data = await fitbit.GetWeight(c.env, c.req.url, new Date());
		await sheet.Update(c.env, data.weight);
		return c.text('シートへの書き込みが完了しました');
	} catch(e) {
		return c.text('Error: ' + e, 500);
	}
});

app.get('/fx', async (c) => {
	try {
		let jpy = await getJPYRate();
		return c.text(`${jpy.toFixed(1)}円`);
	} catch(e) {
		return c.text('Error: ' + e, 500);
	}
});

app.get('/', async (c) => {
	try {
		let data = await fitbit.GetWeight(c.env, c.req.url, new Date());
		return c.text(JSON.stringify(data));
	} catch(e) {
		return c.text('Error: ' + e, 500);
	}
});

const scheduled: ExportedHandlerScheduledHandler<Bindings> = async (event, env, ctx) => {
	let data = await fitbit.GetWeight(env, 'https://fit2bsky-cw.kan-fushihara.workers.dev/', new Date());
	let jpy = await getJPYRate();
	const msg = `今日の体重: ${data.weight.toFixed(1)}kg (BMI: ${data.bmi.toFixed(2)} ) 体脂肪率: ${data.fat.toFixed(2)}% via Fitbit\n本日の1ドル: ${jpy.toFixed(1)}円`;
	await bluesky.postMessage(env, msg);
	await sheet.Update(env, data.weight);
};

export default {
	fetch: app.fetch,
	scheduled,
}