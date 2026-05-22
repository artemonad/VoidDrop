/**
 * Detect whether the app is running inside a Tauri native shell.
 * Must be a function (not a const) because SvelteKit SSR evaluates
 * module-level code on the server where window is undefined.
 * The check must happen at runtime in the browser.
 */
export function isTauri(): boolean {
    return typeof window !== 'undefined' &&
        '__TAURI_INTERNALS__' in window;
}
