import { fetchOk } from './http';

const ERROR_LABEL = "Can't get USD/JPY rate";

/** 1 ドルが何円か。https://docs.bitfinex.com/reference/rest-public-foreign-exchange-rate */
export async function getJPYRate(): Promise<number> {
	const res = await fetchOk(ERROR_LABEL, 'https://api-pub.bitfinex.com/v2/calc/fx', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ccy1: 'USD', ccy2: 'JPY' }),
	});

	const data: unknown = await res.json();
	const rate = Array.isArray(data) ? data[0] : undefined;
	if (typeof rate !== 'number' || !Number.isFinite(rate)) {
		throw Error(`${ERROR_LABEL}: 応答が数値の配列ではない: ${JSON.stringify(data)}`);
	}
	return rate;
}
