import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		alias: {
			$lib: 'src/lib',
		},
		csrf: {
			// Disabled — custom CSRF origin check in hooks.server.ts handles this,
			// and the built-in check rejects 127.0.0.1 vs localhost mismatches.
			trustedOrigins: ['*'],
		},
	},
};

export default config;
