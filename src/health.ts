import { Bindings } from './bindings';
import { nextDate } from './date';

/** 1 日分の体重の記録。date / time は記録したときの現地時刻。 */
export interface WeightRecord {
	date: string;
	time: string;
	weight: number;
	fat: number | null;
	bmi: number;
}

interface TokenResponse {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
	scope: string;
	token_type: string;
}

interface CivilDateTime {
	date: { year: number; month: number; day: number };
	time?: { hours?: number; minutes?: number; seconds?: number };
}

interface SampleTime {
	physicalTime: string;
	civilTime: CivilDateTime;
}

interface DataPoint {
	weight?: { weightGrams: number; sampleTime: SampleTime };
	bodyFat?: { percentage: number; sampleTime: SampleTime };
}

interface DataPointsResponse {
	dataPoints?: DataPoint[];
	nextPageToken?: string;
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://health.googleapis.com/v4/users/me';
const SCOPE = 'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly';
const REFRESH_TOKEN_KEY = 'GOOGLE_HEALTH_REFRESH_TOKEN';

function callbackUrl(url: string): string {
	return new URL('/oauth/callback', url).toString();
}

/**
 * エラーの応答から、原因を見分ける短い理由を取り出す。
 * token のエンドポイントは `{"error": "invalid_grant"}`、Health API は
 * `{"error": {"details": [{"reason": "ACCOUNT_NOT_LINKED"}]}}` の形で返す。
 */
function errorReason(body: string): string | null {
	try {
		const json = JSON.parse(body);
		if (typeof json.error === 'string') {
			return json.error;
		}
		const reason = json.error?.details?.find((d: { reason?: string }) => d.reason)?.reason;
		return reason ?? json.error?.status ?? null;
	} catch {
		return null;
	}
}

async function throwResponseError(label: string, res: Response): Promise<never> {
	const body = await res.text();
	const reason = errorReason(body);
	const hint =
		reason === 'invalid_grant'
			? '（同意の取り直しが必要。/auth を開く）'
			: reason === 'ACCOUNT_NOT_LINKED'
				? '（Google アカウントが Google Health に連携されていない）'
				: '';
	throw Error(`${label}: ${reason ?? 'unknown'}${hint} status=${res.status} msg=${body}`);
}

function getAuthURL(env: Bindings, url: string, state: string): string {
	const query = new URLSearchParams({
		response_type: 'code',
		client_id: env.GOOGLE_HEALTH_CLIENT_ID,
		redirect_uri: callbackUrl(url),
		scope: SCOPE,
		access_type: 'offline',
		prompt: 'consent',
		state,
	});
	return `${AUTH_URL}?${query.toString()}`;
}

async function requestToken(env: Bindings, params: Record<string, string>): Promise<TokenResponse> {
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: env.GOOGLE_HEALTH_CLIENT_ID,
			client_secret: env.GOOGLE_HEALTH_CLIENT_SECRET,
			...params,
		}),
	});
	if (!res.ok) {
		await throwResponseError("Can't get token", res);
	}
	return (await res.json()) as TokenResponse;
}

/** 認可コードを token に替え、refresh token を保存する。Google Health への連携も確かめる。 */
async function exchangeCode(env: Bindings, url: string, code: string): Promise<void> {
	const data = await requestToken(env, {
		grant_type: 'authorization_code',
		redirect_uri: callbackUrl(url),
		code,
	});
	if (!data.refresh_token) {
		throw Error("Can't get refresh token: 応答に refresh_token が無い");
	}

	const res = await fetch(`${API_BASE}/identity`, {
		headers: { Authorization: `Bearer ${data.access_token}` },
	});
	if (!res.ok) {
		await throwResponseError("Can't verify Google Health account", res);
	}

	await env.FIT2BSKY_KV.put(REFRESH_TOKEN_KEY, data.refresh_token);
}

/** 保存した refresh token から access token を取る。1 回の実行の中ではこれを使い回す。 */
async function getAccessToken(env: Bindings): Promise<string> {
	const refreshToken = await env.FIT2BSKY_KV.get(REFRESH_TOKEN_KEY);
	if (!refreshToken) {
		throw Error("Can't get refresh token: 未認証。/auth を開く");
	}

	const data = await requestToken(env, {
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
	});
	if (data.refresh_token && data.refresh_token !== refreshToken) {
		await env.FIT2BSKY_KV.put(REFRESH_TOKEN_KEY, data.refresh_token);
	}
	return data.access_token;
}

/** 指定した日（現地時刻）の data point をすべて取る。dataType は URL の kebab-case、filter では snake_case。 */
async function fetchDataPoints(token: string, dataType: string, day: string): Promise<DataPoint[]> {
	const filterField = dataType.replaceAll('-', '_');
	const filter = `${filterField}.sample_time.civil_time >= "${day}" AND ${filterField}.sample_time.civil_time < "${nextDate(day)}"`;
	const points: DataPoint[] = [];
	let pageToken = '';
	do {
		const query = new URLSearchParams({ filter });
		if (pageToken) {
			query.set('pageToken', pageToken);
		}
		const res = await fetch(`${API_BASE}/dataTypes/${dataType}/dataPoints?${query.toString()}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!res.ok) {
			await throwResponseError(`Can't get ${dataType}`, res);
		}
		const data = (await res.json()) as DataPointsResponse;
		points.push(...(data.dataPoints ?? []));
		pageToken = data.nextPageToken ?? '';
	} while (pageToken);
	return points;
}

/** 並び順はドキュメントに無いので、physicalTime で最新のものを選ぶ。 */
function latest<T extends { sampleTime: SampleTime }>(items: T[]): T | null {
	return items.reduce<T | null>(
		(acc, item) => (acc === null || Date.parse(item.sampleTime.physicalTime) > Date.parse(acc.sampleTime.physicalTime) ? item : acc),
		null,
	);
}

function pad(n: number | undefined): string {
	return String(n ?? 0).padStart(2, '0');
}

function formatCivilTime(civil: CivilDateTime): { date: string; time: string } {
	const { date, time } = civil;
	return {
		date: `${date.year}-${pad(date.month)}-${pad(date.day)}`,
		time: `${pad(time?.hours)}:${pad(time?.minutes)}:${pad(time?.seconds)}`,
	};
}

/**
 * 指定した日（JST、YYYY-MM-DD）の体重を取る。記録が無ければ例外を投げる。
 * 同期の遅れは、cron の再実行（12:00 / 21:00）で取り直す。
 */
async function getWeight(env: Bindings, token: string, day: string): Promise<WeightRecord> {
	const [weightPoints, fatPoints] = await Promise.all([fetchDataPoints(token, 'weight', day), fetchDataPoints(token, 'body-fat', day)]);

	const weight = latest(weightPoints.flatMap((p) => (p.weight ? [p.weight] : [])));
	if (!weight) {
		throw Error(`No weight data for ${day}`);
	}
	const fat = latest(fatPoints.flatMap((p) => (p.bodyFat ? [p.bodyFat] : [])));

	const kg = weight.weightGrams / 1000;
	const heightM = Number(env.HEIGHT_CM) / 100;
	if (!(heightM > 0) || !Number.isFinite(heightM)) {
		throw Error(`HEIGHT_CM が正の数ではない: ${env.HEIGHT_CM}`);
	}
	return {
		...formatCivilTime(weight.sampleTime.civilTime),
		weight: kg,
		fat: fat ? fat.percentage : null,
		bmi: kg / (heightM * heightM),
	};
}

export default { getAuthURL, exchangeCode, getAccessToken, getWeight };
