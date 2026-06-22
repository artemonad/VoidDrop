<script lang="ts">
    /**
     * ConnectionLog — Displays transfer logs and progress bar.
     */
    import { tick } from "svelte";
    import type { TransferState } from "$lib/transfer";

    interface Props {
        state: TransferState;
    }

    let { state: s }: Props = $props();
    let scrollEl = $state<HTMLDivElement | undefined>(undefined);
    let isCollapsed = $state(true);

    $effect(() => {
        if (s.connectionLogs.length && scrollEl && !isCollapsed) {
            tick().then(() => {
                if (scrollEl) {
                    scrollEl.scrollTop = scrollEl.scrollHeight;
                    setTimeout(() => {
                        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
                    }, 0);
                }
            });
        }
    });

    function formatLog(line: string) {
        if (!line) return "";
        
        // Escapes HTML tags to prevent XSS
        let safeLine = line
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
            
        // Tokenize using word boundaries, capturing the words
        const tokens = safeLine.split(/(\b\w+\b)/g);
        
        // Match lists
        const techTerms = /^(WebRTC|WebSocket|PeerConnection|DataChannel|ICE|TURN|STUN|Signaling|Proxy|Relay|Host|SRFLX|Server|WS|P2P|Manifest|Channel|Socket|Route)$/i;
        const successTerms = /^(connected|open|success|successfully|established|completed|complete|done|active|verified|trusted)$/i;
        const errorTerms = /^(disconnected|failed|error|closed|broken|invalid|denied)$/i;
        const warnTerms = /^(negotiating|connecting|pending|gathering|restart|retrying|reconnecting)$/i;
        
        return tokens.map(token => {
            if (techTerms.test(token)) {
                return `<span class="token-tech">${token}</span>`;
            } else if (successTerms.test(token)) {
                return `<span class="token-success">${token}</span>`;
            } else if (errorTerms.test(token)) {
                return `<span class="token-error">${token}</span>`;
            } else if (warnTerms.test(token)) {
                return `<span class="token-warn">${token}</span>`;
            }
            return token;
        }).join("");
    }
</script>

