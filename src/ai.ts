import Anthropic from '@anthropic-ai/sdk';
import { WeightRecord } from './health';
import { selectComment } from './comments';
import { fetchWithTimeout } from './http';

/** コメントの生成に使うモデル。#8 で Workers AI、OpenAI、Claude Haiku と出力を比べて決めた */
const MODEL = 'claude-opus-5-5';

/** コメントの上限の文字数（書記素で数える）。投稿全体を Bluesky の 300 字に収めるため */
const MAX_COMMENT_LENGTH = 60;

/** 1 回の生成を待つ時間。比較のときの実測は平均 1.8 秒 */
const CLAUDE_TIMEOUT_MS = 30_000;

export interface WeightContext {
	/** JST の YYYY-MM-DD */
	day: string;
	current: WeightRecord;
	yesterday: WeightRecord | null;
	oneMonthAgo: WeightRecord | null;
	oneYearAgo: WeightRecord | null;
	targetWeight: number;
	streakDays: number;
}

const SYSTEM_PROMPT = `あなたは、本人の毎朝の体重を Bluesky に自動で投稿する bot の、ひとことコメントの担当です。
投稿の末尾に AI「…」の形で添える 1 文を書きます。

読者と目的: 投稿者本人は、自分の体重をいじるブラックジョークを気に入っていて、毎朝それを楽しみにしています。フォロワーも読む公開の投稿です。
トーン: 皮肉、上から目線、からかいは歓迎します。増えた日は辛口に、減った日は素直に褒めずに疑ってかかる、という今までの調子を保ってください。
避けること: 容姿そのものの侮辱、病気や死、摂食障害、絶食や極端な減量を勧めること。公開の投稿で、本人以外も読むためです。
材料: 渡す数値（前日や 1 か月前、1 年前との差、目標までの残り、連続記録の日数、曜日、季節）から、その日らしさが出るものを 1 つか 2 つ選んで使ってください。数字を並べるだけにはしないでください。記録の無い項目には触れないでください。
形式: 日本語の 1 文、${MAX_COMMENT_LENGTH} 文字以内。かぎかっこ、絵文字、ハッシュタグは付けず、コメントの本文だけを返してください。

今までの文例です（調子の参考で、これをなぞる必要はありません）:
- 増えた日: 重力との友情が2.1kg分深まりましたね / 「一口だけ」が積もり積もって1.5kgですか / 夜食は記憶に残らなくても体重に残りますよ
- 減った日: やればできる子でしたか。0.8kg分見直しました / 奇跡は続くものではありませんが、期待しておきます / 体重計「信じていいの…？」
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

function diff(current: WeightRecord, past: WeightRecord | null): string {
	if (!past) {
		return '記録なし';
	}
	const d = current.weight - past.weight;
	return `${d > 0 ? '+' : ''}${d.toFixed(1)}kg`;
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
	].join('\n');
}

function graphemeLength(text: string): number {
	return [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text)].length;
}

/** Claude にその日のコメントを作らせる。使えない応答は例外にする */
export async function generateWithClaude(env: Env, ctx: WeightContext): Promise<string> {
	// 生成は他の API より遅いので、待ちを長めにとる（SDK にも同じ長さを伝える）。再試行は 1 回までにする
	const client = new Anthropic({
		apiKey: env.ANTHROPIC_API_KEY,
		fetch: (input, init) => fetchWithTimeout(input, init, CLAUDE_TIMEOUT_MS),
		timeout: CLAUDE_TIMEOUT_MS,
		maxRetries: 1,
	});
	// 安全の判定で拒否されたら、API が拒否の種類に合う別のモデルで作り直す（server-side fallback）
	const res = await client.beta.messages.create({
		betas: ['server-side-fallback-2026-07-01'],
		fallbacks: 'default',
		model: MODEL,
		max_tokens: 4000,
		system: SYSTEM_PROMPT,
		messages: [{ role: 'user', content: buildUserMessage(ctx) }],
		output_config: { effort: 'low', format: { type: 'json_schema', schema: COMMENT_SCHEMA } },
	});
	if (res.stop_reason !== 'end_turn') {
		throw Error(`AI comment: stop_reason=${res.stop_reason}`);
	}
	const text = res.content.find((b) => b.type === 'text')?.text ?? '';
	const { comment } = JSON.parse(text) as { comment?: unknown };
	if (typeof comment !== 'string') {
		throw Error('AI comment: 応答に comment が無い');
	}
	// 全体を 1 組の「」で囲んだときだけ外す（投稿で AI「…」の中に入れるため）。中に別の「」があれば、そのまま
	const trimmed = comment.trim().replace(/^「([^「」]*)」$/, '$1');
	const length = graphemeLength(trimmed);
	if (length === 0 || length > MAX_COMMENT_LENGTH) {
		throw Error(`AI comment: 長さが範囲外 (${length} 字): ${trimmed}`);
	}
	return trimmed;
}

/** 生成に失敗したときの、文例からの選択 */
export function fallbackComment(ctx: WeightContext): string {
	return selectComment(ctx.oneMonthAgo ? ctx.current.weight - ctx.oneMonthAgo.weight : null);
}
