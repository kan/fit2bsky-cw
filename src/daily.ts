import health, { WeightRecord } from './health';
import bluesky from './bluesky';
import sheet from './sheet';
import { getJPYRate } from './fx';
import {
	AiComment,
	TEST_MODELS,
	WeightContext,
	buildUserMessage,
	fallbackComment,
	formatComment,
	formatDiff,
	generateWithClaude,
} from './ai';
import { addDays, jstDate, sameDayLastYear } from './date';

const BSKY_POST_KEY_PREFIX = 'BSKY_POST_';
const SHEET_WRITE_KEY_PREFIX = 'SHEET_WRITE_';
const ERROR_LOG_KEY_PREFIX = 'ERROR_LOG_';
const AI_COMMENT_KEY_PREFIX = 'AI_COMMENT_';
const RECENT_COMMENTS_KEY = 'RECENT_AI_COMMENTS';
/** Claude に渡す最近のコメントの日数 */
const RECENT_COMMENTS_DAYS = 7;
/** KV の metadata に見出しが無いときの見出し（見出しを保存する前に作ったコメント） */
const LEGACY_LABEL = 'AI';
const STREAK_KEY = 'MEASUREMENT_STREAK';
const LAST_MEASUREMENT_KEY = 'LAST_MEASUREMENT_DATE';

export async function getErrorLogs(kv: KVNamespace, day: string): Promise<unknown[] | null> {
	return kv.get<unknown[]>(`${ERROR_LOG_KEY_PREFIX}${day}`, 'json');
}

/** エラーを Workers Logs（console.error）と KV に残す。KV の方はダッシュボードと /errors が読む。 */
export async function logError(kv: KVNamespace, context: string, error: unknown): Promise<void> {
	// Error をそのまま渡すと、Workers Logs にスタックトレースが残る
	console.error(`[${context}]`, error);
	const message = error instanceof Error ? error.message : String(error);
	const key = `${ERROR_LOG_KEY_PREFIX}${jstDate()}`;
	const logs = (await kv.get<unknown[]>(key, 'json')) ?? [];
	logs.push({
		timestamp: new Date().toISOString(),
		context,
		error: message,
	});
	await kv.put(key, JSON.stringify(logs), { expirationTtl: 86400 * 7 });
}

export interface DailyStatus {
	blueskyPosted: boolean;
	sheetWritten: boolean;
}

export async function getDailyStatus(kv: KVNamespace, day: string): Promise<DailyStatus> {
	const [posted, written] = await Promise.all([kv.get(`${BSKY_POST_KEY_PREFIX}${day}`), kv.get(`${SHEET_WRITE_KEY_PREFIX}${day}`)]);
	return { blueskyPosted: posted !== null, sheetWritten: written !== null };
}

export async function getStreak(kv: KVNamespace): Promise<number> {
	const streak = await kv.get(STREAK_KEY);
	return streak ? parseInt(streak, 10) : 0;
}

/** day に記録したときの連続記録の日数。changed は、KV に書き直す必要があるとき true */
async function countStreak(kv: KVNamespace, day: string): Promise<{ streak: number; changed: boolean }> {
	const [lastDate, current] = await Promise.all([kv.get(LAST_MEASUREMENT_KEY), getStreak(kv)]);
	if (lastDate === day) {
		return { streak: current, changed: false };
	}
	return { streak: lastDate === addDays(day, -1) ? current + 1 : 1, changed: true };
}

async function updateStreak(kv: KVNamespace, day: string): Promise<number> {
	const { streak, changed } = await countStreak(kv, day);
	if (changed) {
		await Promise.all([kv.put(STREAK_KEY, streak.toString()), kv.put(LAST_MEASUREMENT_KEY, day)]);
	}
	return streak;
}

export function formatFat(fat: number | null): string {
	return fat !== null ? `${fat.toFixed(2)}%` : '-';
}

type Weights = Pick<WeightContext, 'current' | 'yesterday' | 'oneMonthAgo' | 'oneYearAgo'>;

function formatPostMessage(weights: Weights, streakDays: number, jpy: number, comment: AiComment): string {
	const { current, yesterday, oneYearAgo } = weights;
	return `今日の体重: ${current.weight.toFixed(1)}kg (BMI: ${current.bmi.toFixed(2)}) 体脂肪率: ${formatFat(current.fat)}
連続${streakDays}日目 | 前日比 ${formatDiff(current, yesterday) ?? '-'} | 前年比 ${formatDiff(current, oneYearAgo) ?? '-'} | 1$=${jpy.toFixed(1)}円

${formatComment(comment)}`;
}

/**
 * 今日と一緒に取る過去の体重。
 * none: 取らない（シートへの書き込みだけのとき）
 * post: 投稿に出す前日と 1 年前だけ（作り済みのコメントで投稿し直すとき）
 * all: コメントの材料の 1 か月前も取る
 */
type PastWeights = 'none' | 'post' | 'all';

/** 今日の体重を取る。 */
export async function getTodayWeight(env: Env, day: string): Promise<WeightRecord> {
	return health.getWeight(env, await health.getAccessToken(env), day);
}

