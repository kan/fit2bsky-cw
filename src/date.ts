const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** JST の日付を YYYY-MM-DD で返す。offsetDays で前後にずらす（-1 で前日）。 */
export function jstDate(offsetDays = 0, now: Date = new Date()): string {
	return new Date(now.getTime() + JST_OFFSET_MS + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD を days 日ずらした日を返す（1 で翌日、-1 で前日）。 */
export function addDays(day: string, days: number): string {
	return new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD の前の年の同じ日を返す。前の年に無い 2 月 29 日は 2 月 28 日にする。 */
export function sameDayLastYear(day: string): string {
	const [year, month, date] = day.split('-').map(Number);
	// Date.UTC は範囲外の日を翌月へ繰り越す。月が変わったら、その月に無い日だったということ
	const d = new Date(Date.UTC(year - 1, month - 1, date));
	return (d.getUTCMonth() === month - 1 ? d : new Date(Date.UTC(year - 1, month - 1, date - 1))).toISOString().slice(0, 10);
}

/** 2 つの YYYY-MM-DD の差（日数）を返す。 */
export function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}
