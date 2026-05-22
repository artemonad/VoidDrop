<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import type { TransferState } from '$lib/transfer/transferState.svelte';

    let { s }: { s: TransferState } = $props();

    // Track transfer metrics locally for speed calculations
    let lastBytes = 0;
    let lastTime = performance.now();
    let currentSpeedBps = $state(0);
    
    // 30 seconds window for historical data
    let speedHistory: number[] = $state([]);

    // Helper: format speed elegantly
    function formatSpeed(bps: number): string {
        if (bps <= 0) return '0 B/s';
        if (bps < 1024) return `${bps.toFixed(0)} B/s`;
        if (bps < 1048576) return `${(bps / 1024).toFixed(1)} KB/s`;
        if (bps < 1073741824) return `${(bps / 1048576).toFixed(1)} MB/s`;
        return `${(bps / 1073741824).toFixed(1)} GB/s`;
    }

    // Helper: format bytes
    function fmtBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
        if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
        return `${(bytes / 1073741824).toFixed(1)} GB`;
    }

    // Helper: Get connection path status
    function getConnectionPath(type: string): string {
        switch(type) {
            case 'local': return 'DIRECT LAN CONNECTION';
            case 'p2p': return 'SECURE P2P LINK';
            case 'relay': return 'RELAY PATH (TURN)';
            default: return 'SECURING CONNECTION...';
        }
    }

    // Polling thread for speed history
    let speedPollInterval: ReturnType<typeof setInterval>;

    onMount(() => {
        lastBytes = s.bytesTransferred;
        lastTime = performance.now();
        
        speedPollInterval = setInterval(() => {
            if (s.flowState !== 'STREAMING') {
                currentSpeedBps = 0;
                return;
            }
            const now = performance.now();
            const elapsed = (now - lastTime) / 1000;
            if (elapsed <= 0) return;

            const deltaBytes = Math.max(0, s.bytesTransferred - lastBytes);
            currentSpeedBps = deltaBytes / elapsed;
            
            lastBytes = s.bytesTransferred;
            lastTime = now;

            // Push to local history (limit to 30 data points)
            speedHistory.push(currentSpeedBps);
            if (speedHistory.length > 30) {
                speedHistory.shift();
            }
            s.speedHistory = [...speedHistory];
        }, 1000);
    });

    onDestroy(() => {
        clearInterval(speedPollInterval);
    });

    // Height of the sparkline
    const graphHeight = 80;

    // Reactive calculations for the SVG sparkline
    let sparklineD = $derived.by(() => {
        if (speedHistory.length < 2) return '';
        const width = 500;
        const maxVal = Math.max(...speedHistory, 1024 * 1024); // at least 1MB/s ceiling
        
        const points = speedHistory.map((speed, i) => {
            const x = (i / (speedHistory.length - 1)) * width;
            const ratio = speed / maxVal;
            const y = graphHeight - (ratio * (graphHeight - 16)) - 8;
            return { x, y };
        });

        // Generate smooth cubic bezier line path
        let path = `M ${points[0].x} ${points[0].y}`;
        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[i];
            const p1 = points[i + 1];
            const cpX1 = p0.x + (p1.x - p0.x) / 2;
            const cpY1 = p0.y;
            const cpX2 = p0.x + (p1.x - p0.x) / 2;
            const cpY2 = p1.y;
            path += ` C ${cpX1} ${cpY1}, ${cpX2} ${cpY2}, ${p1.x} ${p1.y}`;
        }
        return path;
    });

    let fillD = $derived.by(() => {
        const linePath = sparklineD;
        if (!linePath || speedHistory.length < 2) return '';
        const width = 500;
        return `${linePath} L ${width} ${graphHeight} L 0 ${graphHeight} Z`;
    });

    // Reactive calculation for the last data point coordinate (for the live pulse indicator)
    let lastPoint = $derived.by(() => {
        if (speedHistory.length < 2) return { x: 0, y: 0 };
        const width = 500;
        const maxVal = Math.max(...speedHistory, 1024 * 1024);
        const lastIdx = speedHistory.length - 1;
        const x = width;
        const ratio = speedHistory[lastIdx] / maxVal;
        const y = graphHeight - (ratio * (graphHeight - 16)) - 8;
        return { x, y };
    });
</script>

