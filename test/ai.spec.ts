import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { buildUserMessage, formatDiff } from '../src/ai';
import { addDays } from '../src/date';
import { network } from './network';
import {
	CLAUDE_COMMENT,
	FORM_POST,
	TODAY,
	call,
	claudeText,
	errorLogs,
	filterDay,
	mockBluesky,
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

/** 投稿の末尾の 見出し「本文」 */
function postedComment(post: string): string {
	return post.split('\n').at(-1)!;
}

describe('AI コメント', () => {
	it('Claude が作ったコメントで投稿し、ダッシュボードにも同じものを出す', async () => {
		const { posts, messages } = mockDaily(FOUR_DAYS);
		const env = await testEnv();

		await call(env, '/post', FORM_POST);

		expect(posts[0]).toContain('連続1日目 | 前日比 -0.5kg | 前年比 +4.0kg | 1$=150.3円');
		expect(postedComment(posts[0])).toBe(`Claude Opus「${CLAUDE_COMMENT}」`);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			model: 'claude-opus-5-5',
			fallbacks: 'default',
			output_config: { effort: 'low', format: { type: 'json_schema' } },
		});
		expect(await errorContexts(env)).toEqual([]);

		const dashboard = await (await call(env, '/')).text();
		expect(dashboard).toContain(`Claude Opus「${CLAUDE_COMMENT}」`);
		// ダッシュボードは保存済みのコメントを読むだけで、生成し直さない
		expect(messages).toHaveLength(1);
	});

	it('安全の判定で別のモデルが作り直したら、そのモデルを見出しにする', async () => {
		const { posts } = mockDaily(FOUR_DAYS);
		mockClaude(() => claudeText(JSON.stringify({ comment: CLAUDE_COMMENT }), 'end_turn', 'claude-sonnet-5-5'));
		const env = await testEnv();

		await call(env, '/post', FORM_POST);

		expect(postedComment(posts[0])).toBe(`Claude Sonnet「${CLAUDE_COMMENT}」`);
		expect(await (await call(env, '/')).text()).toContain(`Claude Sonnet「${CLAUDE_COMMENT}」`);
	});

	it.each([
		[134.04, 134, '0.0kg'],
		[133.96, 134, '0.0kg'],
		// どちらも 134.0kg と出るので、差も 0.0kg にする
		[134.04, 133.96, '0.0kg'],
		[134.3, 134, '+0.3kg'],
		[128.8, 134, '-5.2kg'],
	])('今日 %d kg、過去 %d kg の差は %s', (today, past, expected) => {
		const record = (w: number) => ({ date: TODAY, time: '07:00:00', weight: w, fat: null, bmi: 34 });
		expect(formatDiff(record(today), record(past))).toBe(expected);
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
			recentComments: [],
		});
		expect(text).toContain('前日との差: 記録なし');
		expect(text).toContain('目標体重 120.0kg を 1.5kg 下回っている');
		expect(text).not.toContain('最近のコメント');
	});

	it('目標との差が丸めて 0.0kg なら「ちょうど」と渡す', () => {
		const current = { date: TODAY, time: '07:00:00', weight: 120.03, fat: null, bmi: 34 };
		const ctx = {
			day: TODAY,
			current,
			yesterday: null,
			oneMonthAgo: null,
			oneYearAgo: null,
			targetWeight: 120,
			streakDays: 3,
			recentComments: [],
		};
		expect(buildUserMessage(ctx)).toContain('目標体重 120.0kg ちょうど');
	});

	it('最近 7 日分のコメントを新しい順に渡し、投稿したコメントを先頭に足す', async () => {
		const { messages } = mockDaily(FOUR_DAYS);
		const env = await testEnv();
		const entry = (n: number) => ({ day: addDays(TODAY, -n), text: `${n} 日前のコメント` });
		const lastWeek = [1, 2, 3, 4, 5, 6, 7].map(entry);
		// 今日の分（二重に投稿したときの名残）と、8 日前の分は渡さない
		await env.FIT2BSKY_KV.put('RECENT_AI_COMMENTS', JSON.stringify([entry(0), ...lastWeek, entry(8)]));

		await call(env, '/post', FORM_POST);

		const user = (messages[0].messages as { content: string }[])[0].content;
		expect(user).toContain(['最近のコメント（新しい順。これらと型が重ならないように）:', ...lastWeek.map((c) => `- ${c.text}`)].join('\n'));
		expect(user).not.toContain('0 日前のコメント');
		expect(user).not.toContain('8 日前のコメント');
		// 次の日に 7 日前になる分は、次の日の読み出しで落ちる
		expect(await env.FIT2BSKY_KV.get('RECENT_AI_COMMENTS', 'json')).toEqual([{ day: TODAY, text: CLAUDE_COMMENT }, ...lastWeek]);
	});

	it('最近のコメントが読めなくても、Claude に作らせる', async () => {
		const { posts, messages } = mockDaily(FOUR_DAYS);
		const env = await testEnv();
		await env.FIT2BSKY_KV.put('RECENT_AI_COMMENTS', '{}');

		await call(env, '/post', FORM_POST);

		expect(messages).toHaveLength(1);
		expect(postedComment(posts[0])).toBe(`Claude Opus「${CLAUDE_COMMENT}」`);
	});

	it.each([
		['「全体を囲んだ一文」', '全体を囲んだ一文'],
		['「一口だけ」と「もう一口」ですか', '「一口だけ」と「もう一口」ですか'],
		['「一口だけ」と「もう一口」', '「一口だけ」と「もう一口」'],
	])('コメント %s の外側の「」は、1 組で全体を囲むときだけ外す', async (raw, posted) => {
		const { posts } = mockDaily(FOUR_DAYS);
		mockClaude(() => claudeText(JSON.stringify({ comment: raw })));
		await call(await testEnv(), '/post', FORM_POST);
		expect(postedComment(posts[0])).toBe(`Claude Opus「${posted}」`);
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
		expect(postedComment(posts[0])).toMatch(/^定型文「.+」$/);
		expect(posts[0]).not.toContain(CLAUDE_COMMENT);
		const errors = await errorContexts(env);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/^ai_comment: /);
		expect(errors[0]).toContain(logged);
		// 投稿した文例は、ダッシュボードに出すために保存する
		expect(await (await call(env, '/')).text()).toContain(postedComment(posts[0]));
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

	it('投稿に失敗したら、次の実行では保存したコメントと見出しを使い、生成し直さない', async () => {
		const { requests } = mockDaily(FOUR_DAYS, { bskyFail: true });
		const first = mockClaude(() => claudeText(JSON.stringify({ comment: CLAUDE_COMMENT }), 'end_turn', 'claude-sonnet-5-5'));
		const env = await testEnv();
		await call(env, '/post', FORM_POST);
		expect(await env.FIT2BSKY_KV.get('RECENT_AI_COMMENTS')).toBeNull();
		requests.length = 0;

		const retry = mockClaude();
		const { posts } = mockBluesky();
		await call(env, '/post', FORM_POST);

		expect(first.messages).toHaveLength(1);
		expect(retry.messages).toHaveLength(0);
		expect(postedComment(posts[0])).toBe(`Claude Sonnet「${CLAUDE_COMMENT}」`);
		// 投稿に出す差のために前日と 1 年前は取るが、コメントにだけ使う 1 か月前は取らない
		expect(requests.map(filterDay).sort()).toEqual(['2025-11-07', '2026-11-06', TODAY, TODAY]);
		expect(posts[0]).toContain('前日比 -0.5kg | 前年比 +4.0kg');
		expect(await env.FIT2BSKY_KV.get('RECENT_AI_COMMENTS', 'json')).toEqual([{ day: TODAY, text: CLAUDE_COMMENT }]);
	});

	it('見出しを保存する前に作ったコメントは、見出しを AI にする', async () => {
		const { posts, messages } = mockDaily(FOUR_DAYS);
		const env = await testEnv();
		await env.FIT2BSKY_KV.put(`AI_COMMENT_${TODAY}`, '前のコメント');

		await call(env, '/post', FORM_POST);

		expect(messages).toHaveLength(0);
		expect(postedComment(posts[0])).toBe('AI「前のコメント」');
	});

	it('まだ作っていない日は、ダッシュボードにコメントを出さず、生成もしない', async () => {
		const { messages } = mockDaily(FOUR_DAYS);
		const dashboard = await (await call(await testEnv(), '/')).text();

		expect(dashboard).not.toContain('ai-comment">');
		expect(messages).toHaveLength(0);
	});
});

