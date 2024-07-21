import { Hono } from "hono";
import fitbit from "./fitbit";
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

app.get('/', async (c) => {
	try {
		let data = await fitbit.GetWeight(c.env, c.req.url, new Date());
		return c.text(JSON.stringify(data));
	} catch(e) {
		return c.text('Error: ' + e, 500);
	}
});

export default app;