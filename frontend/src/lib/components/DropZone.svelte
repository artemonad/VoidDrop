<script lang="ts">
    import type { TransferState } from "$lib/transfer/transferState.svelte";
    import FileExplorer from "./FileExplorer.svelte";
    import { i18n } from "$lib/i18n.svelte";

    let {
        s,
        fileTree,
        explorerFiles,
        removeFile,
        removeMultipleFiles,
        clearAllFiles,
    }: {
        s: TransferState;
        fileTree: any;
        explorerFiles: any[];
        removeFile: (index: number) => void;
        removeMultipleFiles: (indexes: number[]) => void;
        clearAllFiles: (e: Event) => void;
    } = $props();

    function fmt(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`;
        return `${(bytes / 1073741824).toFixed(2)} GB`;
    }
</script>

<div 
    class="dropzone {s.isScanningFiles ? 'scanning' : ''}" 
    role="button" 
    tabindex="0"
    onclick={() => s.fileInput?.click()}
    onkeydown={(e) => e.key === 'Enter' && s.fileInput?.click()}
>
    <div class="dropzone-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
    </div>
    {#if s.isScanningFiles}
        <h3 class="animate-pulse">{i18n.t('scanning')}</h3>
        <span class="text-muted">{i18n.t('pleaseWaitScan')}</span>
    {:else if s.selectedFiles.length > 0}
        <h3>{i18n.t('bundleReady')}</h3>
        <span class="text-muted">{s.selectedFiles.length} {i18n.t('files')} • {fmt(s.totalSelectionSize)}</span>
        
        <div role="presentation" onclick={(e) => e.stopPropagation()} style="margin-top: 1.5rem; text-align: left; width: 100%;">
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
        </div>
    {:else}
        <p>Drag and drop files here</p>
        <span>or click to browse</span>
    {/if}
</div>

<style>
    .dropzone {
        padding: 2.5rem 1.5rem;
        border-radius: 20px;
        background: var(--bg-color);
        box-shadow: var(--shadow-in);
        text-align: center;
        cursor: pointer;
        transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 200px;
    }
    .dropzone:hover {
        transform: scale(0.99);
    }
    .dropzone-icon {
        color: var(--text-secondary);
        margin-bottom: 1rem;
        transition: color 0.3s, transform 0.3s;
    }
    .dropzone:hover .dropzone-icon {
        color: var(--purple);
        transform: translateY(-4px);
    }
    .dropzone h3 {
        font-size: 1.15rem;
        font-weight: 600;
        margin-bottom: 0.25rem;
        color: var(--text-primary);
    }
    .dropzone p {
        font-size: 1.05rem;
        font-weight: 500;
        margin: 0;
        color: var(--text-primary);
    }
    .dropzone span {
        font-size: 0.85rem;
        color: var(--text-secondary);
        margin-top: 0.25rem;
    }
    .text-muted {
        color: var(--text-secondary) !important;
    }
    .animate-pulse {
        animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
    @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: .5; }
    }
</style>
