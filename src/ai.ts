import Anthropic from '@anthropic-ai/sdk';
import { WeightRecord } from './health';
import { selectComment } from './comments';
import { fetchWithTimeout } from './http';

declare global {
	interface AiModels {
		// wrangler 4.160 が生成する型にはまだ無いので足す。V4 の型は廃止で消えるので、汎用の chat completions の型を使う。
		// cf-typegen が生成するようになって型が食い違ったら（TS2717）、ここを消す
		'@cf/deepseek-ai/deepseek-v4.1-flash-1017': { inputs: ChatCompletionsInput; postProcessedOutputs: ChatCompletionsOutput };
	}
}

/** コメントの生成に使うモデル。#8 で Workers AI、OpenAI、Claude Haiku と出力を比べて決めた */
const MODEL = 'claude-opus-5-5';

/**
 * ダッシュボードのテスト生成で選べるモデル。MODEL と、MODEL の server-side fallback が作り直しに使えるモデル。
 * fallback で作り直すモデルは拒否の種類で API が決めるので、試すときは直接指定する
 */
export const TEST_MODELS = [MODEL, 'claude-opus-5', 'claude-opus-4-8'] as const;

/**
 * Anthropic の API が使えないときに使う、Workers AI のモデル。#8 の比較では DeepSeek の出力が良かった。
 * V4（0731 / 0813）は 2026-11-20 に廃止予定なので、後の V4.1 flash を使う
 */
export const DEEPSEEK_MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';

/** DeepSeek が書いたときの見出し */
const DEEPSEEK_LABEL = 'DeepSeek';

/** コメントの上限の文字数（書記素で数える）。投稿全体を Bluesky の 300 字に収めるため */
const MAX_COMMENT_LENGTH = 60;

/** 1 回の生成を待つ時間。比較のときの実測は平均 1.8 秒 */
const CLAUDE_TIMEOUT_MS = 30_000;

/** DeepSeek の生成を待つ時間。env.AI.run() は fetch を通らないので、fetchWithTimeout とは別に付ける */
const DEEPSEEK_TIMEOUT_MS = 30_000;

/** 文例から選んだときの見出し */
const FALLBACK_LABEL = '定型文';

/** 投稿の末尾に 見出し「本文」の形で添えるコメント。見出しは、コメントを書いたもの */
export interface AiComment {
	label: string;
	text: string;
}

/** Claude が作ったコメント。model は応答を書いたモデルの ID（見出しは系統の名前だけなので、テスト生成で見分けるため） */
export interface GeneratedComment extends AiComment {
	model: string;
}

export interface WeightContext {
	/** JST の YYYY-MM-DD */
	day: string;
	current: WeightRecord;
	yesterday: WeightRecord | null;
	oneMonthAgo: WeightRecord | null;
	oneYearAgo: WeightRecord | null;
	targetWeight: number;
	streakDays: number;
	/** 最近の投稿に添えたコメント。新しい順 */
	recentComments: string[];
}

const SYSTEM_PROMPT = `あなたは、本人の毎朝の体重を Bluesky に自動で投稿する bot の、ひとことコメントの担当です。
投稿の末尾に、書いたモデルの名前を見出しにして「…」の形で添える 1 文を書きます。

読者と目的: 投稿者本人は、自分の体重をいじるブラックジョークを気に入っていて、毎朝それを楽しみにしています。フォロワーも読む公開の投稿です。
投稿の形: コメントの上には、今日の体重、BMI、体脂肪率、連続記録の日数、前日比、前年比が数字で出ています。
トーン: 皮肉、上から目線、からかいは歓迎します。増えた日は辛口に、減った日も手放しでは褒めない調子を保ってください。
避けること: 容姿そのものの侮辱、病気や死、摂食障害、絶食や極端な減量を勧めること。公開の投稿で、本人以外も読むためです。
材料: 前日比と前年比は読者が本文の数字で読めるので、その数字を言い直すだけのコメントにはしないでください。差に触れるなら、その差が何を意味するかで皮肉ってください。本文に出ていない材料（1 か月前との差、目標までの残り、曜日、季節）から、その日らしさが出るものを 1 つか 2 つ選ぶのも歓迎します。記録の無い項目には触れないでください。
言い回し: 毎朝読まれるので、同じ型が続くと飽きられます。最近のコメントを渡したときは、それと書き出し、文末、文の型が重ならないようにしてください。減った日に「珍しい」「奇跡」と意外がる型に偏りやすいので、ほかの切り口も使ってください。
形式: 日本語の 1 文、${MAX_COMMENT_LENGTH} 文字以内。かぎかっこ、絵文字、ハッシュタグは付けず、コメントの本文だけを返してください。

今までの文例です（調子の参考で、これをなぞる必要はありません）:
- 増えた日: 夜食は記憶に残らなくても体重に残りますよ / 「一口だけ」が積もり積もった結果ですね / 重力との友情が深まる一方ですね
- 減った日: やればできる子でしたか。少し見直しました / 体重計「信じていいの…？」 / 目標まではまだ遠いので、浮かれるのは早いですよ
- 変わらない日: 安定という名の停滞、お見事です / 測るだけでは痩せませんよ / 動かざること山の如し、ですか`;

