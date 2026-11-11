import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			// AI の binding は常に remote なので、そのままだと起動に Cloudflare の認証が要り、CI で止まる。
			// テストでは env.AI を偽物に替える（test/helpers.ts の mockDeepSeek）
			remoteBindings: false,
		}),
	],
	test: {
		setupFiles: ['./test/setup.ts'],
	},
});