{#if s.flowState !== "IDLE" && s.connectionLogs.length > 0}
    <div class="logs-panel glass-panel {isCollapsed ? 'collapsed' : ''}">
        <div 
            class="logs-header" 
            onclick={() => isCollapsed = !isCollapsed} 
            role="button" 
            tabindex="0" 
            onkeydown={(e) => e.key === 'Enter' && (isCollapsed = !isCollapsed)}
        >
            <div class="header-left">
                <span class="status-dot pulsing"></span>
                <h4>Connection Trace</h4>
            </div>
            <div class="header-right">
                {#if s.peerRole}
                    <span class="role-badge">{s.peerRole}</span>
                {:else}
                    <span class="role-badge warning">Negotiating</span>
                {/if}
                <span class="chevron-icon {isCollapsed ? 'collapsed' : ''}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </span>
            </div>
        </div>

        <div class="logs-scroll {isCollapsed ? 'collapsed' : ''}" bind:this={scrollEl}>
            {#each s.connectionLogs as logLine}
                <div class="log-line">
                    <span class="log-prompt">&gt;</span>
                    <span class="log-content">{@html formatLog(logLine)}</span>
                </div>
            {/each}
        </div>
    </div>
{/if}

<style>
    .logs-panel {
        margin-top: 2rem;
        background: var(--bg-color);
        border: var(--panel-border);
        border-radius: 24px;
        padding: 1.25rem;
        box-shadow: var(--shadow-out);
        display: flex;
        flex-direction: column;
        gap: 1rem;
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.3s ease, gap 0.3s ease;
    }

    .logs-panel.collapsed {
        gap: 0;
    }

    .logs-panel:hover {
        transform: translateY(-2px);
        box-shadow: var(--shadow-btn-hover);
    }

    .logs-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0 0.25rem;
        cursor: pointer;
        user-select: none;
        outline: none;
    }

    .header-left {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .header-right {
        display: flex;
        align-items: center;
        gap: 0.75rem;
    }

    .chevron-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-secondary);
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .chevron-icon.collapsed {
        transform: rotate(-90deg);
    }

    .status-dot {
        width: 8px;
        height: 8px;
        background-color: var(--color-success);
        border-radius: 50%;
        display: inline-block;
        box-shadow: 0 0 8px var(--color-success);
    }

    .status-dot.pulsing {
        animation: pulse 2s infinite;
    }

    @keyframes pulse {
        0% {
            transform: scale(0.95);
            box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
        }
        70% {
            transform: scale(1);
            box-shadow: 0 0 0 6px rgba(16, 185, 129, 0);
        }
        100% {
            transform: scale(0.95);
            box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
        }
    }

    .logs-panel h4 {
        font-family: var(--font-display);
        font-size: 0.95rem;
        font-weight: 700;
        margin: 0;
        color: var(--text-primary);
        letter-spacing: 0.03em;
    }

    .role-badge {
        font-family: var(--font-sans);
        font-size: 0.7rem;
        font-weight: 600;
        text-transform: uppercase;
        padding: 4px 10px;
        background: var(--bg-color);
        box-shadow: var(--shadow-in);
        border-radius: 20px;
        color: var(--purple);
        letter-spacing: 0.05em;
        border: 1px solid rgba(255, 255, 255, 0.01);
    }

    .role-badge.warning {
        color: #f59e0b;
    }

    .logs-scroll {
        max-height: 220px;
        overflow-y: auto;
        font-family: "JetBrains Mono", "Fira Code", monospace;
        font-size: 0.75rem;
        color: var(--text-secondary);
        line-height: 1.6;
        background: rgba(0, 0, 0, 0.15);
        box-shadow: var(--shadow-in);
        border-radius: 16px;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 4px;
        border: 1px solid rgba(255, 255, 255, 0.01);
        transition: max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1), padding 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        opacity: 1;
    }

    .logs-scroll.collapsed {
        max-height: 0;
        padding-top: 0;
        padding-bottom: 0;
        opacity: 0;
        overflow: hidden;
        border-top-width: 0;
        border-bottom-width: 0;
        pointer-events: none;
    }

    :root.light .logs-scroll {
        background: rgba(0, 0, 0, 0.03);
        color: var(--text-primary);
    }

    /* Custom Webkit scrollbar for logs-scroll to match layout */
    .logs-scroll::-webkit-scrollbar {
        width: 6px;
    }
    .logs-scroll::-webkit-scrollbar-track {
        background: transparent;
        box-shadow: none;
    }
    .logs-scroll::-webkit-scrollbar-thumb {
        background: var(--bg-color);
        box-shadow: var(--scroll-thumb-shadow);
        border-radius: 3px;
    }

    .log-line {
        display: flex;
        gap: 0.5rem;
        padding: 4px 6px;
        border-radius: 6px;
        transition: background-color 0.2s ease;
        align-items: flex-start;
    }

    .log-line:hover {
        background-color: rgba(255, 255, 255, 0.02);
    }

    :root.light .log-line:hover {
        background-color: rgba(0, 0, 0, 0.02);
    }

    .log-prompt {
        color: var(--purple);
        opacity: 0.5;
        font-size: 0.75rem;
        user-select: none;
        flex-shrink: 0;
        margin-top: 1px;
    }

    .log-content {
        word-break: break-all;
        flex-grow: 1;
    }

    /* Custom tokens styling for log line parser */
    :global(.token-tech) {
        color: var(--blue);
        font-weight: 500;
    }

    :global(.token-success) {
        color: var(--color-success);
        font-weight: 500;
    }

    :global(.token-error) {
        color: var(--color-error);
        font-weight: 500;
    }

    :global(.token-warn) {
        color: #f59e0b;
        font-weight: 500;
    }
</style>
