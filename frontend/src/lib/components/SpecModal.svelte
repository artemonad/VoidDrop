<script lang="ts">
    import Logo from "./Logo.svelte";
    import { i18n } from "$lib/i18n.svelte";

    let {
        show = $bindable(false)
    }: {
        show: boolean;
    } = $props();
</script>

{#if show}
    <div class="spec-overlay">
        <div class="spec-header">
            <a href="/" class="logo" onclick={(e) => { e.preventDefault(); show = false; }}>
                <Logo size={24} />
                <span>VoidDrop Spec</span>
            </a>
            <button class="btn-spec-close" onclick={() => show = false} aria-label="Close specification">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
                <span>Close</span>
            </button>
        </div>
        
        <div class="spec-content">
            <div class="spec-title-row">
                <h2>Technical Specification</h2>
                <p>Zero-Knowledge Quantum-Resistant Peer-to-Peer Protocol</p>
            </div>
            
            <div class="spec-card">
                <h3>🔒 Quantum-Resistant Key Exchange</h3>
                <p>
                    A cryptographically secure pre-shared key (PSK) is generated locally using the cryptographically secure pseudorandom number generator (CSPRNG) inside the sender's browser sandbox environment.
                </p>
                <p>
                    To secure transmissions against future decrypt-now-harvest-later threats, the system performs post-quantum key encapsulation using **ML-KEM-768** (Kyber-768), achieving forward secrecy.
                </p>
            </div>

            <div class="spec-card">
                <h3>🔑 End-to-End Encryption (E2EE)</h3>
                <p>
                    All files are fragmented, compressed, and encrypted directly inside your browser before any data is sent over the network.
                </p>
                <ul>
                    <li><strong>Cipher Suite:</strong> XChaCha20-Poly1305 (256-bit key, 192-bit nonce) provides robust authenticated symmetric encryption.</li>
                    <li><strong>Zero-Knowledge:</strong> The decryption keys are encoded entirely in the URL hash fragment (<code>#</code>). Under RFC 3986, hash fragments are strictly client-side and never sent to our signaling servers.</li>
                </ul>
            </div>

            <div class="spec-card">
                <h3>⚡ Peer-to-Peer Data Channels</h3>
                <p>
                    VoidDrop coordinates direct P2P connections using standard **WebRTC DataChannels** with SCTP protocol layers.
                </p>
                <p>
                    An ephemeral, WebSocket-based signaling relay is used solely for initial NAT traversal negotiation (STUN/TURN). Once the direct handshake completes, the connection is purely peer-to-peer. Your files are streamed byte-by-byte from memory buffer to memory buffer, without touching any hard disk or cloud storage server.
                </p>
            </div>

            <div class="spec-card">
                <h3>🛡️ Integrity Verification</h3>
                <p>
                    To guarantee that the files are transferred without corruption or malicious tampering, each file chunk has its cryptographic checksum (SHA-256) evaluated in real-time. The receiver's browser reconstructs and verifies the full checksum profile against the original manifest before saving the payload.
                </p>
            </div>
        </div>
    </div>
{/if}

<style>
    .spec-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: var(--bg-color);
        z-index: 1000;
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        padding: 1.5rem;
        box-sizing: border-box;
        animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes slideUp {
        from { transform: translateY(100%); }
        to { transform: translateY(0); }
    }

    .spec-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
        max-width: 800px;
        margin: 0 auto 2rem;
    }

    .logo {
        font-family: var(--font-display);
        font-size: 1.4rem;
        font-weight: 700;
        text-decoration: none;
        color: var(--text-primary);
        display: flex;
        align-items: center;
        gap: 0.6rem;
    }

    .btn-spec-close {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.6rem 1.2rem;
        border-radius: 12px;
        background-color: var(--bg-color);
        border: none;
        box-shadow: var(--shadow-out);
        color: var(--text-secondary);
        font-weight: 600;
        font-size: 0.85rem;
        cursor: pointer;
        transition: all 0.3s ease;
        outline: none;
    }

    .btn-spec-close:hover {
        box-shadow: var(--shadow-in);
        color: var(--text-primary);
    }

    .spec-content {
        width: 100%;
        max-width: 800px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
        padding-bottom: 3rem;
    }

    .spec-title-row {
        text-align: center;
        margin-bottom: 1rem;
    }

    .spec-title-row h2 {
        font-size: 1.8rem;
        font-weight: 700;
        color: var(--text-primary);
        margin: 0 0 0.5rem;
    }

    .spec-title-row p {
        color: var(--text-secondary);
        font-size: 0.95rem;
        margin: 0;
    }

    .spec-card {
        background: var(--bg-color);
        box-shadow: var(--shadow-out);
        border-radius: 20px;
        padding: 2rem;
        border: 1px solid var(--border-highlight);
    }

    .spec-card h3 {
        margin-top: 0;
        font-size: 1.25rem;
        color: var(--text-primary);
        margin-bottom: 1rem;
    }

    .spec-card p {
        color: var(--text-secondary);
        line-height: 1.6;
        font-size: 0.92rem;
        margin: 0 0 1rem;
    }

    .spec-card p:last-child {
        margin-bottom: 0;
    }

    .spec-card ul {
        margin: 0;
        padding-left: 1.5rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .spec-card li {
        color: var(--text-secondary);
        font-size: 0.92rem;
        line-height: 1.5;
    }
</style>
