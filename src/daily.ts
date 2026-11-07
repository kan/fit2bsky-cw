import health, { WeightRecord } from './health';
import bluesky from './bluesky';
import sheet from './sheet';
import { getJPYRate } from './fx';
import { WeightContext, fallbackComment, generateWithClaude } from './ai';
import { addDays, jstDate, sameDayLastYear } from './date';

const BSKY_POST_KEY_PREFIX = 'BSKY_POST_';
const SHEET_WRITE_KEY_PREFIX = 'SHEET_WRITE_';
const ERROR_LOG_KEY_PREFIX = 'ERROR_LOG_';
const AI_COMMENT_KEY_PREFIX = 'AI_COMMENT_';
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

async function updateStreak(kv: KVNamespace, day: string): Promise<number> {
	const [lastDate, current] = await Promise.all([kv.get(LAST_MEASUREMENT_KEY), getStreak(kv)]);
	if (lastDate === day) {
		return current;
	}

	const streak = lastDate === addDays(day, -1) ? current + 1 : 1;
	await Promise.all([kv.put(STREAK_KEY, streak.toString()), kv.put(LAST_MEASUREMENT_KEY, day)]);
	return streak;
}

export function formatFat(fat: number | null): string {
	return fat !== null ? `${fat.toFixed(2)}%` : '-';
}

function formatPostMessage(weight: WeightRecord, streakDays: number, jpy: number, aiComment: string): string {
	return `今日の体重: ${weight.weight.toFixed(1)}kg (BMI: ${weight.bmi.toFixed(2)}) 体脂肪率: ${formatFat(weight.fat)}
連続${streakDays}日目 | 1$=${jpy.toFixed(1)}円

AI「${aiComment}」`;
}

type Weights = Pick<WeightContext, 'current' | 'yesterday' | 'oneMonthAgo' | 'oneYearAgo'>;

/** 今日の体重を取る。 */
export async function getTodayWeight(env: Env, day: string): Promise<WeightRecord> {
	return health.getWeight(env, await health.getAccessToken(env), day);
}

/**
 * 今日の体重と、コメントの生成に使う前日、1 か月前、1 年前の体重を並列に取る。access token は 1 回だけ取る。
 * withPast が false なら過去の体重は取らない（シートへの書き込みだけのときと、コメントを作り済みのとき）。
 * 過去の体重は差にだけ使うので体脂肪率は取らず、取れなければ null にする。
 * 記録が無い以外の理由で取れなかったときは、Workers Logs にだけ残す（コメントの材料が減るだけなので）。
 */
async function getWeights(env: Env, day: string, withPast: boolean): Promise<Weights> {
	const token = await health.getAccessToken(env);
	const past = async (pastDay: string): Promise<WeightRecord | null> => {
		if (!withPast) {
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
		past(addDays(day, -1)),
		past(addDays(day, -30)),
		past(sameDayLastYear(day)),
	]);
	return { current, yesterday, oneMonthAgo, oneYearAgo };
}

/** その日のコメントを読む。まだ作っていなければ null。ダッシュボードはこれだけを表示する。 */
export async function getSavedComment(kv: KVNamespace, day: string): Promise<string | null> {
	return kv.get(`${AI_COMMENT_KEY_PREFIX}${day}`);
}

/** その日のコメントを保存する。失敗してもエラーログに残すだけで、投稿は止めない。 */
async function saveComment(kv: KVNamespace, day: string, comment: string, logPrefix: string): Promise<void> {
	try {
		await kv.put(`${AI_COMMENT_KEY_PREFIX}${day}`, comment, { expirationTtl: 86400 });
	} catch (e) {
		await logError(kv, `${logPrefix}ai_comment_save`, e).catch(() => {});
	}
}

/**
 * その日のコメントを Claude に作らせる。作れたら保存し、投稿の再試行で使い回す。
 * 生成に失敗したら文例から選び、その失敗をエラーログに残す（投稿は止めない）。文例はここでは保存しない。
 * 再試行のときに、Claude で作り直せるようにするため。
 */
async function createComment(env: Env, ctx: WeightContext, logPrefix: string): Promise<string> {
	const kv = env.FIT2BSKY_KV;
	try {
		const comment = await generateWithClaude(env, ctx);
		await saveComment(kv, ctx.day, comment, logPrefix);
		return comment;
	} catch (e) {
		await logError(kv, `${logPrefix}ai_comment`, e);
		return fallbackComment(ctx);
	}
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

	// 投稿の再試行では、作り済みのコメントを使う。そのときは過去の体重を取らない
	const savedComment = doPost ? await getSavedComment(kv, day) : null;
	let weights;
	try {
		weights = await getWeights(env, day, doPost && savedComment === null);
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
			const aiComment =
				savedComment ?? (await createComment(env, { day, ...weights, targetWeight: parseFloat(env.TARGET_WEIGHT), streakDays }, logPrefix));
			await bluesky.postMessage(env, formatPostMessage(current, streakDays, jpy, aiComment));
			await kv.put(`${BSKY_POST_KEY_PREFIX}${day}`, 'posted', { expirationTtl: 86400 });
			// 投稿したコメントをダッシュボードに出すため。文例を使ったときは、ここで初めて保存する
			if (savedComment === null) {
				await saveComment(kv, day, aiComment, logPrefix);
			}
			messages.push('Bluesky: 投稿完了', `AIコメント: ${aiComment}`);
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
