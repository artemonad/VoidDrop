/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock isTauri
vi.mock('$lib/isTauri', () => ({ isTauri: () => false }));

// Mock Tauri plugins (they won't be available in test)
vi.mock('@tauri-apps/plugin-dialog', () => ({
    save: vi.fn(),
    open: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
    writeFile: vi.fn(),
    mkdir: vi.fn(),
}));

describe('tauriFs', () => {
    describe('saveFile (browser fallback)', () => {
        let createObjectURLSpy: ReturnType<typeof vi.fn>;
        let revokeObjectURLSpy: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            // Setup DOM mocks for browser fallback
            createObjectURLSpy = vi.fn(() => 'blob:mock-url');
            revokeObjectURLSpy = vi.fn();
            globalThis.URL.createObjectURL = createObjectURLSpy as typeof URL.createObjectURL;
            globalThis.URL.revokeObjectURL = revokeObjectURLSpy as typeof URL.revokeObjectURL;

            // Mock document.createElement to return a link element
            const mockLink = {
                href: '',
                download: '',
                style: { display: '' },
                click: vi.fn(),
            };
            vi.spyOn(document, 'createElement').mockReturnValue(mockLink as any);
            vi.spyOn(document.body, 'appendChild').mockReturnValue(null as any);
            vi.spyOn(document.body, 'removeChild').mockReturnValue(null as any);
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('creates a download link with correct filename (Uint8Array)', async () => {
            const { saveFile } = await import('$lib/tauriFs');
            const data = new Uint8Array([1, 2, 3, 4]);

            // Don't await since it has a setTimeout
            const promise = saveFile('test.bin', data);

            const link = (document.createElement as any).mock.results[0].value;
            expect(link.download).toBe('test.bin');
            expect(link.click).toHaveBeenCalled();
            expect(createObjectURLSpy).toHaveBeenCalledOnce();

            // Advance timer to resolve
            vi.useFakeTimers();
            vi.advanceTimersByTime(200);
            vi.useRealTimers();
        });

        it('creates a download link with Blob data', async () => {
            const { saveFile } = await import('$lib/tauriFs');
            const data = new Blob(['hello world'], { type: 'text/plain' });

            saveFile('test.txt', data);

            const link = (document.createElement as any).mock.results[0].value;
            expect(link.download).toBe('test.txt');
            expect(link.click).toHaveBeenCalled();
        });
    });

    describe('saveBundle (browser fallback)', () => {
        beforeEach(() => {
            globalThis.URL.createObjectURL = vi.fn(() => 'blob:url') as unknown as typeof URL.createObjectURL;
            globalThis.URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
            const mockLink = {
                href: '', download: '', style: { display: '' }, click: vi.fn(),
            };
            vi.spyOn(document, 'createElement').mockReturnValue(mockLink as any);
            vi.spyOn(document.body, 'appendChild').mockReturnValue(null as any);
            vi.spyOn(document.body, 'removeChild').mockReturnValue(null as any);
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('downloads each file individually', async () => {
            vi.useFakeTimers();
            const { saveBundle } = await import('$lib/tauriFs');
            const files = [
                { name: 'a.txt', data: new Uint8Array([1]) },
                { name: 'b.txt', data: new Uint8Array([2]) },
            ];

            const promise = saveBundle(files);
            // Advance timers to resolve all setTimeout(100) in saveFileBrowser
            await vi.advanceTimersByTimeAsync(500);
            await promise;

            // Should have created 2 links (one per file)
            expect(document.createElement).toHaveBeenCalledWith('a');
            vi.useRealTimers();
        });
    });

    describe('sanitizeRelativePath', () => {
        it('handles standard relative paths', async () => {
            const { sanitizeRelativePath } = await import('$lib/tauriFs');
            expect(sanitizeRelativePath('foo/bar/baz.txt')).toBe('foo/bar/baz.txt');
        });

        it('completely blocks and strips path traversal (..)', async () => {
            const { sanitizeRelativePath } = await import('$lib/tauriFs');
            expect(sanitizeRelativePath('../../etc/passwd')).toBe('etc/passwd');
            expect(sanitizeRelativePath('foo/../bar')).toBe('foo/bar');
            expect(sanitizeRelativePath('a/b/../../c')).toBe('a/b/c');
            expect(sanitizeRelativePath('..')).toBe('');
        });

        it('normalizes Windows path separators and eliminates traversal', async () => {
            const { sanitizeRelativePath } = await import('$lib/tauriFs');
            expect(sanitizeRelativePath('foo\\bar\\baz.txt')).toBe('foo/bar/baz.txt');
            expect(sanitizeRelativePath('..\\..\\etc\\passwd')).toBe('etc/passwd');
            expect(sanitizeRelativePath('foo\\..\\bar')).toBe('foo/bar');
        });

        it('strips colons to neutralize Windows drive letters and URI schemes', async () => {
            const { sanitizeRelativePath } = await import('$lib/tauriFs');
            expect(sanitizeRelativePath('C:\\Windows\\System32')).toBe('C/Windows/System32');
            expect(sanitizeRelativePath('http://example.com/file')).toBe('http/example.com/file');
        });

        it('skips empty, single dot (.), and leading/trailing/multiple slashes', async () => {
            const { sanitizeRelativePath } = await import('$lib/tauriFs');
            expect(sanitizeRelativePath('/absolute/path/')).toBe('absolute/path');
            expect(sanitizeRelativePath('./relative/path/.')).toBe('relative/path');
            expect(sanitizeRelativePath('///foo////bar///')).toBe('foo/bar');
        });

        it('handles empty and undefined inputs', async () => {
            const { sanitizeRelativePath } = await import('$lib/tauriFs');
            expect(sanitizeRelativePath('')).toBe('');
            expect(sanitizeRelativePath(null as any)).toBe('');
            expect(sanitizeRelativePath(undefined as any)).toBe('');
        });
    });
});
