import { reset } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { network } from './network';

// setupNetwork() は、ハンドラの無いリクエストを警告だけ出して本物へ通す。本物の API へ出ないよう、
// 受け皿を初期のハンドラにする。テストの中で network.use() したハンドラは、これより先に評価される
const catchAll = http.all('*', ({ request }) => HttpResponse.text(`unhandled request: ${request.method} ${request.url}`, { status: 599 }));

beforeAll(() => {
	network.enable();
	network.resetHandlers(catchAll);
});

beforeEach(() => {
	// JST 2026-11-07 09:00（UTC 0:00 の cron の時刻）。テストの中で vi.setSystemTime() でずらせる
	vi.useFakeTimers({ now: new Date('2026-11-07T00:00:00Z'), toFake: ['Date'] });
	// エラーの経路を通すテストが多く、出力が本当の失敗の表示に混ざるので黙らせる
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	network.resetHandlers();
	await reset();
});

afterAll(() => network.disable());
