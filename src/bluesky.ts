import { Agent, CredentialSession } from '@atproto/api';
import { fetchWithTimeout } from './http';

const BSKY_SERVICE = 'https://bsky.social';

/** BSKY_PASSWORD は App Password を使う */
async function postMessage(env: Env, text: string) {
	const session = new CredentialSession(new URL(BSKY_SERVICE), fetchWithTimeout);
	await session.login({ identifier: env.BSKY_HANDLE, password: env.BSKY_PASSWORD });

	await new Agent(session).post({ text, langs: ['ja'] });
}

export default { postMessage };
