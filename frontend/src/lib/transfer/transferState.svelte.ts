/**
 * Transfer State — Central reactive store for the VoidDrop transfer engine.
 *
 * All shared mutable state lives here. Engines (sender, receiver, crypto orchestrator)
 * receive a reference to this object and mutate it directly.
 *
 * Uses Svelte 5 runes ($state) — must be in a .svelte.ts file.
 */

import type { WebRTCConnection } from "$lib/network/webrtc";
import type { FileWithMeta } from "$lib/fileTree";
import type { ContainerManifest } from "$lib/network/manifest";
import type { TauriDirHandle } from "$lib/tauriFs";

export type FlowState = "IDLE" | "HANDSHAKE" | "MANIFEST" | "STREAMING" | "DONE" | "ERROR";
export type PeerRole = "sender" | "receiver" | null;

export interface ReceiverWriteItem {
    data: Uint8Array;
    isFinal: boolean;
}

export interface SimpleStreamWriter {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
}

export class TransferState {
    // --- Core state ---
    worker = $state<Worker | undefined>(undefined);
    isWorkerReady = $state(false);
    webrtc = $state<WebRTCConnection | undefined>(undefined);
    peerRole = $state<PeerRole>(null);
    
    #flowState = $state<FlowState>("IDLE");
    get flowState() { return this.#flowState; }
    set flowState(v: FlowState) {
        this.#flowState = v;
        if (v === "ERROR" || v === "DONE" || v === "IDLE") {
            if (this.fileStreamWriter) {
                try {
                    const p = this.fileStreamWriter.close();
                    if (p && typeof p.catch === 'function') {
                        p.catch((err: any) => console.warn("Async close error on flowState change:", err));
                    }
                } catch (closeErr) {
                    console.warn("Sync close error on flowState change:", closeErr);
                }
                this.fileStreamWriter = null;
            }
        }
    }
    
    connectionType = $state<"local" | "p2p" | "relay" | "unknown">("unknown");

    // --- File selection ---
    selectedFiles = $state<FileWithMeta[]>([]);
    totalSelectionSize = $state(0);
    isScanningFiles = $state(false);

    // --- Transfer progress ---
    #bytesTransferred = $state(0);
    get bytesTransferred() { return this.#bytesTransferred; }
    set bytesTransferred(v: number) {
        this.#bytesTransferred = v;
        this.rawBytesTransferred = v;
    }
    rawBytesTransferred = 0;
    
    lastProgressUpdate = 0;
    senderBuffered = $state(0);
    useReceiverProgress = $state(false);
    receiverReportedProgress = $state(0);
    useZipFallback = $state(false);
    receiverSaveLocationName = $state("");

    updateProgress(bytes: number, force = false) {
        this.rawBytesTransferred = bytes;
        const now = performance.now();
        if (force || now - this.lastProgressUpdate >= 100) { // Limit reactive updates to 10Hz (every 100ms)
            this.bytesTransferred = bytes;
            this.lastProgressUpdate = now;
        }
    }

    // --- Crypto ---
    psk = $state<Uint8Array>(new Uint8Array(0));
    
    // --- Analytics & Auto-Resume & Adaptive Chunks ---
    pingMs = $state<number>(-1);
    speedHistory = $state<number[]>([]);
    reconnectAttempts = $state<number>(0);
    isReconnecting = $state<boolean>(false);
    adaptiveChunkSize = $state<number>(128 * 1024); // Dynamically adjusted (64KB to 512KB)
    receiverChunksProcessed = $state<number>(0);

    // --- Sender state ---
    fileOffset = $state(0);
    currentFileIndex = $state(0);
    pendingWorkerChunks = $state(0);
    senderReadingInProgress = $state(false);

    // --- P2P link ---
    p2pLink = $state("");

    // --- Receiver state ---
    receiverManifest = $state<ContainerManifest | null>(null);
    receiverFileTotalSize = $state(0);
    receiverFileIndex = $state(0);
    receiverFileBytesWritten = $state(0);
    receiverDirHandle = $state<FileSystemDirectoryHandle | TauriDirHandle | null>(null);
    fileStreamWriter = $state<WritableStreamDefaultWriter | SimpleStreamWriter | null>(null);
    p2pSelectedFiles = $state<boolean[]>([]);
    fallbackBundleFiles = $state<{ path: string; chunks: Uint8Array[] }[]>([]);
    fallbackChunks = $state<Uint8Array[]>([]);
    skipCurrentFileWrite = $state(false);
    lastProgressSent = $state(0);

    // --- Receiver write queue (decouples decryption from file I/O) ---
    receiverWriteQueue = $state<ReceiverWriteItem[]>([]);
    receiverWriteInProgress = $state(false);

    // --- UI state ---
    connectionLogs = $state<string[]>([]);
    searchQuery = $state("");
    sortMode = $state("name_asc");
    viewMode = $state<"list" | "tree">("list");
    treeOpenState = $state(new Set<string>());
    currentPage = $state(0);
    pasteLinkInput = $state("");
    fileInput = $state<HTMLInputElement | undefined>(undefined);
    folderInput = $state<HTMLInputElement | undefined>(undefined);
    toastMessage = $state("");
    toastTimer: ReturnType<typeof setTimeout> | null = null;
    connectionStatsInterval: ReturnType<typeof setInterval> | null = null;
    heartbeatInterval: ReturnType<typeof setInterval> | null = null;

    // --- Constants ---
    readonly CHUNK_SIZE = 128 * 1024; // 128KB — high throughput, safe for modern WebRTC DataChannel
    readonly MAX_INFLIGHT = 8;        // Maximum concurrent encrypt operations to saturate connection

    // --- Utility functions ---
    log(msg: string) {
        this.connectionLogs = [...this.connectionLogs, `[${new Date().toLocaleTimeString()}] ${msg}`];
    }

    showToast(msg: string) {
        this.toastMessage = msg;
        if (this.toastTimer) clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => { this.toastMessage = ""; }, 3000);
    }
    
    resetToHome() {
        if (this.connectionStatsInterval) {
            clearInterval(this.connectionStatsInterval);
            this.connectionStatsInterval = null;
        }
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        const dirHandle = this.receiverDirHandle as any;
        if (dirHandle && dirHandle._dirCache) {
            try {
                dirHandle._dirCache.clear();
                delete dirHandle._dirCache;
            } catch {}
        }
        this.receiverDirHandle = null;
        this.webrtc?.close();
        this.webrtc = undefined;
        this.selectedFiles = [];
        this.totalSelectionSize = 0;
        this.bytesTransferred = 0;
        this.rawBytesTransferred = 0;
        this.senderBuffered = 0;
        this.useReceiverProgress = false;
        this.receiverReportedProgress = 0;
        this.useZipFallback = false;
        this.receiverSaveLocationName = "";
        this.peerRole = null;
        this.flowState = "IDLE";
        this.connectionType = "unknown";
        this.p2pLink = "";
        this.pendingWorkerChunks = 0;
        this.currentFileIndex = 0;
        this.fileOffset = 0;
        this.senderReadingInProgress = false;
        this.receiverWriteQueue = [];
        this.receiverWriteInProgress = false;
        this.currentPage = 0;
        this.searchQuery = "";
        this.connectionLogs = [];
        this.pingMs = -1;
        this.speedHistory = [];
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.adaptiveChunkSize = 128 * 1024;
        this.receiverChunksProcessed = 0;
        this.psk = new Uint8Array(0);
        this.p2pSelectedFiles = [];
        this.isScanningFiles = false;
        this.receiverManifest = null;
        this.receiverFileTotalSize = 0;
        this.receiverFileIndex = 0;
        this.receiverFileBytesWritten = 0;
        this.fallbackBundleFiles = [];
        this.fallbackChunks = [];
        this.skipCurrentFileWrite = false;
        this.lastProgressSent = 0;
        this.pasteLinkInput = "";
        this.treeOpenState.clear();
        if (this.fileStreamWriter) {
            try {
                const p = this.fileStreamWriter.close();
                if (p && typeof p.catch === 'function') {
                    p.catch((err: any) => console.warn("Async close error in resetToHome:", err));
                }
            } catch (closeErr) {
                console.warn("Sync close error in resetToHome:", closeErr);
            }
        }
        this.fileStreamWriter = null;
        history.replaceState(null, "", window.location.pathname);
    }
}

export function createTransferState(): TransferState {
    return new TransferState();
}