describe('コメントのテスト生成', () => {
	function testForm(source: string): RequestInit {
		return { ...FORM_POST, body: new URLSearchParams({ source }) };
	}

	/** 本番のコメント、最近のコメント、連続記録、投稿のフラグ。テスト生成はどれも変えない */
	async function savedState(env: Env) {
		const kv = env.FIT2BSKY_KV;
		return Promise.all(
			[`AI_COMMENT_${TODAY}`, 'RECENT_AI_COMMENTS', 'MEASUREMENT_STREAK', 'LAST_MEASUREMENT_DATE', `BSKY_POST_${TODAY}`].map((k) =>
				kv.get(k),
			),
		);
	}

	it.each(['claude-opus-5', 'claude-opus-4-8'])('%s を選ぶと、server-side fallback を付けずにそのモデルで作る', async (model) => {
		const { posts } = mockDaily(FOUR_DAYS);
		const { messages } = mockClaude((body) => claudeText(JSON.stringify({ comment: CLAUDE_COMMENT }), 'end_turn', String(body.model)));
		const env = await testEnv();

		const res = await call(env, '/comment/test', testForm(model));

		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text.split('\n')[0]).toBe(`Claude Opus「${CLAUDE_COMMENT}」`);
		// 見出しはどれも Claude Opus なので、書いたモデルの ID も出す
		expect(text).toContain(`書いたモデル: ${model}`);
		expect(text).toContain('前日との差: -0.5kg');
		expect(messages[0]).toMatchObject({ model });
		expect(messages[0]).not.toHaveProperty('fallbacks');
		expect(posts).toHaveLength(0);
		expect(await savedState(env)).toEqual([null, null, null, null, null]);
	});

	it('claude-opus-5-5 を選ぶと、本番と同じく server-side fallback を付け、作り直したモデルを出す', async () => {
		mockDaily(FOUR_DAYS);
		const { messages } = mockClaude(() => claudeText(JSON.stringify({ comment: CLAUDE_COMMENT }), 'end_turn', 'claude-opus-4-8'));
		const res = await call(await testEnv(), '/comment/test', testForm('claude-opus-5-5'));

		expect(res.status).toBe(200);
		expect(messages[0]).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default' });
		expect(await res.text()).toContain('書いたモデル: claude-opus-4-8');
	});

	it('定型文を選ぶと、Claude を呼ばずに文例から選び、材料は出さない', async () => {
		const { messages } = mockDaily(FOUR_DAYS);
		const res = await call(await testEnv(), '/comment/test', testForm('template'));

		expect(res.status).toBe(200);
		expect(await res.text()).toMatch(/^定型文「[^\n]+」$/);
		expect(messages).toHaveLength(0);
	});

	it('最近のコメントが読めなくても、渡さずに作る', async () => {
		const { messages } = mockDaily(FOUR_DAYS);
		const env = await testEnv();
		await env.FIT2BSKY_KV.put('RECENT_AI_COMMENTS', '{壊れた JSON');

		const res = await call(env, '/comment/test', testForm('claude-opus-5-5'));

		expect(res.status).toBe(200);
		expect((messages[0].messages as { content: string }[])[0].content).not.toContain('最近のコメント');
	});

	it('連続記録と最近のコメントは、投稿のときと同じものを渡し、書き換えない', async () => {
		const { messages } = mockDaily(FOUR_DAYS);
		const env = await testEnv();
		const kv = env.FIT2BSKY_KV;
		await kv.put('MEASUREMENT_STREAK', '41');
		await kv.put('LAST_MEASUREMENT_DATE', '2026-11-06');
		await kv.put('RECENT_AI_COMMENTS', JSON.stringify([{ day: '2026-11-06', text: '昨日のコメント' }]));

		await call(env, '/comment/test', testForm('claude-opus-5-5'));

		const user = (messages[0].messages as { content: string }[])[0].content;
		expect(user).toContain('連続記録: 42日目');
		expect(user).toContain('- 昨日のコメント');
		expect(await kv.get('MEASUREMENT_STREAK')).toBe('41');
		expect(await kv.get('LAST_MEASUREMENT_DATE')).toBe('2026-11-06');
	});

	it('Claude の生成に失敗したら 500 を返し、エラーログには残さない', async () => {
		mockDaily(FOUR_DAYS);
		mockClaude(() => claudeText('', 'refusal'));
		const env = await testEnv();

		const res = await call(env, '/comment/test', testForm('claude-opus-5'));

		expect(res.status).toBe(500);
		expect(await res.text()).toContain('stop_reason=refusal');
		expect(await errorLogs(env)).toEqual([]);
	});

	it('選べないものを渡したら 400 を返し、Claude を呼ばない', async () => {
		const { messages } = mockDaily(FOUR_DAYS);
		const res = await call(await testEnv(), '/comment/test', testForm('claude-haiku-5-5'));

		expect(res.status).toBe(400);
		expect(messages).toHaveLength(0);
	});

	it('ダッシュボードに、モデルと定型文を選んで試すフォームを出す', async () => {
		mockDaily(FOUR_DAYS);
		const dashboard = await (await call(await testEnv(), '/')).text();

		expect(dashboard).toContain('action="/comment/test"');
		for (const value of ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'template']) {
			expect(dashboard).toContain(`<option value="${value}">`);
		}
	});
});
