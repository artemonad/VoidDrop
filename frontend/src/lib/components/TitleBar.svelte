<script lang="ts">
    import ThemeToggle from './ThemeToggle.svelte';
    import Logo from './Logo.svelte';
    import type { TransferState } from '$lib/transfer/transferState.svelte';

    let {
        s,
        isLight,
        toggleTheme,
        handlePasteLink
    }: {
        s: TransferState;
        isLight: boolean;
        toggleTheme: () => void;
        handlePasteLink: () => void;
    } = $props();
</script>

<header class="app-header">
    <div class="app-brand">
        <Logo size={18} />
        <span class="brand-text">VoidDrop</span>
    </div>

    <div class="header-receive">
        <input
            type="text"
            bind:value={s.pasteLinkInput}
            placeholder="Paste VoidDrop link to receive..."
            class="header-link-input"
            onkeydown={(e) => e.key === 'Enter' && handlePasteLink()}
        />
        <button class="header-join-btn" onclick={handlePasteLink} disabled={!s.pasteLinkInput}>
            Join
        </button>
    </div>

    <ThemeToggle {isLight} {toggleTheme} />

    <div class="header-status">
        <span class="status-dot" class:status-ready={s.isWorkerReady} class:status-loading={!s.isWorkerReady}></span>
        <span class="status-text">{s.isWorkerReady ? 'Ready' : 'Loading...'}</span>
    </div>
</header>

<style>
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

    @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
    }
</style>
