import adapter from '@sveltejs/adapter-static';

const isProd = process.env.NODE_ENV === 'production';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter({
			fallback: 'index.html',
			strict: false
		}),
		prerender: {
			handleUnseenRoutes: 'ignore'
		},
		csp: !isProd ? undefined : {
			mode: 'hash',
			directives: {
				'default-src': ['self'],
				'object-src': ['none'],
				'script-src': ['self', 'blob:', 'https://static.cloudflareinsights.com'],
				'worker-src': ['self', 'blob:'],
				'style-src': ['self', 'unsafe-inline', 'https://fonts.googleapis.com'],
				'font-src': ['self', 'https://fonts.gstatic.com'],
				'img-src': ['self', 'data:'],
				'connect-src': [
					'self',
					'wss://api.voiddrop.ru:8443',
					'https://api.voiddrop.ru:8443',
					'wss://api.voiddrop.ru',
					'https://api.voiddrop.ru',
					'turn.voiddrop.ru:*',
					'https://fonts.googleapis.com',
					'https://fonts.gstatic.com',
					'wss://localhost:*',
					'wss://127.0.0.1:*',
					'tauri://*',
					'stun:',
					'turn:',
					'turns:',
					'https://cloudflareinsights.com'
				],
				'frame-ancestors': ['none'],
				'form-action': ['self']
			}
		}
	}
};

export default config;
