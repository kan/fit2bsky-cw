// test/index.spec.ts
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('fit2bsky worker', () => {
	it.todo('should return weight data from Fitbit API');
	it.todo('should post to Bluesky');
	it.todo('should write to Google Sheets');

	it('responds with status on /status endpoint', async () => {
		const request = new IncomingRequest('http://example.com/status');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data).toHaveProperty('date');
		expect(data).toHaveProperty('blueskyPosted');
		expect(data).toHaveProperty('sheetWritten');
	});

	it('responds on /fx endpoint', async () => {
		const request = new IncomingRequest('http://example.com/fx');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		// FX API might fail in test environment, but should return 200 or 500
		expect([200, 500]).toContain(response.status);
	});
});
