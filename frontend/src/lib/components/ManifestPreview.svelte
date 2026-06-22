<script lang="ts">
    /**
     * ManifestPreview — Shows incoming files from the decrypted manifest
     * and lets the receiver confirm the download.
     * 
     * Uses optimized slice-based pagination to render 50 files per page,
     * ensuring instant rendering even for bundles with 500+ files.
     */
    import type { TransferState } from "$lib/transfer";
    import { startP2PDownload } from "$lib/transfer";
    import { isTauri } from "$lib/isTauri";

    const isDesktop = isTauri();

    interface Props {
        state: TransferState;
    }

    let { state: s }: Props = $props();

    // Pagination State
    let page = $state(0);
    const FILES_PER_PAGE = 50;

    let totalFiles = $derived(s.receiverManifest ? s.receiverManifest.files.length : 0);
    let totalPages = $derived(Math.ceil(totalFiles / FILES_PER_PAGE));
    let isBundle = $derived(
        s.receiverManifest
            ? s.receiverManifest.type === "bundle" || s.receiverManifest.files.length > 1
            : false
    );

    // Auto-clamp page if manifest changes
    $effect(() => {
        if (page >= totalPages && totalPages > 0) {
            page = totalPages - 1;
        }
    });

    // Derive only files on the current page to prevent Svelte reactivity bottleneck
    let visibleFiles = $derived(
        s.receiverManifest
            ? s.receiverManifest.files.slice(page * FILES_PER_PAGE, (page + 1) * FILES_PER_PAGE)
            : []
    );

    let selectedCount = $derived(
        s.receiverManifest
            ? s.receiverManifest.files.filter((_: any, i: number) => s.p2pSelectedFiles[i]).length
            : 0
    );
    let selectedSize = $derived(
        s.receiverManifest
            ? s.receiverManifest.files.reduce((sum: number, file: any, i: number) => sum + (s.p2pSelectedFiles[i] ? file.size : 0), 0)
            : 0
    );

    function selectAll() {
        if (!s.receiverManifest) return;
        s.p2pSelectedFiles = new Array(s.receiverManifest.files.length).fill(true);
    }

    function deselectAll() {
        if (!s.receiverManifest) return;
        s.p2pSelectedFiles = new Array(s.receiverManifest.files.length).fill(false);
    }

    function fmt(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`;
        return `${(bytes / 1073741824).toFixed(2)} GB`;
    }

    let hasFileSystemAccess = $derived(
        typeof window !== "undefined"
            ? (isBundle ? ('showDirectoryPicker' in window) : ('showSaveFilePicker' in window))
            : false
    );
</script>

{#if s.flowState === "MANIFEST" && s.receiverManifest}
    <div class="status-box" style="text-align: left;">
        <p class="status-title">Incoming Files</p>
        
        <div class="incoming-header-row">
            <p class="text-muted" style="margin: 0; font-size: 0.85rem;">
                {selectedCount} / {totalFiles} selected — {fmt(selectedSize)} total
            </p>
            <div style="display: flex; gap: 0.4rem;">
                <button class="btn-action-small" onclick={selectAll}>Select All</button>
                <button class="btn-action-small" onclick={deselectAll}>Clear</button>
            </div>
        </div>

        <div
            class="selected-files-list"
            style="max-height: 300px; overflow-y: auto; margin-bottom: 0.75rem;"
        >
            {#each visibleFiles as file, i}
                {@const actualIndex = page * FILES_PER_PAGE + i}
                <div class="file-item">
                    <label
                        class="file-label"
                        style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; flex: 1; min-width: 0;"
                    >
                        <input
                            type="checkbox"
                            bind:checked={s.p2pSelectedFiles[actualIndex]}
                        />
                        <svg class="file-icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                        </svg>
                        <span
                            class="file-name"
                            title={file.path}>{file.path}</span
                        >
                    </label>
                    <span class="file-size">{fmt(file.size)}</span>
                </div>
            {/each}
        </div>

        <!-- Pagination Controls -->
        {#if totalPages > 1}
            <div class="pagination-controls-responsive">
                <button 
                    class="btn-action-small" 
                    onclick={() => page = Math.max(0, page - 1)}
                    disabled={page === 0}
                >
                    &larr; Prev
                </button>
                <span class="pagination-info" style="font-size: 0.8rem; color: var(--color-muted);">
                    Page {page + 1} of {totalPages}
                </span>
                <button 
                    class="btn-action-small" 
                    onclick={() => page = Math.min(totalPages - 1, page + 1)}
                    disabled={page === totalPages - 1}
                >
                    Next &rarr;
                </button>
            </div>
        {/if}

        <div class="buttons-row-responsive">
            <button
                class="btn-p2p"
                style="flex: 1;"
                onclick={() => startP2PDownload(s, isDesktop ? false : !hasFileSystemAccess)}
                disabled={!s.p2pSelectedFiles.some((v) => v)}
            >
                <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                {isBundle ? 'Download All' : 'Download File'}
            </button>

            {#if isBundle && hasFileSystemAccess && !isDesktop}
                <button
                    type="button"
                    class="btn-secondary-zip"
                    style="flex: 1;"
                    onclick={() => startP2PDownload(s, true)}
                    disabled={!s.p2pSelectedFiles.some((v) => v)}
                >
                    <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <polyline points="21 8 21 21 3 21 3 8"></polyline>
                        <rect x="1" y="3" width="22" height="5"></rect>
                        <line x1="10" y1="12" x2="14" y2="12"></line>
                    </svg>
                    Download as ZIP
                </button>
            {/if}
        </div>
    </div>
{/if}

<style>
    .status-box {
        background-color: var(--bg-color);
        box-shadow: var(--shadow-in);
        border: var(--panel-border);
        border-radius: 20px;
        padding: 1.5rem;
        margin-top: 1rem;
    }
    .status-title {
        font-family: var(--font-display);
        font-weight: 700;
        font-size: 1.15rem;
        margin-bottom: 0.5rem;
        color: var(--text-primary);
    }
    .selected-files-list {
        max-height: 250px;
        overflow-y: auto;
        overflow-x: auto;
        padding-right: 0.4rem;
    }
    .file-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.5rem 0.6rem;
        gap: 1rem;
        border-bottom: 1px solid var(--border-highlight);
        font-size: 0.85rem;
    }
    .file-name {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        min-width: 0;
        color: var(--text-primary);
        font-weight: 500;
    }
    .file-size {
        white-space: nowrap;
        color: var(--text-secondary);
        font-size: 0.8rem;
    }
    .text-muted {
        color: var(--text-secondary);
    }
    .btn-p2p {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 0.85rem 1.4rem;
        background-color: var(--bg-color);
        color: var(--purple) !important;
        border: none;
        border-radius: 14px;
        font-family: var(--font-display);
        font-weight: 700;
        font-size: 0.95rem;
        cursor: pointer;
        transition: all 0.25s ease;
        box-shadow: var(--shadow-out);
    }
    .btn-p2p:hover:not(:disabled) {
        transform: translateY(-2px);
        box-shadow: var(--shadow-btn-hover);
    }
    .btn-p2p:active:not(:disabled) {
        transform: translateY(1px);
        box-shadow: var(--shadow-in);
    }
    .btn-p2p:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
    .btn-secondary-zip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 0.85rem 1.4rem;
        background-color: var(--bg-color);
        color: var(--blue) !important;
        border: none;
        border-radius: 14px;
        font-family: var(--font-display);
        font-weight: 700;
        font-size: 0.95rem;
        cursor: pointer;
        transition: all 0.25s ease;
        box-shadow: var(--shadow-out);
    }
    .btn-secondary-zip:hover:not(:disabled) {
        background-color: var(--bg-color);
        color: var(--blue) !important;
        transform: translateY(-2px);
        box-shadow: var(--shadow-btn-hover);
    }
    .btn-secondary-zip:active:not(:disabled) {
        transform: translateY(1px);
        box-shadow: var(--shadow-in);
    }
    .btn-secondary-zip:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
    .file-label input[type="checkbox"] {
        accent-color: var(--purple);
        cursor: pointer;
        width: 18px;
        height: 18px;
        flex-shrink: 0;
    }
    .btn-action-small {
        background-color: var(--bg-color);
        border: none;
        color: var(--text-secondary);
        font-family: var(--font-sans);
        font-size: 0.75rem;
        font-weight: 600;
        padding: 0.35rem 0.75rem;
        border-radius: 8px;
        box-shadow: var(--shadow-out);
        cursor: pointer;
        transition: all 0.2s ease;
    }
    .btn-action-small:hover:not(:disabled) {
        box-shadow: var(--shadow-in);
        color: var(--text-primary);
    }
    .btn-action-small:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
    .file-icon-svg {
        color: var(--blue);
        fill: rgba(59, 130, 246, 0.16);
        flex-shrink: 0;
        margin-right: 0.5rem;
        transition: all 0.3s ease;
    }
    .buttons-row-responsive {
        display: flex;
        gap: 0.5rem;
        width: 100%;
    }
    .incoming-header-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.75rem;
        gap: 1rem;
        flex-wrap: wrap;
    }
    .pagination-controls-responsive {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 0.5rem;
        margin-bottom: 1rem;
        gap: 1rem;
        flex-wrap: wrap;
    }
    @media (max-width: 600px) {
        .buttons-row-responsive {
            flex-direction: column !important;
            gap: 0.75rem !important;
        }
        .buttons-row-responsive button,
        .buttons-row-responsive :global(button) {
            width: 100% !important;
            flex: none !important;
        }
        .incoming-header-row {
            flex-direction: column;
            align-items: flex-start;
            gap: 0.5rem;
        }
    }
    @media (max-width: 480px) {
        .pagination-controls-responsive {
            justify-content: center;
            gap: 0.75rem;
        }
    }
</style>
