import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

const isTauriBuild = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		exclude: ['e2e/**', 'node_modules/**'],
	},
	server: {
		port: isTauriBuild ? 1420 : 5173,
		strictPort: isTauriBuild,
		host: isTauriBuild ? '127.0.0.1' : undefined,
		allowedHosts: ['voiddrop.ru', '.voiddrop.ru', 'localhost', '127.0.0.1'],
		fs: {
			allow: ['..']
		},
		headers: isTauriBuild ? {} : {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'credentialless'
		}
	},
	preview: {
		allowedHosts: ['voiddrop.ru']
	}
});