/**
 * 今日の体重と、pastWeights で選んだ過去の体重を並列に取る。access token は 1 回だけ取る。
 * 過去の体重は差にだけ使うので体脂肪率は取らず、取れなければ null にする。
 * 記録が無い以外の理由で取れなかったときは、Workers Logs にだけ残す（差が「-」になり、コメントの材料が減るだけなので）。
 */
async function getWeights(env: Env, day: string, pastWeights: PastWeights): Promise<Weights> {
	const token = await health.getAccessToken(env);
	const past = async (pastDay: string, needed: boolean): Promise<WeightRecord | null> => {
		if (!needed) {
			return null;
		}
		try {
			return await health.getWeight(env, token, pastDay, { withFat: false });
		} catch (e) {
			if (!(e instanceof Error && e.message.startsWith('No weight data'))) {
				console.error(`[past_weight ${pastDay}]`, e);
			}
			return null;
		}
	};
	const [current, yesterday, oneMonthAgo, oneYearAgo] = await Promise.all([
		health.getWeight(env, token, day),
		past(addDays(day, -1), pastWeights !== 'none'),
		past(addDays(day, -30), pastWeights === 'all'),
		past(sameDayLastYear(day), pastWeights !== 'none'),
	]);
	return { current, yesterday, oneMonthAgo, oneYearAgo };
}

/** その日のコメントを読む。まだ作っていなければ null。ダッシュボードはこれだけを表示する。 */
export async function getSavedComment(kv: KVNamespace, day: string): Promise<AiComment | null> {
	// 見出しは本文と一緒に metadata へ保存している
	const { value, metadata } = await kv.getWithMetadata<{ label?: string }>(`${AI_COMMENT_KEY_PREFIX}${day}`);
	return value === null ? null : { label: metadata?.label ?? LEGACY_LABEL, text: value };
}

/** その日のコメントを保存する。失敗してもエラーログに残すだけで、投稿は止めない。 */
async function saveComment(kv: KVNamespace, day: string, comment: AiComment, logPrefix: string): Promise<void> {
	try {
		await kv.put(`${AI_COMMENT_KEY_PREFIX}${day}`, comment.text, { expirationTtl: 86400, metadata: { label: comment.label } });
	} catch (e) {
		await logError(kv, `${logPrefix}ai_comment_save`, e).catch(() => {});
	}
}

interface RecentComment {
	day: string;
	text: string;
}

/** day より前の、直近 RECENT_COMMENTS_DAYS 日に投稿したコメント。新しい順 */
async function getRecentComments(kv: KVNamespace, day: string): Promise<RecentComment[]> {
	const saved = await kv.get<RecentComment[]>(RECENT_COMMENTS_KEY, 'json');
	const since = addDays(day, -RECENT_COMMENTS_DAYS);
	// YYYY-MM-DD は文字列のまま比べられる
	return Array.isArray(saved) ? saved.filter((c) => c.day >= since && c.day < day) : [];
}

/** Claude に渡す最近のコメントの本文。材料の 1 つなので、読めなければ渡さずに生成する */
async function recentCommentTexts(kv: KVNamespace, day: string): Promise<string[]> {
	try {
		return (await getRecentComments(kv, day)).map((c) => c.text);
	} catch (e) {
		console.error('[recent_comments]', e);
		return [];
	}
}

/**
 * 投稿したコメントを、最近のコメントの先頭に足す。Claude に渡して、同じ型が続かないようにするため。
 * 失敗してもエラーログに残すだけにする（投稿は済んでいる）。
 */
async function addRecentComment(kv: KVNamespace, day: string, text: string, logPrefix: string): Promise<void> {
	try {
		const recent = await getRecentComments(kv, day);
		await kv.put(RECENT_COMMENTS_KEY, JSON.stringify([{ day, text }, ...recent]));
	} catch (e) {
		await logError(kv, `${logPrefix}recent_comments_save`, e).catch(() => {});
	}
}

/**
 * その日のコメントを Claude に作らせる。最近のコメントも渡す。作れたら保存し、投稿の再試行で使い回す。
 * 生成に失敗したら文例から選び、その失敗をエラーログに残す（投稿は止めない）。文例はここでは保存しない。
 * 再試行のときに、Claude で作り直せるようにするため。
 */
async function createComment(env: Env, ctx: Omit<WeightContext, 'recentComments'>, logPrefix: string): Promise<AiComment> {
	const kv = env.FIT2BSKY_KV;
	const recentComments = await recentCommentTexts(kv, ctx.day);
	try {
		const comment = await generateWithClaude(env, { ...ctx, recentComments });
		await saveComment(kv, ctx.day, comment, logPrefix);
		return comment;
	} catch (e) {
		await logError(kv, `${logPrefix}ai_comment`, e);
		return fallbackComment(ctx);
	}
}

/** テスト生成で選べるもの。TEST_MODELS のどれかか、文例（template） */
export type TestCommentSource = (typeof TEST_MODELS)[number] | 'template';

