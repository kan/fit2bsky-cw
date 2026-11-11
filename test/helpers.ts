import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { jwtVerify } from 'jose';
import { http, HttpResponse } from 'msw';
import worker from '../src/index';
import { getErrorLogs } from '../src/daily';
import { network } from './network';

const BASE = 'https://fit2bsky.test';

/** ダッシュボードのフォームと同じ、同じサイトからの POST */
export const FORM_POST: RequestInit = { method: 'POST', headers: { Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded' } };

/** worker の fetch を呼び、waitUntil に渡した処理まで待つ */
export async function call(env: Env, path: string, init?: RequestInit): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

/** その日のエラーログ。無ければ空の配列 */
export async function errorLogs(env: Env, day = TODAY): Promise<{ context: string; error: string }[]> {
	return ((await getErrorLogs(env.FIT2BSKY_KV, day)) as { context: string; error: string }[] | null) ?? [];
}

// src の定数は import しない。URL を書き間違えたとき、テストで気づけるようにするため
const HEALTH_API = 'https://health.googleapis.com/v4/users/me';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** シート用のサービスアカウントの token。Google Health の token と区別するため別の URL にする */
const SA_TOKEN_URL = 'https://sa-token.test/token';
const BSKY = 'https://bsky.social/xrpc';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
export const FX_URL = 'https://api-pub.bitfinex.com/v2/calc/fx';
const SA_EMAIL = 'sheet@test.iam.gserviceaccount.com';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

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
		ANTHROPIC_API_KEY: 'anthropic-key',
		// 本物の Workers AI へ出ないよう、mockDeepSeek を呼ぶまでは失敗させる（MSW の受け皿の 599 と同じ役目）
		AI: fakeAi(() => {
			throw Error('unmocked AI.run');
		}),
	};
}

export interface AiCall {
	model: string;
	inputs: Record<string, unknown>;
	options?: { signal?: AbortSignal };
}

function fakeAi(reply: (call: AiCall) => unknown, calls: AiCall[] = []): Ai {
	return {
		run: async (model: string, inputs: Record<string, unknown>, options?: AiCall['options']) => {
			const call = { model, inputs, options };
			calls.push(call);
			return reply(call);
		},
	} as unknown as Ai;
}

export const DEEPSEEK_COMMENT = '秋の夜長を体重計の上で過ごすおつもりですか';

/** Workers AI の chat completions の応答。content を 1 つの choice で返す */
export function deepSeekText(content: string, finishReason = 'stop') {
	return {
		id: 'chatcmpl-test',
		object: 'chat.completion',
		created: 0,
		model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
		choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason, logprobs: null }],
		usage: { prompt_tokens: 800, completion_tokens: 500, total_tokens: 1300 },
	};
}

/**
 * env.AI を差し替える（env.AI.run() は fetch を通らず、MSW では差し替えられないため）。calls に呼び出しがたまる。
 * reply で応答を差し替える（既定は DEEPSEEK_COMMENT を JSON で返す）。例外を投げれば、run() の失敗になる
 */
export function mockDeepSeek(
	env: Env,
	reply: (call: AiCall) => unknown = () => deepSeekText(JSON.stringify({ comment: DEEPSEEK_COMMENT })),
) {
	const calls: AiCall[] = [];
	env.AI = fakeAi(reply, calls);
	return { calls };
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

export const CLAUDE_COMMENT = '測るだけで痩せるなら苦労はしませんね';

/**
 * Claude の Messages API。messages に送られたリクエストの本文がたまる。
 * reply で応答を差し替える（既定は CLAUDE_COMMENT を JSON で返す）。
 */
export function mockClaude(
	reply: (body: Record<string, unknown>) => Response = () => claudeText(JSON.stringify({ comment: CLAUDE_COMMENT })),
) {
	const messages: Record<string, unknown>[] = [];
	network.use(
		http.post(CLAUDE_URL, async ({ request }) => {
			// SDK 1.x は API キーを Authorization ヘッダーで送る
			if (request.headers.get('authorization') !== 'Bearer anthropic-key') {
				return HttpResponse.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 });
			}
			const body = (await request.json()) as Record<string, unknown>;
			if ('fallbacks' in body && !request.headers.get('anthropic-beta')?.includes('server-side-fallback-2026-07-01')) {
				return HttpResponse.json(
					{ type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks needs the beta header' } },
					{ status: 400 },
				);
			}
			messages.push(body);
			return reply(body);
		}),
	);
	return { messages };
}

/** Messages API の応答。text を 1 つの text ブロックで返す。model は応答を書いたモデル（server-side fallback で変わる） */
export function claudeText(text: string, stopReason = 'end_turn', model = 'claude-opus-5-5'): Response {
	return HttpResponse.json({
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model,
		content: [{ type: 'text', text }],
		stop_reason: stopReason,
		stop_sequence: null,
		usage: { input_tokens: 1000, output_tokens: 50 },
	});
}

/** その日の処理に要る外部 API（体重、Bluesky、シート、為替、Claude）をまとめて用意する。為替は mockFx の既定の 150.25 */
export function mockDaily(byDay: Parameters<typeof mockHealth>[0] = oneWeight(), { bskyFail = false } = {}) {
	const { requests, tokenRequests } = mockHealth(byDay);
	const { posts, records } = mockBluesky({ fail: bskyFail });
	const { writes } = mockSheet();
	mockFx();
	const { messages } = mockClaude();
	return { requests, tokenRequests, posts, records, writes, messages };
}
