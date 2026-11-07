import { SignJWT, importPKCS8 } from 'jose';
import { daysBetween } from './date';
import { fetchOk } from './http';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** GOOGLE_CREDENTIALS（サービスアカウントの鍵の JSON）のうち、使う項目 */
interface ServiceAccount {
	client_email: string;
	private_key: string;
	private_key_id: string;
	token_uri: string;
}

/**
 * サービスアカウントの鍵で署名した JWT を、access token に替える。
 * https://developers.google.com/identity/protocols/oauth2/service-account#httprest
 */
async function getAccessToken(credentials: string): Promise<string> {
	const sa = parseServiceAccount(credentials);
	const key = await importPKCS8(sa.private_key, 'RS256');
	const assertion = await new SignJWT({ scope: SCOPE })
		.setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id })
		.setIssuer(sa.client_email)
		.setAudience(sa.token_uri)
		.setIssuedAt()
		.setExpirationTime('1h')
		.sign(key);

	const res = await fetchOk("Can't get service account token", sa.token_uri, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
	});
	const { access_token } = (await res.json()) as { access_token?: unknown };
	if (typeof access_token !== 'string' || !access_token) {
		throw Error("Can't get service account token: 応答に access_token が無い");
	}
	return access_token;
}

/**
 * GOOGLE_CREDENTIALS を読み、要る項目がそろっているかを確かめる。
 * 例外のメッセージに入力を載せない（秘密鍵の一部がエラーログに残るため）。
 */
function parseServiceAccount(credentials: string): ServiceAccount {
	let sa: Partial<Record<keyof ServiceAccount, unknown>>;
	try {
		sa = JSON.parse(credentials);
	} catch {
		throw Error('GOOGLE_CREDENTIALS が JSON として読めない');
	}
	const missing = (['client_email', 'private_key', 'private_key_id', 'token_uri'] as const).filter(
		(k) => typeof sa?.[k] !== 'string' || !sa[k],
	);
	if (missing.length > 0) {
		throw Error(`GOOGLE_CREDENTIALS に ${missing.join(', ')} が無い`);
	}
	return sa as ServiceAccount;
}

/** day（JST、YYYY-MM-DD）の行に体重を書き込む。 */
async function Update(env: Env, day: string, value: number): Promise<void> {
	const token = await getAccessToken(env.GOOGLE_CREDENTIALS);

	const line = daysBetween('2016-05-02', day);
	const range = `${env.SHEET_NAME}!D${line}`;
	const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;

	await fetchOk("Can't write sheet", apiUrl, {
		method: 'PUT',
		headers: {
			Authorization: 'Bearer ' + token,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			range,
			majorDimension: 'ROWS',
			values: [[value]],
		}),
	});
}

export default { Update };