export function isTestCommentSource(value: unknown): value is TestCommentSource {
	return value === 'template' || TEST_MODELS.some((m) => m === value);
}

/**
 * 今日の材料でコメントを試しに作る。ダッシュボードのテスト生成用。
 * 本番のコメント、最近のコメント、連続記録は変えず、投稿もしない。失敗はそのまま例外にする（エラーログにも残さない）。
 */
export async function generateTestComment(env: Env, source: TestCommentSource): Promise<string> {
	const kv = env.FIT2BSKY_KV;
	const day = jstDate();
	// 連続記録は書き込まずに数える（投稿の前に試しても、投稿のときと同じ日数にする）
	const [weights, { streak: streakDays }, recentComments] = await Promise.all([
		getWeights(env, day, 'all'),
		countStreak(kv, day),
		recentCommentTexts(kv, day),
	]);
	const ctx = { day, ...weights, targetWeight: parseFloat(env.TARGET_WEIGHT), streakDays, recentComments };
	if (source === 'template') {
		return formatComment(fallbackComment(ctx));
	}
	const comment = await generateWithClaude(env, ctx, source);
	// 見出しは系統の名前だけなので、server-side fallback で作り直したかは model で見分ける
	return `${formatComment(comment)}\n\n書いたモデル: ${comment.model}\n\n--- Claude に渡した材料 ---\n${buildUserMessage(ctx)}`;
}

export interface DailyResult {
	/** 行った処理のどれかが失敗したとき false */
	ok: boolean;
	messages: string[];
}

/**
 * その日のシートへの書き込みと（post が true なら）投稿を、まだ済んでいないものだけ行う。
 * cron と手動の実行で共有する。logPrefix はエラーログの context の頭に付け、cron と手動の実行を見分ける。
 */
export async function runDaily(env: Env, { post }: { post: boolean }, logPrefix = ''): Promise<DailyResult> {
	const messages: string[] = [];
	try {
		const ok = await runDailyTasks(env, post, logPrefix, messages);
		return { ok, messages };
	} catch (e) {
		// KV の読み書きなど、個別に扱っていない失敗もエラーログに残す
		await logError(env.FIT2BSKY_KV, `${logPrefix}daily`, e).catch(() => {});
		messages.push(`エラー - ${e}`);
		return { ok: false, messages };
	}
}

async function runDailyTasks(env: Env, post: boolean, logPrefix: string, messages: string[]): Promise<boolean> {
	const kv = env.FIT2BSKY_KV;
	const day = jstDate();
	const status = await getDailyStatus(kv, day);
	const doPost = post && !status.blueskyPosted;
	const doSheet = !status.sheetWritten;

	if (post && !doPost) {
		messages.push('Bluesky: 本日は投稿済みです');
	}
	if (!doSheet) {
		messages.push('Sheet: 本日は書き込み済みです');
	}
	if (!doPost && !doSheet) {
		return true;
	}

	// 投稿の再試行では、作り済みのコメントを使う。そのときは投稿に出す差の分だけ過去の体重を取る
	const savedComment = doPost ? await getSavedComment(kv, day) : null;
	let weights;
	try {
		weights = await getWeights(env, day, !doPost ? 'none' : savedComment === null ? 'all' : 'post');
	} catch (e) {
		await logError(kv, `${logPrefix}health_get_weight`, e);
		messages.push(`体重の取得: エラー - ${e}`);
		return false;
	}
	let ok = true;
	const { current } = weights;
	const streakDays = await updateStreak(kv, day);

	if (doPost) {
		try {
			const jpy = await getJPYRate();
			const comment =
				savedComment ?? (await createComment(env, { day, ...weights, targetWeight: parseFloat(env.TARGET_WEIGHT), streakDays }, logPrefix));
			await bluesky.postMessage(env, formatPostMessage(weights, streakDays, jpy, comment));
			await kv.put(`${BSKY_POST_KEY_PREFIX}${day}`, 'posted', { expirationTtl: 86400 });
			// 投稿したコメントをダッシュボードに出すため。文例を使ったときは、ここで初めて保存する
			if (savedComment === null) {
				await saveComment(kv, day, comment, logPrefix);
			}
			await addRecentComment(kv, day, comment.text, logPrefix);
			messages.push('Bluesky: 投稿完了', `コメント: ${formatComment(comment)}`);
		} catch (e) {
			await logError(kv, `${logPrefix}bluesky_post`, e);
			messages.push(`Bluesky: エラー - ${e}`);
			ok = false;
		}
	}

	if (doSheet) {
		try {
			await sheet.Update(env, day, current.weight);
			await kv.put(`${SHEET_WRITE_KEY_PREFIX}${day}`, 'written', { expirationTtl: 86400 });
			messages.push('Sheet: 書き込み完了');
		} catch (e) {
			await logError(kv, `${logPrefix}sheet_write`, e);
			messages.push(`Sheet: エラー - ${e}`);
			ok = false;
		}
	}

	return ok;
}
