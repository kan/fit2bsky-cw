import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { FETCH_TIMEOUT_MS, fetchOk, fetchWithTimeout } from '../src/http';
import { network } from './network';

const URL = 'https://api.test/ok';

describe('fetchWithTimeout', () => {
	it(`${FETCH_TIMEOUT_MS} ms のタイムアウトを付ける`, async () => {
		network.use(http.get(URL, () => HttpResponse.text('ok')));
		const timeout = vi.spyOn(AbortSignal, 'timeout');

		await fetchWithTimeout(URL);

		expect(FETCH_TIMEOUT_MS).toBe(10_000);
		expect(timeout).toHaveBeenCalledWith(FETCH_TIMEOUT_MS);
	});

	it('呼び出し側の signal で中断できる', async () => {
		network.use(http.get(URL, () => HttpResponse.text('ok')));
		const controller = new AbortController();
		controller.abort(new Error('caller aborted'));

		await expect(fetchWithTimeout(URL, { signal: controller.signal })).rejects.toThrow('caller aborted');
		await expect(fetchWithTimeout(new Request(URL, { signal: controller.signal }))).rejects.toThrow('caller aborted');
	});
});

describe('fetchOk', () => {
	it('2xx 以外は、label と status と本文を載せた例外にする', async () => {
		network.use(http.get(URL, () => HttpResponse.text('nope', { status: 403 })));
		await expect(fetchOk('Call', URL, undefined, (body) => `[${body}]`)).rejects.toThrow('Call: [nope] status=403 msg=nope');
	});

	it('タイムアウトにも label を付ける', async () => {
		vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(new DOMException('timed out', 'TimeoutError')));
		network.use(http.get(URL, () => HttpResponse.text('ok')));
		await expect(fetchOk('Call', URL)).rejects.toThrow(/^Call: TimeoutError/);
	});
});
