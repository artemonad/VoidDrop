<script lang="ts">
    import type { TransferState } from "$lib/transfer/transferState.svelte";
    import QrCode from "./QrCode.svelte";
    import TransferDashboard from "./TransferDashboard.svelte";
    import { i18n } from "$lib/i18n.svelte";

    let {
        s
    }: {
        s: TransferState;
    } = $props();

    function fmt(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`;
        return `${(bytes / 1073741824).toFixed(2)} GB`;
    }

    let total = $derived(s.totalSelectionSize);
    let actualTransferred = $derived(
        s.useReceiverProgress ? s.receiverReportedProgress : Math.min(Math.max(0, s.bytesTransferred - s.senderBuffered), total)
    );
    let percent = $derived(total > 0 ? Math.min((actualTransferred / total) * 100, 100) : 0);
</script>

<div class="active-transfer-panel">
    {#if s.flowState === "HANDSHAKE"}
        {#if s.p2pLink}
            <div class="status-box status-waiting">
                <p class="status-title">{i18n.t('waitingReceiver')}</p>
                <p class="status-desc text-muted">{i18n.t('shareDesc')}</p>
                <div class="input-group" style="box-shadow: var(--shadow-in); border-radius: 16px; margin-bottom: 1.5rem;">
                    <input
                        type="text"
                        class="link-display"
                        readonly
                        value={s.p2pLink}
                        style="font-family: monospace; font-size: 0.8rem;"
                        onclick={(e) => e.currentTarget.select()}
                    />
                    <button class="btn-open" onclick={async () => {
                        try {
                            await navigator.clipboard.writeText(s.p2pLink);
                            s.showToast(i18n.t('toastCopied'));
                        } catch (err) {
                            s.log(`Clipboard error: ${err}`);
                            s.showToast(i18n.t('toastCopyFailed'));
                        }
                    }}>
                        Copy
                    </button>
                </div>
                <QrCode text={s.p2pLink} />
                <button
                    class="btn btn-reset"
                    onclick={() => s.resetToHome()}
                    style="width: 100%; margin-top: 1.5rem;"
                >{i18n.t('cancelSession')}</button>
            </div>
        {:else}
            <div class="status-box status-active">
                <div class="connecting-loader">
                    <div class="radar-ping"></div>
                    <svg
                        width="32"
                        height="32"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--purple)"
                        stroke-width="2.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        class="connecting-icon animate-pulse"
                    >
                        <circle cx="12" cy="12" r="2" />
                        <path d="M16.24 7.76a6 6 0 0 1 0 8.49" />
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                        <path d="M7.76 16.24a6 6 0 0 1 0-8.49" />
                        <path d="M4.93 19.07a10 10 0 0 1 0-14.14" />
                    </svg>
                </div>
                <p class="status-title" style="margin-top: 1rem;">{i18n.t('connectingPeer')}</p>
                <p class="status-desc text-muted">{i18n.t('establishingHandshake')}</p>
                <button
                    class="btn btn-reset"
                    onclick={() => s.resetToHome()}
                    style="width: 100%; margin-top: 1.5rem;"
                >{i18n.t('cancel')}</button>
            </div>
        {/if}

    {:else if s.flowState === "MANIFEST"}
        <div class="status-box status-active">
            <p class="status-title">{i18n.t('peerConnected')}</p>
            <p class="status-desc text-muted">{i18n.t('sendingManifest')}</p>
            <button
                class="btn btn-reset"
                onclick={() => s.resetToHome()}
                style="width: 100%; margin-top: 1rem;"
            >{i18n.t('cancel')}</button>
        </div>

    {:else if s.flowState === "STREAMING"}
        <div class="status-box status-active">
            <p class="status-title" style="color: var(--color-success); font-weight: 700;">
                {i18n.t('streamingSecurely')}
            </p>
            
            {#if total > 0}
                <div class="progress-bar-container">
                    <div class="progress-bar" style="width: {percent}%"></div>
                </div>
                <p class="progress-text">
                    {fmt(actualTransferred)} / {fmt(total)}
                    ({percent.toFixed(1)}%)
                </p>
            {/if}

            <div class="current-transfer-info">
                <p>Uploading payload in real-time...</p>
            </div>

            <button
                class="btn btn-reset"
                onclick={() => s.resetToHome()}
                style="width: 100%; margin-top: 1.5rem;"
            >{i18n.t('cancelTransfer')}</button>
        </div>

    {:else if s.flowState === "DONE"}
        <div class="status-box status-done">
            <p class="status-title" style="color: var(--color-success);">
                {i18n.t('transferComplete')}
            </p>
            <p class="status-desc text-muted">{i18n.t('allFilesVerified')}</p>
            <button
                class="btn btn-reset"
                onclick={() => s.resetToHome()}
                style="width: 100%; margin-top: 1rem;"
            >{i18n.t('sendAnother')}</button>
        </div>

    {:else if s.flowState === "ERROR"}
        <div class="status-box status-error">
            <p class="status-title" style="color: var(--color-error);">{i18n.t('transferError')}</p>
            <p class="status-desc text-muted">{i18n.t('tunnelDisconnected')}</p>
            <button
                class="btn btn-reset"
                onclick={() => s.resetToHome()}
                style="width: 100%; margin-top: 1.5rem;"
            >{i18n.t('goHome')}</button>
        </div>
    {/if}
</div>

{#if s.flowState === "STREAMING" || s.flowState === "HANDSHAKE" || s.flowState === "MANIFEST"}
    <TransferDashboard {s} />
{/if}

<style>
    .active-transfer-panel {
        width: 100%;
    }
    .status-box {
        padding: 2rem;
        border-radius: 20px;
        background: var(--bg-color);
        box-shadow: var(--shadow-out);
        border: 1px solid var(--border-highlight);
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
    }
    .status-title {
        font-size: 1.25rem;
        font-weight: 600;
        margin: 0 0 0.5rem;
        color: var(--text-primary);
    }
    .status-desc {
        font-size: 0.9rem;
        margin: 0 0 1.5rem;
    }
    .text-muted {
        color: var(--text-secondary);
    }
    .input-group {
        display: flex;
        width: 100%;
        gap: 0.5rem;
        padding: 0.5rem;
        background: var(--bg-color);
        box-shadow: var(--shadow-in);
        border-radius: 12px;
        box-sizing: border-box;
    }
    .link-display {
        flex: 1;
        background: transparent;
        border: none;
        outline: none;
        color: var(--text-primary);
        padding: 0.5rem;
    }
    .btn-open {
        padding: 0.5rem 1rem;
        background: var(--bg-color);
        box-shadow: var(--shadow-out);
        border: none;
        border-radius: 8px;
        color: var(--purple);
        font-weight: bold;
        cursor: pointer;
    }
    .btn-open:hover {
        box-shadow: var(--shadow-btn-hover);
    }
    .btn-open:active {
        box-shadow: var(--shadow-in);
    }
    .connecting-loader {
        position: relative;
        width: 64px;
        height: 64px;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .radar-ping {
        position: absolute;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        background: rgba(167, 139, 250, 0.15);
        animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;
    }
    @keyframes ping {
        75%, 100% {
            transform: scale(2);
            opacity: 0;
        }
    }
    .connecting-icon {
        color: var(--purple);
    }
    .animate-pulse {
        animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
    @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: .5; }
    }
    .progress-bar-container {
        width: 100%;
        height: 12px;
        background: var(--bg-color);
        box-shadow: var(--shadow-in);
        border-radius: 6px;
        overflow: hidden;
        margin-bottom: 0.5rem;
    }
    .progress-bar {
        height: 100%;
        background: linear-gradient(90deg, var(--purple), var(--blue));
        border-radius: 6px;
    }
    .progress-text {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text-secondary);
        margin: 0 0 1.5rem;
    }
    .current-transfer-info {
        background: var(--bg-color);
        box-shadow: var(--shadow-in);
        border-radius: 12px;
        padding: 1rem;
        width: 100%;
        height: 90px;
        box-sizing: border-box;
        font-size: 0.85rem;
        color: var(--text-secondary);
        margin-bottom: 1.5rem;
        display: flex;
        flex-direction: column;
        justify-content: center;
        overflow-y: auto;
    }
    .current-transfer-info p {
        margin: 0;
    }
    .btn {
        padding: 0.8rem 1.5rem;
        border-radius: 12px;
        font-weight: 700;
        cursor: pointer;
        transition: all 0.2s;
        border: none;
    }
    .btn-reset {
        background: var(--bg-color);
        box-shadow: var(--shadow-out);
        color: var(--text-secondary);
    }
    .btn-reset:hover {
        box-shadow: var(--shadow-btn-hover);
        color: var(--text-primary);
    }
    .btn-reset:active {
        box-shadow: var(--shadow-in);
    }
</style>