const COMMENT_SCHEMA = {
	type: 'object',
	properties: { comment: { type: 'string' } },
	required: ['comment'],
	additionalProperties: false,
};

const WEEKDAYS = ['日曜', '月曜', '火曜', '水曜', '木曜', '金曜', '土曜'];

function season(month: number): string {
	if (month >= 3 && month <= 5) return '春';
	if (month >= 6 && month <= 8) return '夏';
	if (month >= 9 && month <= 11) return '秋';
	return '冬';
}

/** 過去の体重との差（+0.3kg / -5.2kg / 0.0kg）。過去の記録が無ければ null */
export function formatDiff(current: WeightRecord, past: WeightRecord | null): string | null {
	if (!past) {
		return null;
	}
	// 投稿に出す小数 1 桁の体重どうしの差にする（134.04 と 133.96 は、どちらも 134.0kg と出るので 0.0kg）
	const d = (Math.round(current.weight * 10) - Math.round(past.weight * 10)) / 10;
	return `${d > 0 ? '+' : ''}${d.toFixed(1)}kg`;
}

/** 投稿とダッシュボードに出す 見出し「本文」 */
export function formatComment(comment: AiComment): string {
	return `${comment.label}「${comment.text}」`;
}

function diff(current: WeightRecord, past: WeightRecord | null): string {
	return formatDiff(current, past) ?? '記録なし';
}

/** モデルに渡すその日の材料 */
export function buildUserMessage(ctx: WeightContext): string {
	const date = new Date(`${ctx.day}T00:00:00Z`);
	// 小数 1 桁で表すので、丸めて 0.0 になる差は「ちょうど」として扱う
	const toTarget = Math.round((ctx.current.weight - ctx.targetWeight) * 10) / 10;
	const target = `目標体重 ${ctx.targetWeight.toFixed(1)}kg`;
	return [
		'今日の記録です。',
		`日付: ${ctx.day}（${WEEKDAYS[date.getUTCDay()]}、${season(date.getUTCMonth() + 1)}）`,
		`今日の体重: ${ctx.current.weight.toFixed(1)}kg`,
		`前日との差: ${diff(ctx.current, ctx.yesterday)}`,
		`1 か月前との差: ${diff(ctx.current, ctx.oneMonthAgo)}`,
		`1 年前との差: ${diff(ctx.current, ctx.oneYearAgo)}`,
		toTarget > 0
			? `${target} まで: あと ${toTarget.toFixed(1)}kg`
			: toTarget < 0
				? `${target} を ${(-toTarget).toFixed(1)}kg 下回っている`
				: `${target} ちょうど`,
		`連続記録: ${ctx.streakDays}日目`,
		...(ctx.recentComments.length > 0
			? ['', '最近のコメント（新しい順。これらと型が重ならないように）:', ...ctx.recentComments.map((c) => `- ${c}`)]
			: []),
	].join('\n');
}

/** モデルの ID から見出しを作る（claude-opus-5-5 → Claude Opus） */
function modelLabel(model: string): string {
	const family = /^claude-([a-z]+)/.exec(model)?.[1];
	return family ? `Claude ${family[0].toUpperCase()}${family.slice(1)}` : 'Claude';
}

function graphemeLength(text: string): number {
	return [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text)].length;
}

/**
 * Claude にその日のコメントを作らせる。使えない応答は例外にする。
 * 見出しは、実際に書いたモデル（server-side fallback で作り直したときは、そのモデル）にする。
 * model はテスト生成で fallback のモデルを試すときに渡す。そのときは server-side fallback を使わない。
 */
