import { browser } from '$app/environment';

export type Locale = 'en';

export const dictionaries = {
    en: {
        title: "Direct, serverless file streaming",
        tag: "Zero Knowledge",
        desc: "Direct, secure P2P transfers between devices. Zero-knowledge end-to-end encryption (XChaCha20-Poly1305 + ML-KEM) is performed entirely in your browser. Your files stream directly to the recipient and never touch any servers.",
        selectFiles: "Select Files",
        selectFolder: "Select Folder",
        receiveStream: "Receive Stream",
        pastePlaceholder: "Paste link or code here...",
        open: "Open",
        waitingReceiver: "Waiting for receiver...",
        shareDesc: "Share this direct encrypted link with the receiver:",
        cancelSession: "Cancel Session",
        cancel: "Cancel",
        connectingPeer: "Connecting Peer...",
        establishingHandshake: "Establishing secure, direct WebRTC handshake...",
        peerConnected: "Peer Connected",
        sendingManifest: "Sending cryptographic manifest...",
        receivingStream: "Receiving Encrypted Stream...",
        streamingSecurely: "Streaming Files Securely...",
        saving: "Saving",
        fileOf: "File {index} of {total}",
        cancelTransfer: "Cancel Transfer",
        transferComplete: "Transfer Complete!",
        allFilesVerified: "All files verified and saved securely.",
        sendAnother: "Send Another",
        transferError: "Transfer Error",
        tunnelDisconnected: "Direct tunnel disconnected or session terminated.",
        goHome: "Go Home",
        bundleReady: "Bundle Ready!",
        scanning: "Scanning files...",
        pleaseWaitScan: "Please wait while we process the directory tree.",
        specification: "Specification",
        loadingEngine: "Loading Engine...",
        createSession: "Create P2P Session",
        files: "files",
        toastCopied: "Link copied!",
        toastCopyFailed: "Failed to copy. Please copy manually."
    }
};

class I18nManager {
    currentLocale = $state<Locale>('en');

    constructor() {
        this.currentLocale = 'en';
    }

    setLocale(locale: Locale) {
        this.currentLocale = 'en';
    }

    t(key: keyof typeof dictionaries['en'], params?: Record<string, string | number>): string {
        const dict = dictionaries['en'];
        let text = dict[key] || String(key);
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                text = text.replace(`{${k}}`, String(v));
            }
        }
        return text;
    }
}

export const i18n = new I18nManager();
