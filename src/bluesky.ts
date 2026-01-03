import { BskyAgent } from '@atproto/api';
import { Bindings } from './bindings';

const BSKY_SERVICE = 'https://bsky.social';

async function postMessage(env: Bindings, text: string) {
	const agent = new BskyAgent({ service: BSKY_SERVICE });
	await agent.login({ identifier: env.BSKY_HANDLE, password: env.BSKY_PASSWORD });

	await agent.post({ text });
}

export default { postMessage };
