<script lang="ts">
    /**
     * QrCode — Zero-knowledge, fully offline, client-side vector QR Code generator.
     */
    import qrcode from "qrcode-generator";

    interface Props {
        text: string;
    }

    let { text }: Props = $props();

    // Derivation logic using Svelte 5 $derived.by rune to dynamically compute the SVG
    let qrSvg = $derived.by(() => {
        if (!text) return "";
        try {
            // Type 0 = auto-detect optimal size, 'M' = Medium error correction (~15% recovery)
            const qr = qrcode(0, "M");
            qr.addData(text);
            qr.make();
            // Generate clean vector SVG with cell size 4px and margin of 2 cells
            return qr.createSvgTag(4, 2);
        } catch (e) {
            console.error("[VoidDrop] Offline QR Code Generation Error:", e);
            return "";
        }
    });
</script>

<div class="qr-container glass-panel">
    {#if qrSvg}
        <div class="qr-code">
            {@html qrSvg}
        </div>
    {:else}
        <div class="qr-placeholder">
            <div class="spinner"></div>
            <span>Generating Secure QR Code...</span>
        </div>
    {/if}
</div>

<style>
    .qr-container {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1.5rem;
        background: var(--bg-color);
        border: var(--panel-border);
        border-radius: 28px;
        max-width: 240px;
        width: 100%;
        margin: 1.5rem auto;
        box-shadow: var(--shadow-out);
        transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    
    .qr-container:hover {
        transform: translateY(-2px);
        box-shadow: var(--shadow-btn-hover);
    }

    .qr-code {
        width: 100%;
        height: auto;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    /* Target the dynamically injected SVG tag styling */
    :global(.qr-code svg) {
        width: 100% !important;
        height: auto !important;
        max-width: 190px !important;
        border-radius: 20px !important;
        background: #ffffff !important; /* Always white background for maximum contrast & camera scanning */
        padding: 1rem !important;
        box-shadow: var(--shadow-in) !important; /* Premium neumorphic well carving */
        border: var(--panel-border) !important;
        transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) !important;
        display: block !important;
    }

    /* Force the library-generated background rect to be white/transparent to avoid overlapping */
    :global(.qr-code svg rect:first-child) {
        fill: #ffffff !important;
    }

    :global(.qr-code svg path) {
        fill: #111827 !important; /* Dark charcoal color for high-contrast scanning */
        transition: fill 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
    }

    /* Elegant micro-interaction: transition modules to dark purple on hover */
    :global(.qr-container:hover .qr-code svg path) {
        fill: #6d28d9 !important; /* Hex for dark purple/indigo, ensuring contrast remains high */
    }
    
    .qr-placeholder {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
        font-size: 0.78rem;
        color: var(--text-secondary);
        text-align: center;
        padding: 1.5rem 0;
    }

    .spinner {
        width: 24px;
        height: 24px;
        border: 2px solid rgba(0, 0, 0, 0.05);
        border-top-color: var(--purple);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }

    :global(.light) .spinner {
        border: 2px solid rgba(0, 0, 0, 0.05);
        border-top-color: var(--purple);
    }

    @keyframes spin {
        to { transform: rotate(360deg); }
    }

</style>
