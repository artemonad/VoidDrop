<script lang="ts">
    import { onMount } from 'svelte';
    import type { TransferState } from '$lib/transfer/transferState.svelte';
    import {
        initWebRTC,
        setupWebRTC,
        joinP2PSession,
    } from '$lib/transfer';
    import FileExplorer from '$lib/components/FileExplorer.svelte';
    import ConnectionLog from '$lib/components/ConnectionLog.svelte';
    import ManifestPreview from '$lib/components/ManifestPreview.svelte';
    import QrCode from '$lib/components/QrCode.svelte';
    import TransferDashboard from '$lib/components/TransferDashboard.svelte';
    import Logo from '$lib/components/Logo.svelte';
    import TitleBar from './TitleBar.svelte';
    import SidebarNavigation from './SidebarNavigation.svelte';

import { handlePasteLink as pasteLinkHelper } from '$lib/transfer/linkHandler';

    let {
        s,
        apiBase,
        fileTree,
        explorerFiles,
        handleFileSelect,
        handleDrop,
        removeFile,
        removeMultipleFiles,
        clearAllFiles,
        isLight,
        toggleTheme,
    }: {
        s: TransferState;
        apiBase: string;
        fileTree: any;
        explorerFiles: any[];
        handleFileSelect: (e: Event) => void;
        handleDrop: (e: DragEvent) => Promise<void>;
        removeFile: (index: number) => void;
        removeMultipleFiles: (indices: number[]) => void;
        clearAllFiles: (e: Event) => void;
        isLight: boolean;
        toggleTheme: () => void;
    } = $props();

    function handlePasteLink() {
        pasteLinkHelper(s, apiBase);
    }

    // Format bytes
    function fmt(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`;
        return `${(bytes / 1073741824).toFixed(2)} GB`;
    }

    import { isTauri } from '$lib/isTauri';
    import { readDirRecursive, getTauriFilesFromPaths } from '$lib/tauriFs';

    async function selectFilesTauri() {
        if (!isTauri()) return;
        s.currentPage = 0;
        try {
            const { open } = await import('@tauri-apps/plugin-dialog');
            const selected = await open({
                multiple: true,
                directory: false,
                title: 'Select Files'
            });
            if (!selected) return;

            s.isScanningFiles = true;
            const paths = Array.isArray(selected) ? selected : [selected];
            const filesWithMeta = await getTauriFilesFromPaths(paths);
            
            let addedSize = 0;
            for (const item of filesWithMeta) {
                addedSize += item.file.size;
            }
            s.selectedFiles = [...s.selectedFiles, ...filesWithMeta];
            s.totalSelectionSize += addedSize;
            s.isScanningFiles = false;

            if (s.selectedFiles.length > 0) {
                s.peerRole = 'sender';
                s.log(
                    `Selected ${s.selectedFiles.length} file(s) via native dialog. Total: ${(s.totalSelectionSize / 1024 / 1024).toFixed(2)} MB`
                );
            }
        } catch (err) {
            s.isScanningFiles = false;
            console.error('Tauri open files error:', err);
            s.showToast('Failed to select files');
        }
    }

    async function selectFolderTauri() {
        if (!isTauri()) return;
        s.currentPage = 0;
        try {
            const { open } = await import('@tauri-apps/plugin-dialog');
            const selected = await open({
                multiple: false,
                directory: true,
                title: 'Select Folder'
            });
            if (!selected || typeof selected !== 'string') return;

            s.isScanningFiles = true;
            s.log(`Scanning native directory recursively: ${selected}`);
            
            const filesWithMeta = await readDirRecursive(selected);
            if (filesWithMeta.length === 0) {
                s.isScanningFiles = false;
                s.showToast('Selected folder is empty');
                return;
            }

            let addedSize = 0;
            for (const item of filesWithMeta) {
                addedSize += item.file.size;
            }
            s.selectedFiles = [...s.selectedFiles, ...filesWithMeta];
            s.totalSelectionSize += addedSize;
            s.isScanningFiles = false;

            if (s.selectedFiles.length > 0) {
                s.peerRole = 'sender';
                s.log(
                    `Selected folder via native dialog (${filesWithMeta.length} files). Total: ${(s.totalSelectionSize / 1024 / 1024).toFixed(2)} MB`
                );
            }
        } catch (err) {
            s.isScanningFiles = false;
            console.error('Tauri open folder error:', err);
            s.showToast('Failed to select folder');
        }
    }

    let totalSize = $derived(s.peerRole === 'receiver' ? s.receiverFileTotalSize : s.totalSelectionSize);
    let actualTransferred = $derived(
        s.peerRole === 'sender'
            ? (s.useReceiverProgress ? s.receiverReportedProgress : Math.min(Math.max(0, s.bytesTransferred - s.senderBuffered), totalSize))
            : Math.min(s.bytesTransferred, totalSize)
    );
    let progress = $derived(
        (s.flowState === 'STREAMING' || s.flowState === 'MANIFEST') && totalSize > 0
            ? Math.min(100, (actualTransferred / totalSize) * 100)
            : 0
    );

    onMount(() => {
        document.body.classList.add('desktop-mode');
        return () => {
            document.body.classList.remove('desktop-mode');
        };
    });
</script>


<div class="desktop-app">
    <TitleBar {s} {isLight} {toggleTheme} {handlePasteLink} />

    <!-- ─── Main Content with Sidebar ─── -->
    <div class="app-content-wrapper">
        <SidebarNavigation {s} onSelectFiles={selectFilesTauri} onSelectFolder={selectFolderTauri} />
        <main class="app-main">
        {#if s.selectedFiles.length === 0 && s.flowState === 'IDLE'}
            <!-- Empty state: drop zone -->
            <div class="empty-state" role="button" tabindex="0">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="empty-icon">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <h3>Drop files here</h3>
                <p class="muted">or use the buttons below</p>
                <div class="empty-buttons">
                    <button class="btn-primary" onclick={selectFilesTauri}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
                        Select Files
                    </button>
                    <button class="btn-secondary" onclick={selectFolderTauri}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                        Select Folder
                    </button>
                </div>

                <div class="divider-text" style="margin-top: 2rem; margin-bottom: 1.5rem; width: 100%; max-width: 420px;">
                    <span>or receive files</span>
                </div>

                <div class="receive-section" style="width: 100%; max-width: 420px;" onclick={(e) => e.stopPropagation()} role="presentation">
                    <span class="receive-label" style="display: block; margin-bottom: 0.6rem; color: #a1a1aa; font-size: 0.85rem; text-align: center;">Paste a VoidDrop link or code below:</span>
                    <div class="receive-row" style="display: flex; gap: 0.5rem; width: 100%;">
                        <input
                            type="text"
                            bind:value={s.pasteLinkInput}
                            placeholder="Paste link or code here..."
                            class="link-input"
                            onkeydown={(e) => e.key === 'Enter' && handlePasteLink()}
                        />
                        <button
                            class="btn-primary"
                            onclick={handlePasteLink}
                            disabled={!s.pasteLinkInput}
                            style="padding: 0.6rem 1.5rem; font-size: 0.85rem;"
                        >
                            Join
                        </button>
                    </div>
                </div>
            </div>
        {:else}
            <!-- Files selected / transfer in progress -->
            <div class="content-layout">
                <!-- File panel -->
                {#if s.selectedFiles.length > 0}
                    <div class="file-panel">
                        <div class="panel-header">
                            <span class="panel-title">{s.selectedFiles.length} file{s.selectedFiles.length !== 1 ? 's' : ''} · {fmt(s.totalSelectionSize)}</span>
                            {#if s.flowState === 'IDLE'}
                                <div class="panel-actions">
                                    <button class="btn-icon" title="Add files" onclick={selectFilesTauri}>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                    </button>
                                    <button class="btn-icon" title="Add folder" onclick={selectFolderTauri}>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                                    </button>
                                </div>
                            {/if}
                        </div>

                        {#if s.flowState === 'IDLE'}
                            <FileExplorer
                                files={explorerFiles}
                                {fileTree}
                                mode="sender"
                                bind:viewMode={s.viewMode}
                                bind:searchQuery={s.searchQuery}
                                bind:sortMode={s.sortMode}
                                bind:currentPage={s.currentPage}
                                bind:treeOpenState={s.treeOpenState}
                                onRemoveFile={removeFile}
                                onRemoveMultiple={removeMultipleFiles}
                                onClearAll={clearAllFiles}
                            />
                        {/if}
                    </div>
                {/if}

                <!-- Transfer panel -->
                <div class="transfer-panel">
                    {#if s.flowState === 'IDLE' && !s.p2pLink}
                        <!-- Action buttons -->
                        <div class="transfer-actions">
                            <button
                                class="btn-primary wide"
                                onclick={() => initWebRTC(s, (rid) => setupWebRTC(s, rid, apiBase))}
                                disabled={!s.isWorkerReady}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                                </svg>
                                {s.isWorkerReady ? 'Create P2P Session' : 'Loading Engine...'}
                            </button>
                        </div>
                    {:else if s.p2pLink && s.flowState !== 'STREAMING' && s.flowState !== 'DONE'}
                        <!-- Waiting for receiver -->
                        <div class="status-card waiting">
                            <span class="status-label">Waiting for receiver...</span>
                            <input type="text" readonly value={s.p2pLink} class="link-display" onclick={(e) => e.currentTarget.select()} />
                            <QrCode text={s.p2pLink} />
                            <button class="btn-primary wide" onclick={async () => {
                                try {
                                    await navigator.clipboard.writeText(s.p2pLink);
                                    s.showToast('Link copied!');
                                } catch (err) {
                                    s.log(`Clipboard error: ${err}`);
                                    s.showToast('Failed to copy link. Please copy manually.');
                                }
                            }}>
                                Copy Link
                            </button>
                            <button class="btn-secondary wide" onclick={s.resetToHome} style="margin-top: 0.5rem;">
                                Cancel Session
                            </button>
                        </div>
                    {:else if s.flowState === 'DONE'}
                        <!-- P2P done -->
                        <div class="status-card done">
                            <span class="status-label done-label">Transfer Complete!</span>
                            <button class="btn-secondary wide" onclick={s.resetToHome}>New Transfer</button>
                        </div>
                    {/if}

                    <!-- Progress bar -->
                    {#if s.flowState === 'STREAMING' || s.flowState === 'HANDSHAKE' || s.flowState === 'MANIFEST'}
                        <div class="progress-section">
                            <div class="progress-bar">
                                <div class="progress-fill" style="width: {progress}%"></div>
                            </div>
                            <div class="progress-info">
                                <span>{fmt(actualTransferred)} / {fmt(totalSize)}</span>
                                <span>{progress.toFixed(1)}%</span>
                            </div>

                            {#if s.flowState === 'STREAMING'}
                                <div class="current-transfer-info" style="margin-top: 0.75rem; font-size: 0.78rem; color: var(--color-muted); text-align: center; width: 100%; height: 75px; display: flex; flex-direction: column; justify-content: center; align-items: center; box-sizing: border-box; overflow-y: auto;">
                                    {#if s.peerRole === 'receiver' && s.receiverManifest}
                                        {@const currentFile = s.receiverManifest.files[s.receiverFileIndex]}
                                        {#if currentFile}
                                            <p style="margin: 0; line-height: 1.4;">
                                                Saving: <span style="color: #ffffff; font-family: monospace; word-break: break-all;">{currentFile.path}</span>
                                                <span style="color: var(--color-accent); font-weight: bold;"> &rarr; </span>
                                                <span style="color: var(--color-muted);">
                                                    {s.receiverSaveLocationName || 'none'}
                                                </span>
                                            </p>
                                            <p style="margin: 0.2rem 0 0; font-size: 0.72rem; opacity: 0.8;">File {s.receiverFileIndex + 1} of {s.receiverManifest.files.length}</p>
                                        {/if}
                                    {:else if s.peerRole === 'sender'}
                                        <p style="margin: 0;">Uploading payload in real-time...</p>
                                    {/if}
                                </div>
                            {/if}

                            <button class="btn-secondary wide" onclick={s.resetToHome} style="margin-top: 0.75rem;">
                                Cancel Transfer
                            </button>
                        </div>
                        
                        <TransferDashboard {s} />
                    {/if}

                    <ManifestPreview state={s} />
                </div>
            </div>
        {/if}

        <!-- Connection log -->
        <ConnectionLog state={s} />
    </main>
    </div>

    <!-- Hidden inputs -->
    <input type="file" multiple bind:this={s.fileInput} onchange={handleFileSelect} style="display:none" />
    <input type="file" webkitdirectory multiple bind:this={s.folderInput} onchange={handleFileSelect} style="display:none" />
</div>

<style>
    /* ─── Desktop App Shell ─── */
    .desktop-app {
        display: flex;
        flex-direction: column;
        height: 100vh;
        overflow: hidden;
        background-color: var(--bg-color);
        background-image: 
            radial-gradient(at 0% 0%, rgba(139, 92, 246, 0.04) 0px, transparent 50%),
            radial-gradient(at 100% 100%, rgba(217, 70, 239, 0.03) 0px, transparent 50%);
        user-select: none;
        -webkit-user-select: none;
        transition: background-color 0.4s ease, color 0.4s ease;
    }

    .app-content-wrapper {
        display: flex;
        flex: 1;
        overflow: hidden;
    }

    /* ─── Header ─── */
    .app-header {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 0.5rem 1rem;
        background: var(--bg-color);
        box-shadow: var(--shadow-out);
        border-bottom: var(--panel-border);
        flex-shrink: 0;
        -webkit-app-region: drag;
    }
    .app-brand {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-shrink: 0;
    }
    .brand-text {
        font-size: 0.95rem;
        font-weight: 700;
        background: linear-gradient(135deg, var(--purple), var(--blue));
        background-clip: text;
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
    }
    .header-receive {
        display: flex;
        gap: 0.5rem;
        flex: 1;
        max-width: 520px;
        -webkit-app-region: no-drag;
    }
    .header-link-input {
        flex: 1;
        padding: 0.55rem 0.85rem;
        background: var(--bg-color);
        border: var(--panel-border);
        box-shadow: var(--shadow-in);
        color: var(--text-primary);
        border-radius: 8px;
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        font-size: 0.85rem;
        outline: none;
        transition: all 0.2s ease;
    }
    .header-link-input:focus {
        border-color: var(--purple);
        box-shadow: var(--shadow-in), 0 0 10px rgba(139,92,246,0.15);
    }
    .header-link-input::placeholder { color: var(--text-secondary); }
    .header-join-btn {
        padding: 0.55rem 1.25rem;
        background-color: var(--bg-color);
        color: var(--purple) !important;
        box-shadow: var(--shadow-out);
        border: none;
        border-radius: 8px;
        font-size: 0.8rem;
        font-weight: 700;
        font-family: var(--font-display);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        cursor: pointer;
        transition: all 0.2s ease;
        white-space: nowrap;
        outline: none;
    }
    .header-join-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        box-shadow: none;
        border: 1px solid var(--border-highlight);
    }
    .header-join-btn:hover:not(:disabled) {
        box-shadow: var(--shadow-btn-hover);
        transform: translateY(-1px);
    }
    .header-join-btn:active:not(:disabled) {
        box-shadow: var(--shadow-in);
        transform: translateY(1px);
    }

    /* ─── Theme Switcher ─── */
    .btn-theme-toggle {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: none;
        background-color: var(--bg-color);
        box-shadow: var(--shadow-out);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-primary);
        transition: all 0.3s ease, background-color 0.4s ease;
        outline: none;
        -webkit-app-region: no-drag;
        flex-shrink: 0;
    }
    .btn-theme-toggle:hover {
        box-shadow: var(--shadow-btn-hover);
        color: var(--purple);
    }
    .btn-theme-toggle:active {
        box-shadow: var(--shadow-in);
    }
    
    /* ─── Receive Section in Empty State ─── */
    .divider-text {
        display: flex;
        align-items: center;
        width: 100%;
        gap: 0.75rem;
        color: var(--text-secondary);
        font-size: 0.8rem;
    }
    .divider-text::before,
    .divider-text::after {
        content: "";
        flex: 1;
        height: 1px;
        background: var(--panel-border);
    }
    .receive-section {
        width: 100%;
        max-width: 420px;
    }
    .receive-label {
        display: block;
        margin-bottom: 0.5rem;
        color: var(--text-secondary);
        font-size: 0.85rem;
        text-align: center;
    }
    .receive-row {
        display: flex;
        gap: 0.5rem;
        width: 100%;
    }
    .link-input {
        width: 100%;
        padding: 0.6rem 0.75rem;
        background: var(--bg-color);
        border: var(--panel-border);
        box-shadow: var(--shadow-in);
        color: var(--text-primary);
        border-radius: 8px;
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        font-size: 0.78rem;
        outline: none;
        transition: border-color 0.2s;
    }
    .link-input:focus {
        border-color: var(--purple);
    }
    .header-status {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        flex-shrink: 0;
        margin-left: auto;
    }
    .status-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
    }
    .status-ready { background: var(--color-success, #4ade80); box-shadow: 0 0 6px rgba(74,222,128,0.5); }
    .status-loading { background: #facc15; animation: pulse 1.5s infinite; }
    .status-text { font-size: 0.72rem; color: var(--text-secondary); }

    /* ─── Main ─── */
    .app-main {
        flex: 1;
        overflow-y: auto;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    /* ─── Empty State ─── */
    .empty-state {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        border-radius: 28px;
        padding: 3rem;
        background: var(--bg-color);
        box-shadow: var(--shadow-in);
        transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        cursor: default;
        min-height: 300px;
        border: none;
    }
    .empty-state:hover {
        transform: scale(0.99);
    }
    .empty-icon { color: var(--text-secondary); margin-bottom: 1rem; }
    .empty-state h3 { font-size: 1.15rem; font-weight: 600; margin-bottom: 0.25rem; color: var(--text-primary); text-shadow: 0 0 20px rgba(167, 139, 250, 0.1); }
    .muted { color: var(--text-secondary); font-size: 0.85rem; }
    .empty-buttons { display: flex; gap: 0.5rem; margin-top: 1.25rem; }

    /* ─── Content Layout ─── */
    .content-layout {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        flex: 1;
    }

    /* ─── File Panel ─── */
    .file-panel {
        border: var(--panel-border);
        border-radius: 10px;
        background: var(--bg-color);
        box-shadow: var(--shadow-out);
        overflow: hidden;
    }
    .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.5rem 0.75rem;
        background: var(--border-highlight);
        border-bottom: var(--panel-border);
    }
    .panel-title {
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--text-secondary);
    }
    .panel-actions { display: flex; gap: 0.25rem; }
    .btn-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        background: var(--bg-color);
        box-shadow: var(--shadow-out);
        border: var(--panel-border);
        border-radius: 6px;
        color: var(--text-secondary);
        cursor: pointer;
        transition: all 0.15s;
    }
    .btn-icon:hover { color: var(--purple); box-shadow: var(--shadow-btn-hover); }

    /* ─── Transfer Panel ─── */
    .transfer-panel {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }
    .transfer-actions {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        width: 100%;
        max-width: 420px;
        margin: 1rem auto;
    }

    /* ─── Buttons ─── */
    .btn-primary, .btn-secondary {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.4rem;
        background-color: var(--bg-color);
        border: none;
        border-radius: 18px;
        padding: 12px 24px;
        font-weight: 700;
        font-family: var(--font-display);
        cursor: pointer;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        transition: all 0.2s ease, background-color 0.4s ease;
        box-shadow: var(--shadow-out);
        outline: none;
    }
    .btn-primary {
        color: var(--purple) !important;
    }
    .btn-secondary {
        color: var(--blue) !important;
    }
    .btn-primary:hover:not(:disabled), .btn-secondary:hover:not(:disabled) {
        box-shadow: var(--shadow-btn-hover);
        transform: translateY(-2px);
    }
    .btn-primary:active:not(:disabled), .btn-secondary:active:not(:disabled) {
        box-shadow: var(--shadow-in);
        transform: translateY(1px);
    }
    .btn-primary:disabled, .btn-secondary:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        box-shadow: none;
        border: 1px solid var(--border-highlight);
        transform: none;
    }
    .wide { width: 100%; }

    /* ─── Divider ─── */
    .divider {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        color: var(--text-secondary);
        font-size: 0.72rem;
    }
    .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: var(--panel-border); }

    /* ─── Cloud controls ─── */
    .cloud-controls {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        flex-wrap: wrap;
        width: 100%;
    }
    .select-compact {
        padding: 0.4rem 0.55rem;
        background: var(--bg-color);
        box-shadow: var(--shadow-in);
        border: var(--panel-border);
        color: var(--text-secondary);
        border-radius: 6px;
        font-size: 0.75rem;
        cursor: pointer;
        color-scheme: dark;
        outline: none;
    }
    .select-compact:focus { border-color: var(--purple); }
    .select-compact option { background: var(--bg-color); }

    /* ─── Toggle ─── */
    .toggle {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        cursor: pointer;
    }
    .toggle input { display: none; }
    .toggle-track {
        position: relative;
        width: 30px;
        height: 16px;
        background: var(--border-highlight);
        border-radius: 8px;
        transition: background 0.2s;
    }
    .toggle-track::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 12px;
        height: 12px;
        background: var(--text-secondary);
        border-radius: 50%;
        transition: all 0.2s;
    }
    .toggle input:checked + .toggle-track { background: var(--color-error); opacity: 0.5; }
    .toggle input:checked + .toggle-track::after { left: 16px; background: var(--color-error); box-shadow: 0 0 6px var(--color-error); }
    .toggle-lbl { font-size: 0.72rem; color: var(--text-secondary); }
    .toggle input:checked ~ .toggle-lbl { color: var(--text-primary); }

    /* ─── Status Cards ─── */
    .status-card {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 1.25rem;
        border-radius: 10px;
        width: 100%;
        max-width: 420px;
        margin: 1.25rem auto;
        background: var(--bg-color);
        box-shadow: var(--shadow-out);
        border: var(--panel-border);
    }
    .status-card.waiting { border: 1px solid rgba(167, 139, 250, 0.25); }
    .status-card.done { border: 1px solid rgba(16, 185, 129, 0.25); }
    .status-label { font-size: 0.85rem; font-weight: 600; color: var(--purple); }
    .done-label { color: var(--color-success); }
    .link-display {
        width: 100%;
        padding: 0.45rem 0.65rem;
        background: var(--bg-color);
        box-shadow: var(--shadow-in);
        border: var(--panel-border);
        color: var(--text-secondary);
        border-radius: 6px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.7rem;
        outline: none;
    }

    /* ─── Progress ─── */
    .progress-section {
        width: 100%;
        max-width: 420px;
        margin: 1.25rem auto;
    }
    .progress-bar {
        height: 6px;
        background: var(--border-highlight);
        border-radius: 3px;
        overflow: hidden;
    }
    .progress-fill {
        height: 100%;
        background: linear-gradient(90deg, var(--purple), var(--blue));
        border-radius: 3px;
        transition: width 0.3s ease;
    }
    .progress-info {
        display: flex;
        justify-content: space-between;
        font-size: 0.7rem;
        color: var(--text-secondary);
        margin-top: 0.3rem;
    }

    @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
    }
</style>
