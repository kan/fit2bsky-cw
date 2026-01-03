export async function getJPYRate(): Promise<number> {
	const res = await fetch('https://api.bitfinex.com/v2/calc/fx', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ ccy1: 'USD', ccy2: 'JPY' }),
	});

	if (!res.ok) {
		let msg = await res.text();
		throw Error(`Can't get token. msg=${msg} status=${res.status}`);
	}

	const data = (await res.json()) as number[];
	return data[0];
}
