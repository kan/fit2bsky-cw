import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { Bindings } from '../src/bindings';
import { network } from './network';
import { FX_URL, GOOGLE_TOKEN_URL, TODAY, filterDay, mockDaily, mockFx, mockHealth, oneWeight, testEnv } from './helpers';

const BASE = 'https://fit2bsky.test';

/** ダッシュボードのフォームと同じ、同じサイトからの POST */
const FORM_POST: RequestInit = { method: 'POST', headers: { Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded' } };

async function call(env: Bindings, path: string, init?: RequestInit): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

describe('GET /weight', () => {
	it('最新の体重と体脂肪率を取り、BMI を身長から計算する', async () => {
		mockHealth({
			[TODAY]: {
				weight: [
					{ at: `${TODAY}T07:00:00`, value: 135 },
					{ at: `${TODAY}T07:48:44`, value: 134 },
				],
				fat: [{ at: `${TODAY}T07:48:44`, value: 33.028 }],
			},
		});
		const res = await call(await testEnv(), '/weight');

		expect(res.status).toBe(200);
		const data = (await res.json()) as Record<string, unknown>;
		expect(data).toMatchObject({ date: TODAY, time: '07:48:44', weight: 134, fat: 33.028 });
		// HEIGHT_CM = 186.5（wrangler.toml）
		expect(data.bmi).toBeCloseTo(134 / 1.865 ** 2, 5);
	});

	it('体脂肪率が無い日は fat を null にする', async () => {
		mockHealth(oneWeight());
		const res = await call(await testEnv(), '/weight');

		expect(await res.json()).toMatchObject({ weight: 134, fat: null });
	});

	it('その日の体重が無ければ 500 を返す', async () => {
		mockHealth({});
		const res = await call(await testEnv(), '/weight');

		expect(res.status).toBe(500);
		expect(await res.text()).toContain(`No weight data for ${TODAY}`);
	});

	it('JST の日付で絞り込む', async () => {
		vi.setSystemTime(new Date('2026-11-07T16:00:00Z')); // JST 2026-11-08 01:00
		const { requests } = mockHealth(oneWeight('2026-11-08'));
		const res = await call(await testEnv(), '/weight');

		expect(res.status).toBe(200);
		expect(requests.map(filterDay)).toEqual(['2026-11-08', '2026-11-08']);
	});

	it('refresh token が無効なら、同意の取り直しを促すエラーにする', async () => {
		network.use(http.post(GOOGLE_TOKEN_URL, () => HttpResponse.json({ error: 'invalid_grant' }, { status: 400 })));
		const res = await call(await testEnv(), '/weight');

		expect(res.status).toBe(500);
		expect(await res.text()).toContain('invalid_grant（同意の取り直しが必要');
	});
});

describe('POST /post', () => {
	it('Bluesky に投稿し、シートのその日の行に書き込む', async () => {
		const { requests, posts, writes } = mockDaily({
			[TODAY]: { weight: [{ at: `${TODAY}T07:48:44`, value: 134 }], fat: [{ at: `${TODAY}T07:48:44`, value: 33.028 }] },
			...oneWeight('2026-10-08', 136),
		});
		const env = await testEnv();

		const res = await call(env, '/post', FORM_POST);

		expect(res.status).toBe(200);
		// AI コメントのために 30 日前の体重も取る
		expect(requests.map(filterDay).sort()).toEqual(['2026-10-08', '2026-10-08', TODAY, TODAY]);
		expect(posts).toHaveLength(1);
		expect(posts[0]).toContain('今日の体重: 134.0kg (BMI: 38.53) 体脂肪率: 33.03%');
		expect(posts[0]).toContain('連続1日目 | 1$=150.3円');
		// 2016-05-02 からの日数が行番号
		expect(writes).toEqual([{ range: 'weight!D3841', values: [[134]] }]);

		const status = await call(env, '/status');
		expect(await status.json()).toMatchObject({ date: TODAY, blueskyPosted: true, sheetWritten: true, hasErrors: false });
	});

	it('2 回目は投稿もシートへの書き込みもしない', async () => {
		const { posts, writes } = mockDaily();
		const env = await testEnv();

		await call(env, '/post', FORM_POST);
		const res = await call(env, '/post', FORM_POST);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('Bluesky: 本日は投稿済みです\nSheet: 本日は書き込み済みです');
		expect(posts).toHaveLength(1);
		expect(writes).toHaveLength(1);
	});

	it('GET では実行しない', async () => {
		const res = await call(await testEnv(), '/post');
		expect(res.status).toBe(404);
	});

	it('他のサイトから送られたフォームは弾く', async () => {
		const res = await call(await testEnv(), '/post', {
			...FORM_POST,
			headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
		});
		expect(res.status).toBe(403);
	});
});

describe('POST /sheet', () => {
	it('シートにだけ書き込み、投稿はしない', async () => {
		const { requests, posts, writes } = mockDaily();
		const res = await call(await testEnv(), '/sheet', FORM_POST);

		expect(await res.text()).toBe('Sheet: 書き込み完了');
		expect(posts).toHaveLength(0);
		expect(writes).toHaveLength(1);
		// 投稿しないので 1 か月前の体重は取らない
		expect(requests.map(filterDay)).toEqual([TODAY, TODAY]);
	});
});

describe('GET /fx', () => {
	it('ドル円のレートを返す', async () => {
		mockFx(150.25);
		const res = await call(await testEnv(), '/fx');
		expect(await res.text()).toBe('150.3円');
	});

	it('ハンドラの無いリクエストは本物の API へ出さず、受け皿が 599 を返す', async () => {
		const res = await call(await testEnv(), '/fx');
		expect(res.status).toBe(500);
		expect(await res.text()).toContain(`unhandled request: POST ${FX_URL}`);
	});

	it('取得に失敗したら 500 を返す', async () => {
		network.use(http.post(FX_URL, () => HttpResponse.text('down', { status: 503 })));
		const res = await call(await testEnv(), '/fx');
		expect(res.status).toBe(500);
	});
});

describe('GET /oauth/callback', () => {
	const STATE_COOKIE = 'oauth_state=expected-state';

	/** 認可コードの交換と、Google Health への連携の確認 */
	function mockExchange() {
		network.use(
			http.post(GOOGLE_TOKEN_URL, () =>
				HttpResponse.json({
					access_token: 'access-token',
					refresh_token: 'new-refresh-token',
					expires_in: 3600,
					scope: '',
					token_type: 'Bearer',
				}),
			),
			http.get('https://health.googleapis.com/v4/users/me/identity', () => HttpResponse.json({})),
		);
	}

	it('state が cookie と合えば、refresh token を保存する', async () => {
		mockExchange();
		const env = await testEnv();
		const res = await call(env, '/oauth/callback?state=expected-state&code=auth-code', { headers: { Cookie: STATE_COOKIE } });

		expect(res.status).toBe(200);
		expect(await env.FIT2BSKY_KV.get('GOOGLE_HEALTH_REFRESH_TOKEN')).toBe('new-refresh-token');
	});

	it('state が合わなければ、認可コードを使わずに 400 を返す', async () => {
		mockExchange();
		const env = await testEnv();
		const res = await call(env, '/oauth/callback?state=other-state&code=auth-code', { headers: { Cookie: STATE_COOKIE } });

		expect(res.status).toBe(400);
		expect(await env.FIT2BSKY_KV.get('GOOGLE_HEALTH_REFRESH_TOKEN')).toBe('refresh-token');
	});

	it('state の cookie が無ければ 400 を返す', async () => {
		const res = await call(await testEnv(), '/oauth/callback?state=expected-state&code=auth-code');
		expect(res.status).toBe(400);
	});
});

describe('GET /errors', () => {
	it('その日のエラーログを返し、無ければその旨を返す', async () => {
		mockHealth({});
		const env = await testEnv();
		await call(env, '/post', FORM_POST);

		const res = await call(env, '/errors');
		expect(await res.json()).toMatchObject([{ context: 'health_get_weight' }]);

		const other = await call(env, '/errors?date=2026-11-06');
		expect(await other.text()).toBe('エラーログはありません');
	});
});

describe('GET /', () => {
	it('外部 API のエラー文をエスケープして表示する', async () => {
		network.use(http.post(GOOGLE_TOKEN_URL, () => HttpResponse.text('<script>alert(1)</script>', { status: 500 })));
		const res = await call(await testEnv(), '/');
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(body).not.toContain('<script>alert(1)</script>');
	});
});