export async function generateWithClaude(env: Env, ctx: WeightContext, model: string = MODEL): Promise<GeneratedComment> {
	// 生成は他の API より遅いので、待ちを長めにとる（SDK にも同じ長さを伝える）。再試行は 1 回までにする
	const client = new Anthropic({
		apiKey: env.ANTHROPIC_API_KEY,
		fetch: (input, init) => fetchWithTimeout(input, init, CLAUDE_TIMEOUT_MS),
		timeout: CLAUDE_TIMEOUT_MS,
		maxRetries: 1,
	});
	// 安全の判定で拒否されたら、API が拒否の種類に合う別のモデルで作り直す（server-side fallback）
	const res = await client.beta.messages.create({
		...(model === MODEL ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
		model,
		max_tokens: 4000,
		system: SYSTEM_PROMPT,
		messages: [{ role: 'user', content: buildUserMessage(ctx) }],
		output_config: { effort: 'low', format: { type: 'json_schema', schema: COMMENT_SCHEMA } },
	});
	if (res.stop_reason !== 'end_turn') {
		throw Error(`AI comment: stop_reason=${res.stop_reason}`);
	}
	const text = res.content.find((b) => b.type === 'text')?.text ?? '';
	return { label: modelLabel(res.model), text: parseComment(text), model: res.model };
}

/** モデルが返した JSON からコメントの本文を取り出す。Claude と DeepSeek で同じ検査をする */
function parseComment(text: string): string {
	const { comment } = JSON.parse(text) as { comment?: unknown };
	if (typeof comment !== 'string') {
		throw Error('AI comment: 応答に comment が無い');
	}
	// 全体を 1 組の「」で囲んだときだけ外す（投稿で 見出し「…」の中に入れるため）。中に別の「」があれば、そのまま
	const trimmed = comment.trim().replace(/^「([^「」]*)」$/, '$1');
	const length = graphemeLength(trimmed);
	if (length === 0 || length > MAX_COMMENT_LENGTH) {
		throw Error(`AI comment: 長さが範囲外 (${length} 字): ${trimmed}`);
	}
	return trimmed;
}

/**
 * Anthropic の API そのものが使えない失敗か（5xx、529、429、接続の失敗、タイムアウト）。DeepSeek で作り直すのはこのときだけ。
 * 拒否は Claude が断った内容を別のモデルで通すことになり、長さや JSON の不正はモデルを替えても直らないので、文例にする。
 * 429 以外の 4xx（キーや要求の誤り）も文例にする
 */
export function isAnthropicUnavailable(e: unknown): boolean {
	// タイムアウト（APIConnectionTimeoutError）も APIConnectionError に入る
	return (
		e instanceof Anthropic.APIConnectionError ||
		e instanceof Anthropic.RateLimitError ||
		(e instanceof Anthropic.APIError && (e.status ?? 0) >= 500)
	);
}

/** Workers AI の DeepSeek にその日のコメントを作らせる。プロンプトと応答の検査は Claude と同じ */
export async function generateWithDeepSeek(env: Env, ctx: WeightContext): Promise<GeneratedComment> {
	const res = await env.AI.run(
		DEEPSEEK_MODEL,
		{
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: buildUserMessage(ctx) },
			],
			response_format: { type: 'json_schema', json_schema: { name: 'comment', schema: COMMENT_SCHEMA, strict: true } },
			// 推論の分も含む。Claude の effort: 'low' に合わせる
			reasoning_effort: 'low',
			max_tokens: 4000,
		},
		{ signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS) },
	);
	const choice = res.choices[0];
	if (choice?.finish_reason !== 'stop') {
		throw Error(`AI comment: DeepSeek finish_reason=${choice?.finish_reason}`);
	}
	return { label: DEEPSEEK_LABEL, text: parseComment(choice.message.content ?? ''), model: res.model || DEEPSEEK_MODEL };
}

/** 生成に失敗したときの、文例からの選択 */
export function fallbackComment(ctx: Pick<WeightContext, 'current' | 'oneMonthAgo'>): AiComment {
	return { label: FALLBACK_LABEL, text: selectComment(ctx.oneMonthAgo ? ctx.current.weight - ctx.oneMonthAgo.weight : null) };
}
