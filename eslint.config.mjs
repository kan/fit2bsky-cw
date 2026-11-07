import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
	{
		ignores: ['node_modules/**', '.wrangler/**'],
	},
	{
		files: ['src/**/*.ts', 'test/**/*.ts'],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				ecmaVersion: 'latest',
				sourceType: 'module',
				// no-floating-promises が型の情報を使う。各ファイルは最寄りの tsconfig.json で解析する
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: {
			'@typescript-eslint': tseslint,
		},
		rules: {
			...tseslint.configs.recommended.rules,
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			'@typescript-eslint/no-explicit-any': 'warn',
			// await し忘れた Promise は、Worker の実行が終わると打ち切られる
			'@typescript-eslint/no-floating-promises': 'error',
			// console.error は Workers Logs に残すために使う
			'no-console': ['warn', { allow: ['error'] }],
		},
	},
	{
		files: ['src/**/*.ts'],
		ignores: ['src/http.ts'],
		rules: {
			// fetch を差し替えられるライブラリにも fetchWithTimeout を渡す（lint では見つけられない）
			'no-restricted-globals': [
				'error',
				{ name: 'fetch', message: 'タイムアウトを付けるため、src/http.ts の fetchOk か fetchWithTimeout を使う' },
			],
			'no-restricted-properties': [
				'error',
				{ object: 'globalThis', property: 'fetch', message: 'src/http.ts の fetchOk か fetchWithTimeout を使う' },
				{ object: 'self', property: 'fetch', message: 'src/http.ts の fetchOk か fetchWithTimeout を使う' },
			],
		},
	},
];
