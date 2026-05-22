<script lang="ts">
    import type { TransferState } from '$lib/transfer/transferState.svelte';

    let {
        s,
        onSelectFiles,
        onSelectFolder
    }: {
        s: TransferState;
        onSelectFiles: () => void;
        onSelectFolder: () => void;
    } = $props();
</script>

<aside class="sidebar-nav">
    <div class="nav-section">
        <span class="nav-title">VoidDrop Navigation</span>
        
        <button class="nav-item" class:active={s.flowState === 'IDLE'} onclick={s.resetToHome}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                <polyline points="9 22 9 12 15 12 15 22"></polyline>
            </svg>
            <span>Home Session</span>
        </button>

        {#if s.selectedFiles.length > 0}
            <button class="nav-item active">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
                <span>Active Files ({s.selectedFiles.length})</span>
            </button>
        {/if}
    </div>

    <div class="nav-section quick-actions">
        <span class="nav-title">Quick Actions</span>
        <button class="nav-action-btn" onclick={onSelectFiles}>
            Add Files
        </button>
        <button class="nav-action-btn" onclick={onSelectFolder}>
            Add Folder
        </button>
    </div>
</aside>

<style>
    .sidebar-nav {
        width: 200px;
        background: var(--bg-color);
        border-right: var(--panel-border);
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
        padding: 1rem;
        flex-shrink: 0;
        box-shadow: var(--shadow-out);
    }
    .nav-section {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }
    .nav-title {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
        font-weight: 700;
        margin-bottom: 0.25rem;
    }
    .nav-item {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.5rem 0.75rem;
        background: transparent;
        border: none;
        border-radius: 8px;
        color: var(--text-secondary);
        font-size: 0.82rem;
        cursor: pointer;
        text-align: left;
        transition: all 0.2s ease;
    }
    .nav-item:hover {
        background: var(--border-highlight);
        color: var(--text-primary);
    }
    .nav-item.active {
        background: var(--border-highlight);
        color: var(--purple);
        font-weight: 600;
        box-shadow: var(--shadow-in);
    }
    .quick-actions {
        margin-top: auto;
    }
    .nav-action-btn {
        padding: 0.45rem;
        font-size: 0.78rem;
        background: var(--bg-color);
        border: var(--panel-border);
        border-radius: 6px;
        color: var(--text-primary);
        box-shadow: var(--shadow-out);
        cursor: pointer;
        transition: all 0.15s;
    }
    .nav-action-btn:hover {
        color: var(--purple);
        box-shadow: var(--shadow-btn-hover);
    }
</style>
