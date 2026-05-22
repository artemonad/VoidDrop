import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('isTauri detection', () => {
    const originalWindow = globalThis.window;

    afterEach(() => {
        vi.resetModules();
        if (originalWindow) {
            (globalThis as any).window = originalWindow;
        } else {
            delete (globalThis as any).window;
        }
    });

    it('returns false when window is undefined (SSR)', async () => {
        const saved = (globalThis as any).window;
        delete (globalThis as any).window;
        const { isTauri } = await import('$lib/isTauri');
        expect(isTauri()).toBe(false);
        (globalThis as any).window = saved;
    });

    it('returns false in browser without __TAURI_INTERNALS__', async () => {
        (globalThis as any).window = {};
        const { isTauri } = await import('$lib/isTauri');
        expect(isTauri()).toBe(false);
    });

    it('returns true when __TAURI_INTERNALS__ is present', async () => {
        (globalThis as any).window = { __TAURI_INTERNALS__: {} };
        const { isTauri } = await import('$lib/isTauri');
        expect(isTauri()).toBe(true);
    });
});