<div class="metrics-container glass-card">
    <!-- Sophisticated badging system -->
    <div class="meta-section">
        <div class="status-indicator">
            <span class="pulse-dot" 
                  class:local={s.connectionType === 'local'} 
                  class:p2p={s.connectionType === 'p2p'} 
                  class:relay={s.connectionType === 'relay'}>
            </span>
            <span class="path-label">
                {getConnectionPath(s.connectionType)}
            </span>
        </div>

        <div class="badge-group">
            {#if s.pingMs >= 0}
                <div class="stat-badge">
                    <span class="badge-label">Latency</span>
                    <span class="badge-val" class:high-latency={s.pingMs > 100}>
                        {s.pingMs.toFixed(0)}<span class="unit">ms</span>
                    </span>
                </div>
            {:else}
                <div class="stat-badge">
                    <span class="badge-label">Link</span>
                    <span class="badge-val direct-badge">Direct</span>
                </div>
            {/if}
            <div class="stat-badge">
                <span class="badge-label">Block</span>
                <span class="badge-val">{fmtBytes(s.adaptiveChunkSize)}</span>
            </div>
            {#if s.isReconnecting}
                <div class="stat-badge warning-badge animate-pulse">
                    <span class="badge-label">Retry</span>
                    <span class="badge-val">Attempt {s.reconnectAttempts}</span>
                </div>
            {/if}
        </div>
    </div>

    <!-- Main display grid -->
    <div class="metrics-grid">
        <!-- Minimalist, high-contrast speed panel -->
        <div class="speed-panel">
            <span class="panel-subtitle">Current Rate</span>
            <div class="speed-readout">
                <span class="speed-number">{formatSpeed(currentSpeedBps).split(' ')[0]}</span>
                <span class="speed-unit">{formatSpeed(currentSpeedBps).split(' ')[1]}</span>
            </div>
            <span class="panel-desc">Secure Peer-to-Peer Stream</span>
        </div>

        <!-- Premium vector sparkline chart with grids and live telemetry -->
        <div class="chart-panel">
            <div class="chart-header">
                <span class="chart-title">Real-time Bandwidth Profile</span>
                {#if speedHistory.length > 0}
                    <span class="peak-label">Peak: {formatSpeed(Math.max(...speedHistory, 0))}</span>
                {/if}
            </div>
            
            <div class="chart-area">
                {#if speedHistory.length < 2}
                    <div class="graph-placeholder">
                        <div class="line-skeleton"></div>
                        <span class="placeholder-text">Calibrating direct stream telemetry...</span>
                    </div>
                {:else}
                    <div class="svg-wrapper">
                        <svg viewBox="0 0 500 80" preserveAspectRatio="none" class="vector-chart">
                            <defs>
                                <linearGradient id="chartFillGrad" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stop-color="var(--color-primary, #a78bfa)" stop-opacity="0.16" />
                                    <stop offset="100%" stop-color="var(--color-primary, #a78bfa)" stop-opacity="0.0" />
                                </linearGradient>
                            </defs>
                            
                            <!-- Premium dotted grid lines -->
                            <line x1="0" y1="20" x2="500" y2="20" stroke="rgba(255, 255, 255, 0.04)" stroke-dasharray="3,3" />
                            <line x1="0" y1="40" x2="500" y2="40" stroke="rgba(255, 255, 255, 0.04)" stroke-dasharray="3,3" />
                            <line x1="0" y1="60" x2="500" y2="60" stroke="rgba(255, 255, 255, 0.04)" stroke-dasharray="3,3" />
                            
                            <!-- Shaded gradient fill -->
                            <path d={fillD} fill="url(#chartFillGrad)" />
                            
                            <!-- Clean primary stroke line -->
                            <path d={sparklineD} fill="none" stroke="var(--color-primary, #a78bfa)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            
                            <!-- Target indicator dots (solid core and glowing pulse ring) -->
                            <circle cx={lastPoint.x} cy={lastPoint.y} r="3.5" fill="var(--color-primary, #a78bfa)" />
                            <circle cx={lastPoint.x} cy={lastPoint.y} r="8.5" fill="var(--color-primary, #a78bfa)" fill-opacity="0.22" class="live-pulse" />
                        </svg>
                    </div>
                {/if}
            </div>
        </div>
    </div>
</div>

<style>
    .glass-card {
        padding: 1.5rem;
        background-color: var(--bg-color);
        border: var(--panel-border);
        border-radius: 20px;
        box-shadow: var(--shadow-out);
        margin: 1.5rem 0;
        position: relative;
        overflow: hidden;
        transition: all 0.4s ease;
    }

    .meta-section {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1.25rem;
        border-bottom: 1px solid var(--border-highlight);
        padding-bottom: 0.85rem;
        flex-wrap: wrap;
        gap: 0.85rem;
    }

    .status-indicator {
        display: flex;
        align-items: center;
        gap: 0.6rem;
    }

    .pulse-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.2);
        position: relative;
    }

    .pulse-dot.local {
        background: #10b981;
        box-shadow: 0 0 12px rgba(16, 185, 129, 0.5);
    }
    .pulse-dot.p2p {
        background: var(--blue);
        box-shadow: 0 0 12px var(--blue);
    }
    .pulse-dot.relay {
        background: #f59e0b;
        box-shadow: 0 0 12px rgba(245, 158, 11, 0.5);
    }

    .path-label {
        font-family: var(--font-sans);
        font-size: 0.7rem;
        font-weight: 700;
        color: var(--text-secondary);
        letter-spacing: 0.08em;
    }

    .badge-group {
        display: flex;
        gap: 0.6rem;
        flex-wrap: wrap;
    }

    .stat-badge {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.25rem 0.55rem;
        background-color: var(--bg-color);
        border: var(--panel-border);
        border-radius: 8px;
        box-shadow: var(--shadow-out);
    }

    .badge-label {
        font-size: 0.6rem;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: 600;
    }

    .badge-val {
        font-family: monospace;
        font-size: 0.72rem;
        font-weight: 600;
        color: var(--text-primary);
    }

    .badge-val .unit {
        color: var(--text-secondary);
        font-size: 0.65rem;
        margin-left: 1px;
    }

    .badge-val.direct-badge {
        color: #10b981;
    }

    .badge-val.high-latency {
        color: #f87171;
    }

    .warning-badge {
        background: rgba(245, 158, 11, 0.05);
        border-color: rgba(245, 158, 11, 0.15);
    }
    .warning-badge .badge-val {
        color: #fcd34d;
    }

    .metrics-grid {
        display: grid;
        grid-template-columns: 180px 1fr;
        gap: 2rem;
        align-items: center;
    }

    .speed-panel {
        display: flex;
        flex-direction: column;
        justify-content: center;
        height: 80px;
        border-right: 1px solid var(--border-highlight);
        padding-right: 1rem;
    }

    .panel-subtitle {
        font-size: 0.62rem;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-weight: 700;
        margin-bottom: 2px;
    }

    .speed-readout {
        display: flex;
        align-items: baseline;
        gap: 0.25rem;
    }

    .speed-number {
        font-family: monospace;
        font-size: 2.25rem;
        font-weight: 500;
        color: var(--text-primary);
        letter-spacing: -0.05em;
        line-height: 1.1;
    }

    .speed-unit {
        font-family: var(--font-sans);
        font-size: 0.85rem;
        font-weight: 700;
        color: var(--purple);
        letter-spacing: -0.01em;
    }

    .panel-desc {
        font-size: 0.62rem;
        color: var(--text-secondary);
        letter-spacing: 0.02em;
        margin-top: 4px;
    }

    .chart-panel {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        background-color: var(--bg-color);
        box-shadow: var(--shadow-in);
        border: var(--panel-border);
        border-radius: 14px;
        padding: 0.75rem 1rem;
    }

    .chart-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 0.65rem;
        flex-wrap: wrap;
        gap: 0.5rem;
    }

    .chart-title {
        color: var(--text-secondary);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .peak-label {
        font-family: monospace;
        color: var(--text-primary);
        font-weight: 600;
        background-color: var(--bg-color);
        padding: 0.1rem 0.4rem;
        border-radius: 4px;
        border: var(--panel-border);
        box-shadow: var(--shadow-out);
    }

    .chart-area {
        height: 80px;
        display: flex;
        align-items: flex-end;
        position: relative;
    }

    .svg-wrapper {
        width: 100%;
        height: 100%;
        position: relative;
    }

    .vector-chart {
        width: 100%;
        height: 100%;
        overflow: visible;
    }

    .live-pulse {
        transform-origin: center;
        animation: pulseRadar 1.8s infinite cubic-bezier(0.1, 0.8, 0.3, 1);
    }

    @keyframes pulseRadar {
        0% { r: 3.5; opacity: 0.8; }
        100% { r: 18; opacity: 0.0; }
    }

    .graph-placeholder {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        gap: 0.5rem;
    }

    .placeholder-text {
        font-size: 0.65rem;
        color: var(--text-secondary);
        font-weight: 500;
        letter-spacing: 0.02em;
    }

    .line-skeleton {
        height: 1.5px;
        width: 80%;
        background: linear-gradient(90deg, var(--border-highlight) 0%, var(--text-secondary) 50%, var(--border-highlight) 100%);
        background-size: 200% 100%;
        animation: loadingShimmer 2s infinite linear;
        border-radius: 1px;
    }

    @keyframes loadingShimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
    }

    @media (max-width: 640px) {
        .metrics-grid {
            grid-template-columns: 1fr;
            gap: 1.25rem;
        }
        .speed-panel {
            border-right: none;
            border-bottom: 1px solid var(--border-highlight);
            padding-right: 0;
            padding-bottom: 0.75rem;
            height: auto;
        }
        .meta-section {
            flex-direction: column;
            align-items: flex-start;
        }
        .badge-group {
            width: 100%;
            justify-content: space-between;
        }
    }
</style>
