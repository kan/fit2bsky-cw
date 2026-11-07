const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** JST の日付を YYYY-MM-DD で返す。offsetDays で前後にずらす（-1 で前日）。 */
export function jstDate(offsetDays = 0, now: Date = new Date()): string {
	return new Date(now.getTime() + JST_OFFSET_MS + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD の翌日を返す。 */
export function nextDate(day: string): string {
	return new Date(Date.parse(day) + DAY_MS).toISOString().slice(0, 10);
}

/** 2 つの YYYY-MM-DD の差（日数）を返す。 */
export function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}
