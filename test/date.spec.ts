import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, jstDate, sameDayLastYear } from '../src/date';

describe('jstDate', () => {
	it('UTC がまだ前日でも、JST 0:00〜9:00 は JST の日付を返す', () => {
		// JST 2026-11-08 01:00
		expect(jstDate(0, new Date('2026-11-07T16:00:00Z'))).toBe('2026-11-08');
	});

	it('JST 9:00 以降は UTC と同じ日付になる', () => {
		expect(jstDate(0, new Date('2026-11-07T00:00:00Z'))).toBe('2026-11-07');
	});

	it('offsetDays で前後にずらす', () => {
		const now = new Date('2026-11-07T16:00:00Z');
		expect(jstDate(-1, now)).toBe('2026-11-07');
		expect(jstDate(1, now)).toBe('2026-11-09');
	});
});

describe('addDays / daysBetween', () => {
	it('月末や年末をまたいで日付をずらす', () => {
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2026-11-07', -30)).toBe('2026-10-08');
	});

	it('前の年の同じ日を返し、前の年に無い 2 月 29 日は 2 月 28 日にする', () => {
		expect(sameDayLastYear('2026-11-07')).toBe('2025-11-07');
		expect(sameDayLastYear('2029-03-01')).toBe('2028-03-01');
		expect(sameDayLastYear('2028-02-29')).toBe('2027-02-28');
		expect(sameDayLastYear('2029-02-28')).toBe('2028-02-28');
	});

	it('2 つの日付の差を日数で返す', () => {
		expect(daysBetween('2016-05-02', '2016-05-03')).toBe(1);
		expect(daysBetween('2016-05-02', '2026-11-07')).toBe(3841);
	});
});
