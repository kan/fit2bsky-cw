import { Bindings } from './bindings';

interface TokenResponse {
	access_token: string;
	expires_in: number;
	refresh_token: string;
	token_type: string;
	scope: string;
}

export interface FitbitWeight {
	bmi: number;
	date: string;
	fat: number;
	logId: number;
	source: string;
	time: string;
	weight: number;
}

interface FitbitWeightResponse {
	weight: Array<FitbitWeight>;
}

const FITBIT_AUTH_URL = 'https://www.fitbit.com/oauth2/authorize';
const FITBIT_TOKEN_URL = 'https://api.fitbit.com/oauth2/token';
const FITBIT_WEIGHT_URL = 'https://api.fitbit.com/1/user/-/body/log/weight/date/<DATE>.json';
const REFRESH_TOKEN_KEY = 'FITBIT_REFRESH_TOKEN';

function GetAuthURL(env: Bindings, url: string): string {
	const callbackUrl = new URL('/oauth/callback', url).toString();
	const query = new URLSearchParams({
		response_type: 'code',
		client_id: env.CLIENT_ID,
		scope: 'weight',
		expires_in: '604800',
		redirect_uri: callbackUrl,
	});

	return `${FITBIT_AUTH_URL}?${query.toString()}`;
}

async function SetAccessToken(env: Bindings, url: string, code: string): Promise<void> {
	const res = await fetch(FITBIT_TOKEN_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Authorization: 'Basic ' + btoa(`${env.CLIENT_ID}:${env.CLIENT_SECRET}`),
		},
		body: new URLSearchParams({
			client_id: env.CLIENT_ID,
			grant_type: 'authorization_code',
			redirect_uri: new URL('/oauth/callback', url).toString(),
			code: code,
		}),
	});
	if (!res.ok) {
		let msg = await res.text();
		throw Error(`Can't get token. msg=${msg} status=${res.status}`);
	}

	const data = (await res.json()) as TokenResponse;

	await env.FIT2BSKY_KV.put(REFRESH_TOKEN_KEY, data.refresh_token);
}

async function getAccessToken(env: Bindings, url: string): Promise<string> {
	const token = await env.FIT2BSKY_KV.get(REFRESH_TOKEN_KEY);
	if (!token) {
		throw Error(`Can't get refresh token`);
	}

	const res = await fetch(FITBIT_TOKEN_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Authorization: 'Basic ' + btoa(`${env.CLIENT_ID}:${env.CLIENT_SECRET}`),
		},
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			redirect_uri: new URL('/oauth/callback', url).toString(),
			refresh_token: token,
		}),
	});
	if (!res.ok) {
		let msg = await res.text();
		throw Error(`Can't get token. msg=${msg} status=${res.status}`);
	}

	const data = (await res.json()) as TokenResponse;

	await env.FIT2BSKY_KV.put(REFRESH_TOKEN_KEY, data.refresh_token);

	return data.access_token;
}

async function fetchWeight(token: string, date: Date): Promise<FitbitWeightResponse> {
	const day = date.toISOString().split('T')[0];
	const weightUrl = FITBIT_WEIGHT_URL.replace('<DATE>', day);
	const res = await fetch(weightUrl, {
		method: 'GET',
		headers: {
			Authorization: 'Bearer ' + token,
		},
	});
	if (!res.ok) {
		const msg = await res.text();
		throw Error(`Can't get weight. msg=${msg} status=${res.status}`);
	}

	return (await res.json()) as FitbitWeightResponse;
}

async function GetWeight(env: Bindings, url: string, date: Date, maxRetries: number = 3): Promise<FitbitWeight> {
	const token = await getAccessToken(env, url);
	if (!token) {
		throw Error(`Can't get access token`);
	}

	let lastError: Error | null = null;
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		if (attempt > 0) {
			// 指数バックオフ: 1秒、2秒、4秒...
			await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
		}

		try {
			const data = await fetchWeight(token, date);
			if (data.weight?.length > 0) {
				return data.weight[0];
			}
			lastError = new Error(`Empty weight response (attempt ${attempt + 1}/${maxRetries})`);
		} catch (e) {
			lastError = e instanceof Error ? e : new Error(String(e));
		}
	}

	throw lastError ?? new Error('Failed to get weight after retries');
}

export default { GetAuthURL, SetAccessToken, GetWeight };
