<script lang="ts">
    /**
     * FileExplorer — Unified file list/tree view with toolbar.
     *
     * Used by both the sender page (+page.svelte) and the download page (f/[id]/+page.svelte).
     *
     * Modes:
     * - "sender": files have remove buttons, no checkboxes
     * - "receiver": files have selection checkboxes, no remove buttons
     */
    import type { TreeNode } from "$lib/fileTree";

    interface FileEntry {
        path: string;
        size: number;
        originalIndex: number;
        file?: File; // only present in sender mode
    }

    interface Props {
        /** List of files to display (already mapped to { path, size, originalIndex }) */
        files: FileEntry[];
        /** Pre-built tree (from buildFileTree or equivalent) */
        fileTree: TreeNode;
        /** "sender" shows remove buttons; "receiver" shows checkboxes */
        mode: "sender" | "receiver";

        // --- View state (two-way bindable) ---
        viewMode: "list" | "tree";
        searchQuery: string;
        sortMode: string;
        currentPage: number;
        treeOpenState: Set<string>;

        // --- Receiver mode: selection state ---
        selectedFiles?: boolean[];

        // --- Sender mode: callbacks ---
        onRemoveFile?: (index: number) => void;
        onRemoveMultiple?: (indexes: number[]) => void;
        onClearAll?: (e: Event) => void;
    }

    let {
        files,
        fileTree,
        mode,
        viewMode = $bindable("list"),
        searchQuery = $bindable(""),
        sortMode = $bindable("name_asc"),
        currentPage = $bindable(0),
        treeOpenState = $bindable(new Set()),
        selectedFiles = $bindable([]),
        onRemoveFile,
        onRemoveMultiple,
        onClearAll,
    }: Props = $props();

    // --- Internal derived state ---
    let filteredFiles = $derived(
        files
            .filter((f) =>
                f.path.toLowerCase().includes(searchQuery.toLowerCase()),
            )
            .sort((a, b) => {
                if (sortMode === "name_asc") return a.path.localeCompare(b.path);
                if (sortMode === "name_desc") return b.path.localeCompare(a.path);
                if (sortMode === "size_asc") return a.size - b.size;
                if (sortMode === "size_desc") return b.size - a.size;
                return 0;
            }),
    );

    function toggleTreeFolder(path: string) {
        if (treeOpenState.has(path)) treeOpenState.delete(path);
        else treeOpenState.add(path);
        treeOpenState = new Set(treeOpenState);
    }

    function toggleFolderSelection(indexes: number[]) {
        if (!selectedFiles) return;
        const allSelected = indexes.every((i) => selectedFiles![i]);
        for (const i of indexes) {
            selectedFiles![i] = !allSelected;
        }
    }

    function indeterminateAction(node: HTMLInputElement, value: boolean) {
        node.indeterminate = value;
        return {
            update(v: boolean) {
                node.indeterminate = v;
            }
        };
    }

    function fmt(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`;
        return `${(bytes / 1073741824).toFixed(2)} GB`;
    }
</script>

<!-- Toolbar: view toggle, search, sort, clear -->
<div
    class="list-toolbar"
    role="presentation"
    onclick={(e) => e.stopPropagation()}
>
    <div class="view-toggle" style="display: flex; gap: 0.5rem;">
        <button
            class="btn-page {viewMode === 'list' ? 'active-toggle' : ''}"
            onclick={() => (viewMode = "list")}
        >List</button>
        <button
            class="btn-page {viewMode === 'tree' ? 'active-toggle' : ''}"
            onclick={() => (viewMode = "tree")}
            disabled={!!searchQuery}
            title={searchQuery ? "Tree view is disabled during search" : ""}
        >Tree</button>
    </div>
    <input
        type="text"
        placeholder="Search files..."
        bind:value={searchQuery}
        oninput={() => { currentPage = 0; viewMode = "list"; }}
        class="search-input"
    />
    <select
        bind:value={sortMode}
        onchange={() => (currentPage = 0)}
        class="sort-select"
    >
        <option value="name_asc">Name (A-Z)</option>
        <option value="name_desc">Name (Z-A)</option>
        <option value="size_desc">Size (Largest first)</option>
        <option value="size_asc">Size (Smallest first)</option>
    </select>
    {#if mode === "sender" && onClearAll}
        <button
            class="btn-clear-all"
            onclick={onClearAll}
            title="Remove all files"
        >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                <line x1="10" y1="11" x2="10" y2="17"></line>
                <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
        </button>
    {/if}
</div>

<!-- Tree View -->
{#if viewMode === "tree"}
    {#snippet renderTreeNode(node: TreeNode, depth: number)}
        <div class="tree-node" style="padding-left: {depth * 1.5}rem;">
            {#if node.isDirectory}
                <div
                    class="file-item folder-item"
                    style="cursor: pointer; background: rgba(0,0,0,0.03);"
                    role="presentation"
                    onclick={() => toggleTreeFolder(node.path)}
                >
                    {#if mode === "receiver" && selectedFiles}
                        <input
                            type="checkbox"
                            checked={node.allOriginalIndexes.every((i) => selectedFiles![i])}
                            use:indeterminateAction={node.allOriginalIndexes.some((i) => selectedFiles![i]) && !node.allOriginalIndexes.every((i) => selectedFiles![i])}
                            onclick={(e) => { e.stopPropagation(); toggleFolderSelection(node.allOriginalIndexes); }}
                        />
                    {/if}
                    {#if treeOpenState.has(node.path)}
                        <svg class="folder-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                            <path d="M2 10h20"></path>
                        </svg>
                    {:else}
                        <svg class="folder-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                        </svg>
                    {/if}
                    <span class="file-name" style="font-weight: bold;">{node.name}</span>
                    <span class="file-size text-muted">{fmt(node.size)}</span>
                    {#if mode === "sender" && onRemoveMultiple}
                        <button
                            class="btn-remove"
                            onclick={(e) => { e.stopPropagation(); onRemoveMultiple(node.allOriginalIndexes); }}
                            title="Remove entire folder"
                        >✕</button>
                    {/if}
                </div>
                {#if treeOpenState.has(node.path)}
                    {#each Object.values(node.children) as child}
                        {@render renderTreeNode(child, depth + 1)}
                    {/each}
                {/if}
            {:else}
                <div class="file-item">
                    {#if mode === "receiver" && selectedFiles && node.originalIndex !== undefined}
                        <input type="checkbox" bind:checked={selectedFiles[node.originalIndex]} />
                    {/if}
                    <svg class="file-icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
                        <polyline points="14 2 14 8 20 8"></polyline>
                    </svg>
                    <span class="file-name" title={node.path}>{node.name}</span>
                    <span class="file-size text-muted">{fmt(node.size)}</span>
                    {#if mode === "sender" && onRemoveMultiple}
                        <button
                            class="btn-remove"
                            onclick={(e) => { e.stopPropagation(); onRemoveMultiple(node.allOriginalIndexes); }}
                            title="Remove file"
                        >✕</button>
                    {/if}
                </div>
            {/if}
        </div>
    {/snippet}

    <div class="selected-files-list">
        <div style="min-width: max-content;">
            {#each Object.values(fileTree.children) as rootChild}
                {@render renderTreeNode(rootChild, 0)}
            {/each}
        </div>
    </div>
{:else}
    <!-- List View -->
    <div class="selected-files-list">
        {#each filteredFiles.slice(currentPage * 100, (currentPage + 1) * 100) as fileMeta}
            <div class="file-item">
                {#if mode === "receiver" && selectedFiles}
                    <label class="file-label" style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                        <input type="checkbox" bind:checked={selectedFiles[fileMeta.originalIndex]} />
                        <svg class="file-icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                        </svg>
                        <span class="file-name" title={fileMeta.path}>{fileMeta.path}</span>
                    </label>
                {:else}
                    <div style="display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0;">
                        <svg class="file-icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                        </svg>
                        <span class="file-name" title={fileMeta.path}>{fileMeta.path}</span>
                    </div>
                {/if}
                <span class="file-size text-muted">{fmt(fileMeta.size)}</span>
                {#if mode === "sender" && onRemoveFile}
                    <button
                        class="btn-remove"
                        onclick={(e) => { e.stopPropagation(); onRemoveFile(fileMeta.originalIndex); }}
                        title="Remove file"
                    >✕</button>
                {/if}
            </div>
        {/each}
        {#if filteredFiles.length === 0}
            <div class="text-center text-muted" style="padding: 2rem 0;">
                No files match your search.
            </div>
        {/if}
        {#if filteredFiles.length > 100}
            <div class="pagination">
                <button
                    class="btn-page"
                    disabled={currentPage === 0}
                    onclick={(e) => { e.stopPropagation(); currentPage--; }}
                >&lt;</button>
                <span class="page-info">Page {currentPage + 1} of {Math.ceil(filteredFiles.length / 100)}</span>
                <button
                    class="btn-page"
                    disabled={(currentPage + 1) * 100 >= filteredFiles.length}
                    onclick={(e) => { e.stopPropagation(); currentPage++; }}
                >&gt;</button>
            </div>
        {/if}
    </div>
{/if}

<style>
    .list-toolbar {
        display: flex;
        gap: 0.5rem;
        margin: 1.5rem auto 0.5rem;
        width: 100%;
        align-items: center;
    }
    
    @media (max-width: 600px) {
        .list-toolbar {
            flex-direction: column !important;
            gap: 0.5rem !important;
        }
        .view-toggle {
            width: 100% !important;
            display: flex !important;
        }
        .view-toggle button {
            flex: 1 !important;
        }
        .search-input {
            width: 100% !important;
        }
        .sort-select {
            width: 100% !important;
        }
    }

    .search-input {
        flex: 1;
        background: var(--bg-color);
        box-shadow: var(--shadow-in);
        border: var(--panel-border);
        color: var(--text-primary);
        padding: 0.5rem 1rem;
        border-radius: 12px;
        font-family: var(--font-sans);
        transition: all 0.3s ease;
        outline: none;
    }
    
    .search-input:focus {
        border-color: var(--purple);
    }

    .sort-select {
        background: var(--bg-color);
        box-shadow: var(--shadow-in);
        border: var(--panel-border);
        color: var(--text-primary);
        padding: 0.5rem;
        border-radius: 12px;
        font-family: var(--font-sans);
        cursor: pointer;
        outline: none;
        transition: all 0.3s ease;
    }
    
    .sort-select:focus {
        border-color: var(--purple);
    }

    .sort-select option {
        background: var(--bg-color);
        color: var(--text-primary);
    }

    .btn-clear-all {
        background: var(--bg-color);
        box-shadow: var(--shadow-out);
        border: var(--panel-border);
        color: var(--color-error);
        padding: 0.5rem;
        border-radius: 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    
    .btn-clear-all:hover {
        box-shadow: var(--shadow-btn-hover);
        transform: translateY(-1px);
        color: #ef4444;
    }
    
    .btn-clear-all:active {
        box-shadow: var(--shadow-in);
        transform: translateY(1px);
    }

    .selected-files-list {
        margin: 0 auto 0;
        max-height: 50vh;
        overflow-y: auto;
        overflow-x: auto;
        background: var(--bg-color);
        box-shadow: var(--shadow-in);
        border: var(--panel-border);
        border-radius: 16px;
        padding: 0.75rem;
        width: 100%;
        text-align: left;
        scrollbar-width: thin;
        scrollbar-color: rgba(139, 92, 246, 0.4) transparent;
        transition: all 0.3s ease;
    }
    
    .selected-files-list::-webkit-scrollbar {
        width: 6px;
        height: 6px;
    }
    .selected-files-list::-webkit-scrollbar-track {
        background: transparent;
    }
    .selected-files-list::-webkit-scrollbar-thumb {
        background-color: var(--bg-color);
        box-shadow: var(--scroll-thumb-shadow);
        border-radius: 3px;
    }

    .folder-icon-svg {
        color: var(--purple);
        fill: rgba(139, 92, 246, 0.12);
        flex-shrink: 0;
        margin-right: 0.5rem;
    }
    
    .file-icon-svg {
        color: var(--blue);
        fill: rgba(59, 130, 246, 0.16);
        flex-shrink: 0;
        margin-right: 0.5rem;
        transition: all 0.3s ease;
    }

    .file-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.5rem 0.75rem;
        gap: 0.5rem;
        border-bottom: 1px solid var(--border-highlight);
        font-size: 0.85rem;
        max-width: 100%;
        overflow: hidden;
        border-radius: 8px;
        transition: background-color 0.2s ease;
    }
    
    .file-item:hover {
        background-color: rgba(139, 92, 246, 0.05);
    }
    
    .file-item:last-child {
        border-bottom: none;
    }

    .file-label {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex: 1;
        cursor: pointer;
        overflow: hidden;
    }

    .file-label input[type="checkbox"],
    .file-item input[type="checkbox"] {
        accent-color: var(--purple);
        cursor: pointer;
        width: 18px;
        height: 18px;
        flex-shrink: 0;
    }

    .file-name {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        min-width: 0;
        font-size: 0.85rem;
        color: var(--text-primary);
    }

    .file-size {
        font-size: 0.75rem;
        color: var(--text-secondary);
        min-width: 70px;
        text-align: right;
        white-space: nowrap;
    }

    .text-muted {
        color: var(--text-secondary);
    }
    
    .text-center {
        text-align: center;
    }

    .btn-remove {
        background: none;
        border: none;
        color: var(--color-error);
        cursor: pointer;
        font-size: 0.9rem;
        padding: 0.2rem 0.4rem;
        opacity: 0.6;
        transition: opacity 0.15s, transform 0.15s;
    }
    
    .btn-remove:hover {
        opacity: 1;
        transform: scale(1.1);
    }

    .pagination {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        margin-top: 0.75rem;
        padding: 0.5rem 0;
    }
    
    .page-info {
        font-size: 0.8rem;
        color: var(--text-secondary);
    }

    .btn-page {
        padding: 0.4rem 1rem;
        background: var(--bg-color);
        box-shadow: var(--shadow-out);
        border: var(--panel-border);
        color: var(--text-primary);
        border-radius: 12px;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        font-family: var(--font-sans);
        font-size: 0.8rem;
        font-weight: 500;
    }
    
    .btn-page:hover:not(:disabled) {
        box-shadow: var(--shadow-btn-hover);
        transform: translateY(-1px);
    }
    
    .btn-page:active:not(:disabled) {
        box-shadow: var(--shadow-in);
        transform: translateY(1px);
    }
    
    .btn-page.active-toggle {
        box-shadow: var(--shadow-in);
        color: var(--purple);
        font-weight: 700;
    }
    
    .btn-page:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
</style>
