import health, { WeightRecord } from './health';
import bluesky from './bluesky';
import sheet from './sheet';
import { getJPYRate } from './fx';
import { generateComment } from './ai';
import { Bindings } from './bindings';
import { addDays, jstDate } from './date';

const BSKY_POST_KEY_PREFIX = 'BSKY_POST_';
const SHEET_WRITE_KEY_PREFIX = 'SHEET_WRITE_';
const ERROR_LOG_KEY_PREFIX = 'ERROR_LOG_';
const STREAK_KEY = 'MEASUREMENT_STREAK';
const LAST_MEASUREMENT_KEY = 'LAST_MEASUREMENT_DATE';

export async function getErrorLogs(kv: KVNamespace, day: string): Promise<unknown[] | null> {
	return kv.get<unknown[]>(`${ERROR_LOG_KEY_PREFIX}${day}`, 'json');
}

export async function logError(kv: KVNamespace, context: string, error: unknown): Promise<void> {
	const key = `${ERROR_LOG_KEY_PREFIX}${jstDate()}`;
	const logs = (await kv.get<unknown[]>(key, 'json')) ?? [];
	logs.push({
		timestamp: new Date().toISOString(),
		context,
		error: error instanceof Error ? error.message : String(error),
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

/**
 * 今日の体重と、コメントの生成に使う 1 か月前の体重を並列に取る。access token は 1 回だけ取る。
 * withContext が false なら 1 か月前は取らない（シートへの書き込みだけのとき）。
 */
export async function getWeightWithContext(
	env: Bindings,
	day: string,
	withContext = true,
): Promise<{ current: WeightRecord; oneMonthAgo: WeightRecord | null }> {
	const token = await health.getAccessToken(env);
	const [current, oneMonthAgo] = await Promise.all([
		health.getWeight(env, token, day),
		withContext ? health.getWeight(env, token, addDays(day, -30)).catch(() => null) : null,
	]);
	return { current, oneMonthAgo };
}

/** 投稿とダッシュボードに出す AI コメントを作る。 */
export function buildComment(env: Bindings, current: WeightRecord, oneMonthAgo: WeightRecord | null, streakDays: number): string {
	return generateComment({ current, oneMonthAgo, targetWeight: parseFloat(env.TARGET_WEIGHT), streakDays });
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
export async function runDaily(env: Bindings, { post }: { post: boolean }, logPrefix = ''): Promise<DailyResult> {
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

async function runDailyTasks(env: Bindings, post: boolean, logPrefix: string, messages: string[]): Promise<boolean> {
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

	let weights;
	try {
		weights = await getWeightWithContext(env, day, doPost);
	} catch (e) {
		await logError(kv, `${logPrefix}health_get_weight`, e);
		messages.push(`体重の取得: エラー - ${e}`);
		return false;
	}
	let ok = true;
	const { current, oneMonthAgo } = weights;
	const streakDays = await updateStreak(kv, day);

	if (doPost) {
		try {
			const jpy = await getJPYRate();
			const aiComment = buildComment(env, current, oneMonthAgo, streakDays);
			await bluesky.postMessage(env, formatPostMessage(current, streakDays, jpy, aiComment));
			await kv.put(`${BSKY_POST_KEY_PREFIX}${day}`, 'posted', { expirationTtl: 86400 });
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
