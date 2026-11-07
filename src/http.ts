/** 外部 API の 1 回の呼び出しを打ち切るまでの時間 */
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * タイムアウトを付けた fetch。呼び出し側の signal（init か Request のもの）があれば、そちらも生かす。
 * fetch を差し替えられるライブラリ（@atproto/api の CredentialSession など）には、これを渡す。
 */
export function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
	const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
	const callerSignal = init.signal ?? (input instanceof Request ? input.signal : undefined);
	if (callerSignal) {
		signals.push(callerSignal);
	}
	return fetch(input, { ...init, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] });
}

/**
 * タイムアウトを付けて fetch し、2xx 以外なら status と本文を載せた例外を投げる。
 * タイムアウトや接続の失敗も、label を付けた例外にする（どの呼び出しで止まったかを見分けるため）。
 * describe を渡すと、本文から作った説明（原因の見分けなど）を status の前に足す。
 */
export async function fetchOk(
	label: string,
	input: RequestInfo | URL,
	init?: RequestInit,
	describe?: (body: string) => string,
): Promise<Response> {
	let res: Response;
	try {
		res = await fetchWithTimeout(input, init);
	} catch (e) {
		throw Error(`${label}: ${e}`, { cause: e });
	}
	if (!res.ok) {
		const body = await res.text();
		const detail = describe ? `${describe(body)} ` : '';
		throw Error(`${label}: ${detail}status=${res.status} msg=${body}`);
	}
	return res;
}
