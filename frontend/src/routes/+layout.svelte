<script lang="ts">
	import "../global/global.css";
	import { onMount } from "svelte";
	import { isTauri } from "$lib/isTauri";

	let { children } = $props();

	onMount(() => {
		if ('serviceWorker' in navigator && !isTauri()) {
			navigator.serviceWorker.register('/service-worker.js')
				.then((registration) => {
					console.log('[PWA] Service Worker registered with scope:', registration.scope);
				})
				.catch((error) => {
					console.error('[PWA] Service Worker registration failed:', error);
				});
		}
	});
</script>

<svelte:boundary>
	{@render children()}
	{#snippet failed(error, reset)}
		<div class="boundary-error-container">
			<div class="boundary-error-card">
				<h1>Something went wrong</h1>
				<p class="error-msg">{error instanceof Error ? error.message : String(error)}</p>
				<button onclick={() => window.location.reload()}>Reload Application</button>
			</div>
		</div>

		<style>
			.boundary-error-container {
				display: flex;
				align-items: center;
				justify-content: center;
				min-height: 100vh;
				width: 100%;
				background: var(--bg-color, #e0e0e0);
				font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
				padding: 2rem;
				box-sizing: border-box;
			}
			.boundary-error-card {
				background: var(--bg-color, #e0e0e0);
				box-shadow: 9px 9px 16px rgba(163, 177, 198, 0.6), -9px -9px 16px rgba(255, 255, 255, 0.8);
				border-radius: 20px;
				padding: 3rem;
				text-align: center;
				max-width: 500px;
				width: 100%;
			}
			h1 {
				color: #e11d48;
				margin-bottom: 1rem;
				font-size: 1.8rem;
			}
			.error-msg {
				color: var(--text-secondary, #666);
				background: rgba(0,0,0,0.05);
				padding: 1rem;
				border-radius: 10px;
				font-family: monospace;
				word-break: break-all;
				margin-bottom: 2rem;
			}
			button {
				background: var(--bg-color, #e0e0e0);
				box-shadow: 4px 4px 8px rgba(163, 177, 198, 0.6), -4px -4px 8px rgba(255, 255, 255, 0.8);
				border: none;
				padding: 0.8rem 1.5rem;
				border-radius: 10px;
				font-weight: bold;
				color: var(--purple, #a78bfa);
				cursor: pointer;
				transition: all 0.2s ease;
			}
			button:hover {
				box-shadow: 2px 2px 4px rgba(163, 177, 198, 0.6), -2px -2px 4px rgba(255, 255, 255, 0.8);
			}
			button:active {
				box-shadow: inset 2px 2px 4px rgba(163, 177, 198, 0.6), inset -2px -2px 4px rgba(255, 255, 255, 0.8);
			}
		</style>
	{/snippet}
</svelte:boundary>
