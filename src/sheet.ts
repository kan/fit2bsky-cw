import { getAccessToken } from 'web-auth-library/google';
import { Bindings } from './bindings';
import { daysBetween } from './date';

/** day（JST、YYYY-MM-DD）の行に体重を書き込む。 */
async function Update(env: Bindings, day: string, value: number): Promise<void> {
	const token = await getAccessToken({
		credentials: env.GOOGLE_CREDENTIALS,
		scope: 'https://www.googleapis.com/auth/spreadsheets',
	});

	const line = daysBetween('2016-05-02', day);
	const range = `${env.SHEET_NAME}!D${line}`;
	const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;

	const res = await fetch(apiUrl, {
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
	if (!res.ok) {
		let msg = await res.text();
		throw Error(`Can't write sheet. msg=${msg} status=${res.status}`);
	}
}

export default { Update };
