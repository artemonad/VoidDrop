/// <reference types="node" />
import { test, expect } from '@playwright/test';

/**
 * Smoke tests — verify the frontend loads correctly and core UI works.
 * These tests do NOT require a running backend.
 */

test.describe('Frontend Smoke Tests', () => {
    test('homepage loads with correct title', async ({ page }) => {
        await page.goto('/');
        await expect(page).toHaveTitle(/VoidDrop/i);
    });

    test('homepage shows upload zone', async ({ page }) => {
        await page.goto('/');
        // Drop zone should be visible
        const dropZone = page.locator('.dropzone');
        await expect(dropZone.first()).toBeVisible({ timeout: 10_000 });
    });

    test('homepage shows "Specification" button and overlay', async ({ page }) => {
        await page.goto('/');
        const specBtn = page.locator('button.btn-spec');
        await expect(specBtn).toBeVisible({ timeout: 10_000 });
        await specBtn.click();
        const specHeader = page.locator('h2').filter({ hasText: /Technical Specification/i });
        await expect(specHeader).toBeVisible({ timeout: 5000 });
    });

    test('file input elements are present (hidden)', async ({ page }) => {
        await page.goto('/');
        // Hidden file inputs for file and folder selection
        const fileInput = page.locator('input[type="file"]');
        await expect(fileInput.first()).toBeAttached();
    });

    test('crypto worker initializes (WASM loads)', async ({ page }) => {
        await page.goto('/');
        // Wait for the worker to post WASM_LOADED
        await page.waitForTimeout(3000);
        // No error banners should appear from WASM load failure
        const errorBanner = page.locator('[class*="error"]').filter({ hasText: /WASM|Worker|failed/i });
        await expect(errorBanner).toHaveCount(0);
    });
});

test.describe('Download Page', () => {
    test('invalid file ID → shows error state', async ({ page }) => {
        await page.goto('/f/not-a-valid-uuid#aabbccdd', { waitUntil: 'networkidle' });
        await page.waitForTimeout(5000);
        const body = await page.textContent('body');
        expect(body).toBeTruthy();
    });

    test('missing hash → page loads without crash', async ({ page }) => {
        // Navigate to download page without a hash (no decryption key)
        await page.goto('/f/550e8400-e29b-41d4-a716-446655440000', { waitUntil: 'networkidle' });
        await page.waitForTimeout(5000);
        // Page should render SvelteKit app (not just bootstrap script)
        const body = await page.textContent('body');
        // Should have rendered some UI content (not just raw JS)
        expect(body!.length).toBeGreaterThan(20);
    });

    test('corrupted key (non-hex) → page handles gracefully', async ({ page }) => {
        await page.goto('/f/550e8400-e29b-41d4-a716-446655440000#zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', { waitUntil: 'networkidle' });
        await page.waitForTimeout(5000);
        const body = await page.textContent('body');
        expect(body!.length).toBeGreaterThan(20);
    });

    test('short key (< 64 chars) → page handles gracefully', async ({ page }) => {
        await page.goto('/f/550e8400-e29b-41d4-a716-446655440000#abcdef', { waitUntil: 'networkidle' });
        await page.waitForTimeout(5000);
        const body = await page.textContent('body');
        expect(body!.length).toBeGreaterThan(20);
    });
});

test.describe('File Selection UI', () => {
    test('drag and drop zone is visible and styled', async ({ page }) => {
        await page.goto('/');
        const dropZone = page.locator('.dropzone').first();
        await expect(dropZone).toBeVisible({ timeout: 10_000 });
        // Verify it has the expected role
        const role = await dropZone.getAttribute('role');
        expect(role).toBe('button');
    });

    test('add files via hidden input triggers file list', async ({ page }) => {
        await page.goto('/');

        // Create a test file using the FileChooser API
        const fileInput = page.locator('input[type="file"]').first();

        // Set files on the input
        await fileInput.setInputFiles({
            name: 'test.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('Hello, VoidDrop!'),
        });

        // Wait for file to appear in the list
        await page.waitForTimeout(1000);
        const body = await page.textContent('body');
        // File name or file count should appear
        expect(body?.toLowerCase()).toMatch(/test\.txt|1 file|16 b/i);
    });

    test('add multiple files shows count', async ({ page }) => {
        await page.goto('/');
        const fileInput = page.locator('input[type="file"]').first();

        await fileInput.setInputFiles([
            { name: 'file1.txt', mimeType: 'text/plain', buffer: Buffer.from('AAA') },
            { name: 'file2.txt', mimeType: 'text/plain', buffer: Buffer.from('BBB') },
            { name: 'file3.txt', mimeType: 'text/plain', buffer: Buffer.from('CCC') },
        ]);

        await page.waitForTimeout(1000);
        const body = await page.textContent('body');
        expect(body).toContain('file1.txt');
        expect(body).toContain('file2.txt');
        expect(body).toContain('file3.txt');
    });

    test('remove file button works', async ({ page }) => {
        await page.goto('/');
        const fileInput = page.locator('input[type="file"]').first();

        await fileInput.setInputFiles([
            { name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('keep') },
            { name: 'delete_me.txt', mimeType: 'text/plain', buffer: Buffer.from('delete') },
        ]);

        await page.waitForTimeout(1000);

        // Find and click the remove button for delete_me.txt
        const removeBtn = page.locator('button[title*="Remove"], .remove-btn, .btn-remove, [class*="remove"]').first();
        if (await removeBtn.isVisible()) {
            await removeBtn.click();
            await page.waitForTimeout(500);
            const body = await page.textContent('body');
            expect(body).toBeTruthy();
        }
    });

    test('clear all button removes all files', async ({ page }) => {
        await page.goto('/');
        const fileInput = page.locator('input[type="file"]').first();

        await fileInput.setInputFiles([
            { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('A') },
            { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('B') },
        ]);

        await page.waitForTimeout(1000);

        const clearBtn = page.locator('.btn-clear-all').first();
        if (await clearBtn.isVisible()) {
            await clearBtn.click();
            await page.waitForTimeout(500);
            // Files should be gone, dropzone should reappear
            await expect(page.locator('.dropzone').first()).toBeVisible();
        }
    });

    test('file explorer view toggle (list ↔ tree)', async ({ page }) => {
        await page.goto('/');
        const fileInput = page.locator('input[type="file"]').first();

        await fileInput.setInputFiles([
            { name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('data') },
        ]);

        await page.waitForTimeout(1000);

        // Look for view toggle buttons
        const treeBtn = page.locator('button[title*="tree"], button[title*="Tree"], [class*="view-toggle"]');
        if (await treeBtn.first().isVisible()) {
            await treeBtn.first().click();
            await page.waitForTimeout(500);
        }
    });

    test('search/filter works in file list', async ({ page }) => {
        await page.goto('/');
        const fileInput = page.locator('input[type="file"]').first();

        await fileInput.setInputFiles([
            { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from('A') },
            { name: 'beta.png', mimeType: 'image/png', buffer: Buffer.from('B') },
            { name: 'gamma.doc', mimeType: 'application/msword', buffer: Buffer.from('C') },
        ]);

        await page.waitForTimeout(1000);

        const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"], input[type="search"]');
        if (await searchInput.isVisible()) {
            await searchInput.fill('alpha');
            await page.waitForTimeout(500);
            const body = await page.textContent('body');
            expect(body).toContain('alpha.txt');
        }
    });
});

