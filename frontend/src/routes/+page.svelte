<script lang="ts">
    import { onMount } from "svelte";
    import { env } from "$env/dynamic/public";
    import {
        buildFileTree,
        traverseDropEntry,
        type FileWithMeta,
    } from "$lib/fileTree";
    import { isJunkFile } from "$lib/junkFilter";
    import {
        createTransferState,
        initCryptoOrchestrator,
        setupWebRTC,
        initWebRTC,
    } from "$lib/transfer";
    import { handlePasteLink as pasteLinkHelper } from "$lib/transfer/linkHandler";
    import { isTauri } from "$lib/isTauri";
    import { readDirRecursive, getTauriFilesFromPaths } from "$lib/tauriFs";
    import ConnectionLog from "$lib/components/ConnectionLog.svelte";
    import Logo from "$lib/components/Logo.svelte";
    import DropZone from "$lib/components/DropZone.svelte";
    import SenderView from "$lib/components/SenderView.svelte";
    import ReceiverView from "$lib/components/ReceiverView.svelte";
    import SpecModal from "$lib/components/SpecModal.svelte";
    import { i18n } from "$lib/i18n.svelte";

    const s = createTransferState();
    const apiBase = env.PUBLIC_API_BASE || "https://api.voiddrop.ru";

    function fmt(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`;
        return `${(bytes / 1073741824).toFixed(2)} GB`;
    }

    // --- Wake Lock management ---
    let wakeLockSentinel: WakeLockSentinel | null = null;
    async function requestWakeLock() {
        try {
            if ("wakeLock" in navigator) {
                wakeLockSentinel = await navigator.wakeLock.request("screen");
            }
        } catch {
            // Wake Lock not available or denied — non-critical
        }
    }
    function releaseWakeLock() {
        if (wakeLockSentinel) {
            wakeLockSentinel.release().then(() => {
                wakeLockSentinel = null;
            }).catch(() => {});
        }
    }

    $effect(() => {
        if (
            s.flowState === "HANDSHAKE" ||
            s.flowState === "MANIFEST" ||
            s.flowState === "STREAMING"
        ) {
            requestWakeLock();
        } else {
            releaseWakeLock();
        }
    });

    // --- Derived state ---
    let fileTree = $derived.by(() => buildFileTree(s.selectedFiles));
    let explorerFiles = $derived(
        s.selectedFiles.map((f, i) => ({
            path: f.path,
            size: f.file.size,
            originalIndex: i,
            file: f.file,
        })),
    );

    // --- File management helpers ---
    function removeFile(index: number) {
        if (s.flowState !== "IDLE") return;
        const removedPath = s.selectedFiles[index].path;
        s.totalSelectionSize -= s.selectedFiles[index].file.size;
        let newArr = [...s.selectedFiles];
        newArr.splice(index, 1);
        s.selectedFiles = newArr;
        s.log(`Removed file: ${removedPath}`);
        if (s.selectedFiles.length === 0) {
            s.resetToHome();
        }
        if (s.currentPage * 100 >= s.selectedFiles.length && s.currentPage > 0)
            s.currentPage--;
    }

    function clearAllFiles(e: Event) {
        e.stopPropagation();
        if (s.flowState !== "IDLE") return;
        s.resetToHome();
        s.log("Cleared all files.");
    }

    function removeMultipleFiles(indexes: number[]) {
        if (s.flowState !== "IDLE") return;
        const set = new Set(indexes);
        let removedSize = 0;
        s.selectedFiles = s.selectedFiles.filter((item, i) => {
            if (set.has(i)) {
                removedSize += item.file.size;
                return false;
            }
            return true;
        });
        s.totalSelectionSize -= removedSize;
        if (s.selectedFiles.length === 0) {
            s.resetToHome();
        }
        if (s.currentPage * 100 >= s.selectedFiles.length && s.currentPage > 0)
            s.currentPage--;
        s.log(`Removed ${indexes.length} file(s)`);
    }

    // --- File input handlers ---
    function handleFileSelect(e: Event) {
        s.currentPage = 0;
        const input = e.target as HTMLInputElement;
        const filesList = input.files;
        if (!filesList || filesList.length === 0) return;
        const files = Array.from(filesList);
        s.isScanningFiles = true;
        setTimeout(() => {
            let newFiles: FileWithMeta[] = [];
            let addedSize = 0;
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (isJunkFile(file.name)) {
                    continue;
                }
                const path = file.webkitRelativePath || file.name;
                newFiles.push({ file, path });
                addedSize += file.size;
            }
            s.selectedFiles = [...s.selectedFiles, ...newFiles];
            s.totalSelectionSize += addedSize;
            s.isScanningFiles = false;
            if (s.selectedFiles.length > 0) {
                s.peerRole = "sender";
                s.log(
                    `Selected ${s.selectedFiles.length} file(s). Total: ${fmt(s.totalSelectionSize)}`,
                );
            }
            input.value = "";
        }, 50);
    }

    async function handleDrop(e: DragEvent) {
        e.preventDefault();
        s.currentPage = 0;
        if (!e.dataTransfer?.items) return;
        s.isScanningFiles = true;
        let promises: Promise<FileWithMeta[]>[] = [];
        for (let i = 0; i < e.dataTransfer.items.length; i++) {
            const item = e.dataTransfer.items[i];
            if (item.kind === "file") {
                const entry = item.webkitGetAsEntry();
                if (entry) promises.push(traverseDropEntry(entry, ""));
            }
        }
        const results = await Promise.all(promises);
        const newFiles = results.flat();
        const newSize = newFiles.reduce((sum, f) => sum + f.file.size, 0);
        s.selectedFiles = [...s.selectedFiles, ...newFiles];
        s.totalSelectionSize += newSize;
        s.isScanningFiles = false;
        if (s.selectedFiles.length > 0) {
            s.peerRole = "sender";
            s.log(
                `Selected ${s.selectedFiles.length} file(s). Total: ${fmt(s.totalSelectionSize)}`,
            );
        }
    }

    function handlePasteLink() {
        pasteLinkHelper(s, apiBase);
    }

    // --- Buffered amount polling for sender progress bar ---
    $effect(() => {
        if (
            s.flowState !== "STREAMING" ||
            s.peerRole !== "sender" ||
            !s.webrtc ||
            s.useReceiverProgress
        ) {
            s.senderBuffered = 0;
            return;
        }
        const interval = setInterval(() => {
            if (s.useReceiverProgress) {
                s.senderBuffered = 0;
            } else {
                s.senderBuffered = s.webrtc?.getBufferedAmount() ?? 0;
            }
        }, 200);
        return () => clearInterval(interval);
    });

    let isDesktop = $state(false);
    let isLight = $state(false);
    let showSpecification = $state(false);

    function toggleTheme() {
        isLight = !isLight;
        if (isLight) {
            document.documentElement.classList.add('light');
            localStorage.setItem('theme', 'light');
        } else {
            document.documentElement.classList.remove('light');
            localStorage.setItem('theme', 'dark');
        }
    }

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

    function triggerFileSelect() {
        if (isTauri()) {
            selectFilesTauri();
        } else {
            s.fileInput?.click();
        }
    }

    function triggerFolderSelect() {
        if (isTauri()) {
            selectFolderTauri();
        } else {
            s.folderInput?.click();
        }
    }

    // --- Lifecycle ---
    onMount(() => {
        isDesktop = isTauri();

        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'light') {
            isLight = true;
            document.documentElement.classList.add('light');
        } else {
            isLight = false;
            document.documentElement.classList.remove('light');
        }

        const preventDefault = (e: DragEvent) => e.preventDefault();
        const dropHandler = (e: DragEvent) => {
            e.preventDefault();
            handleDrop(e);
        };
        const unloadHandler = () => {
            s.webrtc?.close();
        };

        window.addEventListener('dragover', preventDefault as EventListener);
        window.addEventListener('drop', dropHandler as EventListener);
        window.addEventListener('beforeunload', unloadHandler);

        const cleanup = initCryptoOrchestrator(s, apiBase);
        return () => {
            window.removeEventListener('dragover', preventDefault as EventListener);
            window.removeEventListener('drop', dropHandler as EventListener);
            window.removeEventListener('beforeunload', unloadHandler);
            cleanup();
        };
    });

</script>


    <header class="neu-header">
        <a href="/" class="logo" onclick={(e) => { e.preventDefault(); s.resetToHome(); }}>
            <Logo size={24} />
            <span>VoidDrop</span>
        </a>
        <div class="nav-controls">
            <button class="btn-theme-toggle" onclick={toggleTheme} title="Toggle Dark/Light Mode">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="5"></circle>
                    <line x1="12" y1="1" x2="12" y2="3"></line>
                    <line x1="12" y1="21" x2="12" y2="23"></line>
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                    <line x1="1" y1="12" x2="3" y2="12"></line>
                    <line x1="21" y1="12" x2="23" y2="12"></line>
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
                </svg>
            </button>
            <button class="btn-spec" onclick={() => showSpecification = true}>
                {i18n.t('specification')}
            </button>
        </div>
    </header>

    <main class="container {s.flowState !== 'IDLE' ? 'active-mode' : ''}">
        {#if s.flowState === "IDLE"}
            <div class="hero-block">
                <div class="tag">{i18n.t('tag')}</div>
                <h1>{i18n.t('title')}</h1>
                <p class="desc">
                    {i18n.t('desc')}
                </p>
            </div>
        {/if}

        <div class="neu-panel">
            {#if s.flowState === "IDLE"}
                <!-- DROP ZONE -->
                <DropZone
                    {s}
                    {fileTree}
                    {explorerFiles}
                    {removeFile}
                    {removeMultipleFiles}
                    {clearAllFiles}
                />

                <!-- BUTTONS ROW -->
                <div class="buttons-row">
                    <button class="btn btn-colored" onclick={triggerFileSelect}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                            <line x1="12" y1="5" x2="12" y2="19"/>
                            <line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                        {i18n.t('selectFiles')}
                    </button>
                    <button class="btn btn-colored-blue" onclick={triggerFolderSelect}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        </svg>
                        {i18n.t('selectFolder')}
                    </button>
                </div>

                {#if s.selectedFiles.length > 0}
                    <!-- If files are ready to send, show P2P session button -->
                    <div class="action-buttons">
                        <button
                            class="btn btn-colored"
                            style="width: 100%; margin-top: 1rem;"
                            onclick={() =>
                                initWebRTC(s, (rid) =>
                                    setupWebRTC(s, rid, apiBase),
                                )}
                            disabled={!s.isWorkerReady}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <circle cx="18" cy="5" r="3" />
                                <circle cx="6" cy="12" r="3" />
                                <circle cx="18" cy="19" r="3" />
                                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                            </svg>
                            {s.isWorkerReady ? i18n.t('createSession') : i18n.t('loadingEngine')}
                        </button>
                    </div>
                {/if}

                <!-- RECEIVE SECTION -->
                <div class="receive-section">
                    <label for="receive-input">{i18n.t('receiveStream')}</label>
                    <div class="input-group">
                        <input
                            id="receive-input"
                            class="link-input"
                            type="text"
                            bind:value={s.pasteLinkInput}
                            placeholder={i18n.t('pastePlaceholder')}
                        />
                        <button class="btn-open" onclick={handlePasteLink}>
                            {i18n.t('open')}
                        </button>
                    </div>
                </div>
            {:else}
                <!-- ACTIVE TRANSFER PANEL -->
                {#if s.peerRole === "sender"}
                    <SenderView {s} />
                {:else if s.peerRole === "receiver"}
                    <ReceiverView {s} />
                {/if}
            {/if}
        </div>

        <!-- Hidden file inputs — always in DOM -->
        <input
            type="file"
            multiple
            bind:this={s.fileInput}
            onchange={handleFileSelect}
            style="display: none;"
        />
        <input
            type="file"
            webkitdirectory
            multiple
            bind:this={s.folderInput}
            onchange={handleFileSelect}
            style="display: none;"
        />

        <ConnectionLog state={s} />
    </main>

    <SpecModal bind:show={showSpecification} />

{#if s.toastMessage}
    <div class="toast">{s.toastMessage}</div>
{/if}

<style>
    .neu-header {
        max-width: 1100px;
        width: 100%;
        margin: 0 auto;
        padding: 2.5rem 1.5rem 1rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
        user-select: none;
        -webkit-user-select: none;
        -webkit-app-region: drag;
    }

    .logo {
        font-family: var(--font-display);
        font-size: 1.5rem;
        font-weight: 700;
        text-decoration: none;
        color: var(--text-primary);
        display: flex;
        align-items: center;
        gap: 0.6rem;
        letter-spacing: -0.02em;
        -webkit-app-region: no-drag;
    }

    .nav-controls {
        display: flex;
        align-items: center;
        gap: 1.5rem;
        -webkit-app-region: no-drag;
    }

    .btn-theme-toggle {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: none;
        background-color: var(--bg-color);
        box-shadow: var(--shadow-out);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-primary);
        transition: all 0.3s ease;
        outline: none;
        font-weight: bold;
        font-size: 0.8rem;
    }

    .btn-theme-toggle:hover {
        box-shadow: var(--shadow-btn-hover);
        color: var(--purple);
    }

    .btn-theme-toggle:active {
        box-shadow: var(--shadow-in);
    }

    .btn-spec {
        color: var(--text-secondary);
        text-decoration: none;
        font-size: 0.85rem;
        font-weight: 600;
        padding: 0.7rem 1.4rem;
        border-radius: 12px;
        background-color: var(--bg-color);
        border: none;
        box-shadow: var(--shadow-out);
        cursor: pointer;
        transition: all 0.3s ease;
        font-family: var(--font-sans);
        outline: none;
    }

    .btn-spec:hover {
        box-shadow: var(--shadow-in);
        color: var(--text-primary);
    }

    .btn-spec:active {
        box-shadow: var(--shadow-in);
    }

    .container {
        max-width: 1100px;
        width: 100%;
        margin: 0 auto;
        padding: 2rem 1.5rem 6rem;
        flex-grow: 1;
        display: grid;
        grid-template-columns: 1.1fr 1fr;
        gap: 5rem;
        align-items: center;
        min-height: calc(100vh - 180px);
        transition: all 0.4s ease;
    }

    .container.active-mode {
        grid-template-columns: 1fr;
        max-width: 720px;
        justify-content: center;
        gap: 0;
    }

    .hero-block {
        display: flex;
        flex-direction: column;
        gap: 2rem;
        text-align: left;
        user-select: none;
        -webkit-user-select: none;
        align-self: start;
    }

    .tag {
        align-self: flex-start;
        padding: 0.5rem 1.2rem;
        border-radius: 20px;
        font-size: 0.75rem;
        font-weight: 700;
        color: var(--purple);
        box-shadow: var(--shadow-out);
        transition: all 0.4s ease;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    h1 {
        font-family: var(--font-display);
        font-size: 3.5rem;
        font-weight: 700;
        line-height: 1.1;
        letter-spacing: -0.03em;
        color: var(--text-primary);
    }

    .desc {
        font-size: 1.15rem;
        line-height: 1.6;
        color: var(--text-secondary);
        font-weight: 300;
        transition: color 0.4s ease;
    }

    /* Neumorphic Panel */
    .neu-panel {
        background-color: var(--bg-color);
        border-radius: 36px;
        padding: 3rem;
        box-shadow: var(--shadow-out);
        border: var(--panel-border);
        display: flex;
        flex-direction: column;
        gap: 2.2rem;
        transition: all 0.4s ease;
        width: 100%;
    }

    .buttons-row {
        display: flex;
        gap: 1.2rem;
        width: 100%;
    }

    .btn {
        flex: 1;
        padding: 1.1rem;
        border-radius: 18px;
        font-family: var(--font-display);
        font-size: 0.95rem;
        font-weight: 700;
        border: none;
        cursor: pointer;
        background-color: var(--bg-color);
        color: var(--text-primary);
        box-shadow: var(--shadow-out);
        transition: all 0.2s ease;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        text-transform: uppercase;
        letter-spacing: 0.02em;
        outline: none;
    }

    .btn:hover:not(:disabled) {
        box-shadow: var(--shadow-btn-hover);
        transform: translateY(-2px);
    }

    .btn:active:not(:disabled) {
        box-shadow: var(--shadow-in);
        transform: translateY(1px);
    }

    .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .btn-colored {
        color: var(--purple) !important;
    }

    .btn-colored-blue {
        color: var(--blue) !important;
    }

    .action-buttons {
        width: 100%;
    }

    .receive-section {
        display: flex;
        flex-direction: column;
        gap: 0.8rem;
        border-top: 1px solid var(--border-highlight);
        padding-top: 2rem;
        transition: all 0.4s ease;
    }

    .receive-section label {
        font-size: 0.75rem;
        font-weight: 700;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        text-align: left;
    }

    .input-group {
        display: flex;
        background-color: var(--bg-color);
        box-shadow: var(--shadow-in);
        border-radius: 16px;
        padding: 0.35rem;
        transition: all 0.4s ease;
        width: 100%;
    }

    .input-group input {
        flex-grow: 1;
        background: transparent;
        border: none;
        padding: 0.6rem 0.8rem;
        color: var(--text-primary);
        font-size: 0.9rem;
        font-weight: 600;
        outline: none;
        transition: all 0.4s ease;
    }

    .btn-open {
        background-color: var(--bg-color);
        border: none;
        color: var(--purple);
        padding: 0 1.6rem;
        border-radius: 12px;
        box-shadow: var(--shadow-out);
        font-family: var(--font-display);
        font-weight: 700;
        cursor: pointer;
        transition: all 0.2s ease;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        outline: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }

    .btn-open:hover {
        box-shadow: var(--shadow-in);
    }

    .btn-open:active {
        box-shadow: var(--shadow-in);
    }

    /* Toast style */
    .toast {
        position: fixed;
        bottom: 2.5rem;
        left: 50%;
        transform: translateX(-50%);
        background: var(--bg-color);
        box-shadow: var(--shadow-out);
        border: var(--panel-border);
        color: var(--text-primary);
        padding: 0.9rem 1.8rem;
        border-radius: 16px;
        font-size: 0.9rem;
        font-weight: 600;
        z-index: 9999;
        animation: toastIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }

    @keyframes toastIn {
        from {
            opacity: 0;
            transform: translateX(-50%) translateY(1.5rem);
        }
        to {
            opacity: 1;
            transform: translateX(-50%) translateY(0);
        }
    }

    /* Mobile Responsiveness */
    @media (max-width: 968px) {
        .container {
            grid-template-columns: 1fr;
            gap: 4rem;
            padding: 2rem 1rem;
        }

        .hero-block {
            text-align: center;
            align-items: center;
        }

        h1 {
            font-size: 2.4rem;
        }

        .desc {
            font-size: 1rem;
        }

        .neu-panel {
            padding: 2rem 1.5rem;
            border-radius: 28px;
        }

        .buttons-row {
            flex-direction: column;
            gap: 1rem;
        }

        .btn {
            width: 100%;
        }
    }

    @media (max-width: 480px) {
        .container {
            padding: 1rem 0.5rem 4rem;
            gap: 2.5rem;
        }
        .neu-header {
            padding: 1.5rem 0.75rem 0.5rem;
        }
        .nav-controls {
            gap: 0.75rem;
        }
        .btn-spec {
            padding: 0.5rem 1rem;
            font-size: 0.75rem;
        }
        .neu-panel {
            padding: 1.25rem 0.75rem;
            border-radius: 20px;
            gap: 1.5rem;
        }
        .input-group {
            padding: 0.25rem;
            border-radius: 12px;
        }
        .input-group input {
            padding: 0.5rem;
            font-size: 0.85rem;
        }
        .btn-open {
            padding: 0 1rem;
            font-size: 0.8rem;
        }
        h1 {
            font-size: 2rem;
        }
    }
</style>
