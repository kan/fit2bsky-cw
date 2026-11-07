import { WeightRecord } from './health';
import { selectComment } from './comments';

export interface WeightContext {
	current: WeightRecord;
	oneMonthAgo: WeightRecord | null;
	targetWeight: number;
	streakDays: number;
}

export function generateComment(context: WeightContext): string {
	const { current, oneMonthAgo } = context;
	const diffFromLastMonth = oneMonthAgo ? current.weight - oneMonthAgo.weight : null;

	return selectComment(diffFromLastMonth);
}
