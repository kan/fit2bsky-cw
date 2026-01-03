import { getAccessToken } from 'web-auth-library/google';
import { Bindings } from './bindings';

async function Update(env: Bindings, value: number): Promise<void> {
	const token = await getAccessToken({
		credentials: env.GOOGLE_CREDENTIALS,
		scope: 'https://www.googleapis.com/auth/spreadsheets',
	});

	const begin = new Date('2016-05-02').valueOf();
	const now = new Date().valueOf();
	const line = Math.floor((now - begin) / (1000 * 60 * 60 * 24));
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
