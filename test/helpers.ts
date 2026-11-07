import { env } from 'cloudflare:workers';
import { jwtVerify } from 'jose';
import { http, HttpResponse } from 'msw';
import { network } from './network';

// src の定数は import しない。URL を書き間違えたとき、テストで気づけるようにするため
const HEALTH_API = 'https://health.googleapis.com/v4/users/me';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** シート用のサービスアカウントの token。Google Health の token と区別するため別の URL にする */
const SA_TOKEN_URL = 'https://sa-token.test/token';
const BSKY = 'https://bsky.social/xrpc';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
export const FX_URL = 'https://api-pub.bitfinex.com/v2/calc/fx';
const SA_EMAIL = 'sheet@test.iam.gserviceaccount.com';

/** setup.ts が固定する時刻の、JST の日付 */
export const TODAY = '2026-11-07';

/** その日に体重の記録が 1 件だけある状態 */
export function oneWeight(day = TODAY, value = 134) {
	return { [day]: { weight: [{ at: `${day}T07:00:00`, value }] } };
}

/** テスト用のサービスアカウントの鍵。公開鍵は、mockSheet が JWT の署名を検証するのに使う */
async function makeServiceAccount(): Promise<{ json: string; publicKey: CryptoKey }> {
	const key = (await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify'],
	)) as CryptoKeyPair;
	const pkcs8 = (await crypto.subtle.exportKey('pkcs8', key.privateKey)) as ArrayBuffer;
	const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
	const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
	const json = JSON.stringify({
		type: 'service_account',
		project_id: 'test',
		private_key_id: 'test-key',
		private_key: pem,
		client_email: SA_EMAIL,
		client_id: '1',
		token_uri: SA_TOKEN_URL,
	});
	return { json, publicKey: key.publicKey };
}

let serviceAccount: { json: string; publicKey: CryptoKey } | null = null;

/** wrangler.jsonc の vars に、テスト用の secret を足した env。KV は本物（テストごとに reset される）。 */
export async function testEnv(): Promise<Env> {
	serviceAccount ??= await makeServiceAccount();
	await env.FIT2BSKY_KV.put('GOOGLE_HEALTH_REFRESH_TOKEN', 'refresh-token');
	return {
		...env,
		GOOGLE_HEALTH_CLIENT_ID: 'client-id',
		GOOGLE_HEALTH_CLIENT_SECRET: 'client-secret',
		BSKY_HANDLE: 'test.bsky.social',
		BSKY_PASSWORD: 'app-password',
		SHEET_ID: 'sheet-id',
		SHEET_NAME: 'weight',
		GOOGLE_CREDENTIALS: serviceAccount.json,
	};
}

interface Sample {
	/** 現地時刻（JST）の ISO 形式。例: 2026-11-07T07:48:44 */
	at: string;
	value: number;
}

function sampleTime(at: string) {
	const [date, time] = at.split('T');
	const [year, month, day] = date.split('-').map(Number);
	const [hours, minutes, seconds] = time.split(':').map(Number);
	return {
		physicalTime: new Date(`${at}+09:00`).toISOString(),
		utcOffset: '32400s',
		civilTime: { date: { year, month, day }, time: { hours, minutes, seconds } },
	};
}

/** filter の civil_time の下限（その日）を取り出す */
export function filterDay(url: string): string | null {
	const filter = new URL(url).searchParams.get('filter') ?? '';
	return filter.match(/civil_time >= "([0-9-]+)"/)?.[1] ?? null;
}

/**
 * Google Health の token と、日付ごとの体重と体脂肪率を返す。
 * 返り値の requests に data point の要求の URL が、tokenRequests に token の要求の grant_type がたまる。
 */
