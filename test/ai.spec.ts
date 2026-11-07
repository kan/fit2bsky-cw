import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { buildUserMessage } from '../src/ai';
import { network } from './network';
import {
	CLAUDE_COMMENT,
	FORM_POST,
	TODAY,
	call,
	claudeText,
	errorLogs,
	filterDay,
	mockClaude,
	mockDaily,
	oneWeight,
	testEnv,
} from './helpers';

async function errorContexts(env: Env): Promise<string[]> {
	return (await errorLogs(env)).map((l) => `${l.context}: ${l.error}`);
}

/** 今日、前日、1 か月前、1 年前の体重 */
const FOUR_DAYS = {
	...oneWeight(TODAY, 134),
	...oneWeight('2026-11-06', 134.5),
	...oneWeight('2026-10-08', 136),
	...oneWeight('2025-11-07', 130),
};

describe('AI コメント', () => {
	it('Claude が作ったコメントで投稿し、ダッシュボードにも同じものを出す', async () => {
		const { posts, messages } = mockDaily(FOUR_DAYS);
		const env = await testEnv();

		await call(env, '/post', FORM_POST);

		expect(posts[0]).toContain(`AI「${CLAUDE_COMMENT}」`);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			model: 'claude-opus-5-5',
			fallbacks: 'default',
			output_config: { effort: 'low', format: { type: 'json_schema' } },
		});
		expect(await errorContexts(env)).toEqual([]);

		const dashboard = await (await call(env, '/')).text();
		expect(dashboard).toContain(CLAUDE_COMMENT);
		// ダッシュボードは保存済みのコメントを読むだけで、生成し直さない
		expect(messages).toHaveLength(1);
	});

	it('前日、1 か月前、1 年前との差と、目標までの残りを渡す', async () => {
		const { messages } = mockDaily(FOUR_DAYS);
		await call(await testEnv(), '/post', FORM_POST);

		const user = (messages[0].messages as { content: string }[])[0].content;
		expect(user).toContain('日付: 2026-11-07（土曜、秋）');
		expect(user).toContain('前日との差: -0.5kg');
		expect(user).toContain('1 か月前との差: -2.0kg');
		expect(user).toContain('1 年前との差: +4.0kg');
		expect(user).toContain('目標体重 120.0kg まで: あと 14.0kg');
		expect(user).toContain('連続記録: 1日目');
	});

	it('過去の記録が無い項目は「記録なし」にし、目標を下回れば下回った量を渡す', () => {
		const current = { date: TODAY, time: '07:00:00', weight: 118.5, fat: null, bmi: 34 };
		const text = buildUserMessage({
			day: TODAY,
			current,
			yesterday: null,
			oneMonthAgo: null,
			oneYearAgo: null,
			targetWeight: 120,
			streakDays: 3,
		});
		expect(text).toContain('前日との差: 記録なし');
		expect(text).toContain('目標体重 120.0kg を 1.5kg 下回っている');
	});

	it('目標との差が丸めて 0.0kg なら「ちょうど」と渡す', () => {
		const current = { date: TODAY, time: '07:00:00', weight: 120.03, fat: null, bmi: 34 };
		const ctx = { day: TODAY, current, yesterday: null, oneMonthAgo: null, oneYearAgo: null, targetWeight: 120, streakDays: 3 };
		expect(buildUserMessage(ctx)).toContain('目標体重 120.0kg ちょうど');
	});

	it.each([
		['「全体を囲んだ一文」', '全体を囲んだ一文'],
		['「一口だけ」と「もう一口」ですか', '「一口だけ」と「もう一口」ですか'],
		['「一口だけ」と「もう一口」', '「一口だけ」と「もう一口」'],
	])('コメント %s の外側の「」は、1 組で全体を囲むときだけ外す', async (raw, posted) => {
		const { posts } = mockDaily(FOUR_DAYS);
		mockClaude(() => claudeText(JSON.stringify({ comment: raw })));
		await call(await testEnv(), '/post', FORM_POST);
		expect(posts[0]).toContain(`AI「${posted}」`);
	});

	it.each([
		[
			'API のエラー',
			() => HttpResponse.json({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, { status: 529 }),
			'529',
		],
		['拒否', () => claudeText('', 'refusal'), 'stop_reason=refusal'],
		['長すぎる', () => claudeText(JSON.stringify({ comment: 'あ'.repeat(61) })), '61 字'],
		['JSON でない', () => claudeText('ただの文'), 'JSON'],
	])('%s なら文例に戻して投稿し、エラーログに残す', async (_name, reply, logged) => {
		const { posts } = mockDaily(FOUR_DAYS);
		mockClaude(reply);
		const env = await testEnv();

		const res = await call(env, '/post', FORM_POST);

		expect(res.status).toBe(200);
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatch(/AI「.+」$/);
		expect(posts[0]).not.toContain(CLAUDE_COMMENT);
		const errors = await errorContexts(env);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/^ai_comment: /);
		expect(errors[0]).toContain(logged);
		// 投稿した文例は、ダッシュボードに出すために保存する
		expect(await (await call(env, '/')).text()).toContain(posts[0].match(/AI「(.+)」$/)![1]);
	});

	it('生成も投稿も失敗したら文例は保存せず、次の実行で Claude に作り直させる', async () => {
		const { posts } = mockDaily(FOUR_DAYS, { bskyFail: true });
		mockClaude(() => HttpResponse.json({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, { status: 529 }));
		const env = await testEnv();
		await call(env, '/post', FORM_POST);
		expect(posts).toHaveLength(0);

		const { messages } = mockClaude();
		network.use(http.post('https://bsky.social/xrpc/com.atproto.repo.createRecord', () => HttpResponse.json({ uri: 'at://x', cid: 'y' })));
		await call(env, '/post', FORM_POST);

		expect(messages).toHaveLength(1);
	});

	it('投稿に失敗したら、次の実行では保存したコメントを使い、生成し直さず過去の体重も取らない', async () => {
		const { posts, messages, requests } = mockDaily(FOUR_DAYS, { bskyFail: true });
		const env = await testEnv();
		await call(env, '/post', FORM_POST);
		expect(posts).toHaveLength(0);
		requests.length = 0;

		network.use(http.post('https://bsky.social/xrpc/com.atproto.repo.createRecord', () => HttpResponse.json({ uri: 'at://x', cid: 'y' })));
		await call(env, '/post', FORM_POST);

		expect(messages).toHaveLength(1);
		// 体重と体脂肪率の、今日の分だけ
		expect(requests.map(filterDay)).toEqual([TODAY, TODAY]);
	});

	it('まだ作っていない日は、ダッシュボードにコメントを出さず、生成もしない', async () => {
		const { messages } = mockDaily(FOUR_DAYS);
		const dashboard = await (await call(await testEnv(), '/')).text();

		expect(dashboard).not.toContain('ai-comment">');
		expect(messages).toHaveLength(0);
	});
});
