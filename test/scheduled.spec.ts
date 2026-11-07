import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { Bindings } from '../src/bindings';
import { getErrorLogs } from '../src/daily';
import { TODAY, filterDay, mockBluesky, mockDaily, oneWeight, testEnv } from './helpers';

async function runCron(env: Bindings, cron = '0 0 * * *'): Promise<void> {
	const ctrl = createScheduledController({ scheduledTime: Date.now(), cron });
	const ctx = createExecutionContext();
	await worker.scheduled(ctrl, env, ctx);
	await waitOnExecutionContext(ctx);
}

async function errorContexts(env: Bindings, day = TODAY): Promise<string[]> {
	const logs = (await getErrorLogs(env.FIT2BSKY_KV, day)) as { context: string }[] | null;
	return (logs ?? []).map((l) => l.context);
}

describe('scheduled', () => {
	it('未完了なら投稿とシートへの書き込みを行う', async () => {
		const { posts, writes } = mockDaily();
		const env = await testEnv();

		await runCron(env);

		expect(posts).toHaveLength(1);
		expect(writes).toHaveLength(1);
		expect(await errorContexts(env)).toEqual([]);
	});

	it('どちらも済んでいれば、体重も取らずに終える', async () => {
		const { requests, tokenRequests, posts } = mockDaily();
		const env = await testEnv();
		await runCron(env);
		requests.length = 0;
		tokenRequests.length = 0;

		await runCron(env, '0 3 * * *');

		expect(requests).toEqual([]);
		expect(tokenRequests).toEqual([]);
		expect(posts).toHaveLength(1);
	});

	it('投稿に失敗してもシートには書き込み、次の cron で投稿し直す', async () => {
		const { writes } = mockDaily(oneWeight(), { bskyFail: true });
		const env = await testEnv();

		await runCron(env);

		expect(writes).toHaveLength(1);
		expect(await errorContexts(env)).toEqual(['scheduled_bluesky_post']);

		const { posts } = mockBluesky();
		await runCron(env, '0 3 * * *');

		expect(posts).toHaveLength(1);
		expect(writes).toHaveLength(1);
	});

	it('体重が取れなければ、どちらも行わずにエラーを残す', async () => {
		const { posts, writes } = mockDaily({});
		const env = await testEnv();

		await runCron(env);

		expect(posts).toHaveLength(0);
		expect(writes).toHaveLength(0);
		expect(await errorContexts(env)).toEqual(['scheduled_health_get_weight']);
	});

	it('JST 0:00〜9:00 の実行でも、JST の日付で取得し、フラグを立てる', async () => {
		vi.setSystemTime(new Date('2026-11-07T16:00:00Z')); // JST 2026-11-08 01:00
		const { requests, writes } = mockDaily(oneWeight('2026-11-08'));
		const env = await testEnv();

		await runCron(env);

		// 今日（JST）と、その 30 日前
		expect(requests.map(filterDay).sort()).toEqual(['2026-10-09', '2026-10-09', '2026-11-08', '2026-11-08']);
		expect(writes[0].range).toBe('weight!D3842');
		expect(await env.FIT2BSKY_KV.get('BSKY_POST_2026-11-08')).toBe('posted');
		expect(await env.FIT2BSKY_KV.get('SHEET_WRITE_2026-11-08')).toBe('written');
	});

	it('前日に記録していれば連続記録を伸ばす', async () => {
		const { posts } = mockDaily();
		const env = await testEnv();
		await env.FIT2BSKY_KV.put('MEASUREMENT_STREAK', '41');
		await env.FIT2BSKY_KV.put('LAST_MEASUREMENT_DATE', '2026-11-06');

		await runCron(env);

		expect(posts[0]).toContain('連続42日目');
		expect(await env.FIT2BSKY_KV.get('LAST_MEASUREMENT_DATE')).toBe(TODAY);
	});
});