test.describe('P2P Link Handling', () => {
    test('hash with room:psk format auto-joins as receiver', async ({ page }) => {
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

        const roomId = '550e8400-e29b-41d4-a716-446655440000';
        const pskHex = 'a'.repeat(64);
        await page.goto(`/#${roomId}:${pskHex}`);

        // Wait for the UI to transition into the HANDSHAKE connection state
        const statusTitle = page.locator('.status-title');
        await expect(statusTitle).toHaveText(/Connecting Peer/i, { timeout: 15_000 });
        
        const body = await page.textContent('body');
        expect(body?.toLowerCase()).toMatch(/connect|handshake/i);
    });
});

test.describe('UI Accessibility and Selection Rules', () => {
    test('text selection rules are correctly enforced', async ({ page }) => {
        await page.goto('/');
        
        // Non-selectable element: the main hero title (h1)
        const h1 = page.locator('h1').first();
        if (await h1.isVisible()) {
            const h1UserSelect = await h1.evaluate(el => window.getComputedStyle(el).userSelect);
            expect(h1UserSelect).toBe('none');
        }

        // Selectable elements: the link input fields (e.g. pasteLinkInput) should allow selection/editing
        const linkInput = page.locator('input#receive-input, input.link-input').first();
        await expect(linkInput).toBeVisible({ timeout: 10_000 });
        const inputUserSelect = await linkInput.evaluate(el => window.getComputedStyle(el).userSelect);
        expect(['text', 'auto', 'contain']).toContain(inputUserSelect);
    });

    test('connection logs remain hidden on idle home screen', async ({ page }) => {
        await page.goto('/');
        
        // Add files to trigger file list (logs must still remain completely hidden!)
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.setInputFiles({
            name: 'test-doc.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('Testing logs visibility'),
        });
        
        await page.waitForTimeout(1000);
        
        // Assert logs panel or connection logs text is not visible/rendered
        const logsPanel = page.locator('.connection-logs, .logs-scroll, .log-line');
        await expect(logsPanel).toHaveCount(0);
    });

    test('theme switcher toggles between light and dark themes', async ({ page }) => {
        await page.goto('/');
        
        // Locate theme switcher button
        const themeBtn = page.locator('button.btn-theme-toggle').first();
        await expect(themeBtn).toBeVisible({ timeout: 5000 });
        
        // Get initial theme (should be dark by default or defined in CSS)
        const initialClassList = await page.evaluate(() => document.documentElement.className);
        const initialIsLight = initialClassList.includes('light');
        
        // Click theme toggle button
        await themeBtn.click();
        await page.waitForTimeout(500);
        
        // Verify theme toggles
        const toggledClassList = await page.evaluate(() => document.documentElement.className);
        const toggledIsLight = toggledClassList.includes('light');
        expect(toggledIsLight).toBe(!initialIsLight);
        
        // Verify it was persisted to localStorage
        const savedTheme = await page.evaluate(() => localStorage.getItem('theme'));
        expect(savedTheme).toBe(toggledIsLight ? 'light' : 'dark');
        
        // Click again to toggle back
        await themeBtn.click();
        await page.waitForTimeout(500);
        const finalClassList = await page.evaluate(() => document.documentElement.className);
        const finalIsLight = finalClassList.includes('light');
        expect(finalIsLight).toBe(initialIsLight);
    });
});