export function mockHealth(byDay: Record<string, { weight?: Sample[]; fat?: Sample[] }>) {
	const requests: string[] = [];
	const tokenRequests: string[] = [];
	network.use(
		http.post(GOOGLE_TOKEN_URL, async ({ request }) => {
			tokenRequests.push(new URLSearchParams(await request.text()).get('grant_type') ?? '');
			return HttpResponse.json({ access_token: 'access-token', expires_in: 3600, scope: '', token_type: 'Bearer' });
		}),
		http.get(`${HEALTH_API}/dataTypes/:type/dataPoints`, ({ request, params }) => {
			requests.push(request.url);
			const day = filterDay(request.url) ?? '';
			const data = byDay[day] ?? {};
			const dataPoints =
				params.type === 'weight'
					? (data.weight ?? []).map((s) => ({ weight: { weightGrams: s.value * 1000, sampleTime: sampleTime(s.at) } }))
					: (data.fat ?? []).map((s) => ({ bodyFat: { percentage: s.value, sampleTime: sampleTime(s.at) } }));
			return HttpResponse.json({ dataPoints, nextPageToken: '' });
		}),
	);
	return { requests, tokenRequests };
}

function fakeJwt(): string {
	const enc = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
	return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: 'did:plc:test', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

/**
 * Bluesky のログインと投稿。posts に投稿した本文が、records に投稿のレコード全体がたまる。
 * fail を true にすると投稿で 500 を返す
 */
export function mockBluesky({ fail = false } = {}) {
	const posts: string[] = [];
	const records: Record<string, unknown>[] = [];
	network.use(
		http.post(`${BSKY}/com.atproto.server.createSession`, () =>
			HttpResponse.json({ accessJwt: fakeJwt(), refreshJwt: fakeJwt(), handle: 'test.bsky.social', did: 'did:plc:test', active: true }),
		),
		http.post(`${BSKY}/com.atproto.repo.createRecord`, async ({ request }) => {
			if (fail) {
				return HttpResponse.json({ error: 'InternalServerError', message: 'boom' }, { status: 500 });
			}
			const body = (await request.json()) as { record: { text: string } & Record<string, unknown> };
			posts.push(body.record.text);
			records.push(body.record);
			return HttpResponse.json({
				uri: 'at://did:plc:test/app.bsky.feed.post/3kabc',
				cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
			});
		}),
	);
	return { posts, records };
}

/**
 * シート用の token と書き込み。writes に書き込んだ range と値がたまる。
 * token の要求は、JWT の署名と iss / aud / scope を検証し、合わなければ 400 を返す
 */
export function mockSheet() {
	const writes: { range: string; values: unknown }[] = [];
	network.use(
		http.post(SA_TOKEN_URL, async ({ request }) => {
			const form = new URLSearchParams(await request.text());
			try {
				if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
					throw Error(`grant_type: ${form.get('grant_type')}`);
				}
				const { payload } = await jwtVerify(form.get('assertion') ?? '', serviceAccount!.publicKey, {
					issuer: SA_EMAIL,
					audience: SA_TOKEN_URL,
				});
				if (payload.scope !== 'https://www.googleapis.com/auth/spreadsheets') {
					throw Error(`scope: ${payload.scope}`);
				}
			} catch (e) {
				return HttpResponse.json({ error: 'invalid_grant', error_description: String(e) }, { status: 400 });
			}
			return HttpResponse.json({ access_token: 'sa-token', expires_in: 3600, token_type: 'Bearer' });
		}),
		http.put(`${SHEETS_API}/:id/values/:range`, async ({ request }) => {
			if (request.headers.get('Authorization') !== 'Bearer sa-token') {
				return HttpResponse.json({ error: { code: 401 } }, { status: 401 });
			}
			const body = (await request.json()) as { range: string; values: unknown };
			writes.push({ range: body.range, values: body.values });
			return HttpResponse.json({ updatedCells: 1 });
		}),
	);
	return { writes };
}

export function mockFx(rate = 150.25) {
	network.use(http.post(FX_URL, () => HttpResponse.json([rate])));
}

/** その日の処理に要る外部 API（体重、Bluesky、シート、為替）をまとめて用意する。為替は mockFx の既定の 150.25 */
export function mockDaily(byDay: Parameters<typeof mockHealth>[0] = oneWeight(), { bskyFail = false } = {}) {
	const { requests, tokenRequests } = mockHealth(byDay);
	const { posts, records } = mockBluesky({ fail: bskyFail });
	const { writes } = mockSheet();
	mockFx();
	return { requests, tokenRequests, posts, records, writes };
}
