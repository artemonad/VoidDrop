/**
 * Sender Engine — All sender-side transfer logic.
 *
 * Handles: file chunking with batching, S3 multipart upload, P2P send via WebRTC.
 */

import { buildManifest } from "$lib/fileTree";
import type { TransferState } from "./transferState.svelte";

/**
 * Read the next chunk(s) from selected files, batch small files together,
 * and send to the crypto worker for encryption.
 */
export async function pushNextFileChunk(s: TransferState) {
    if (s.selectedFiles.length === 0) return;
    if (s.senderReadingInProgress) return;
    s.senderReadingInProgress = true;

    let isFinal = false;

    try {
        // Wait if WebRTC is buffered full (using 4MB threshold and low latency polling for max P2P throughput)
        while (s.webrtc && s.webrtc.getBufferedAmount() > 1024 * 1024 * 4) {
            await new Promise((r) => setTimeout(r, 4));
        }

        // Flow control: wait if receiver is falling behind on disk writes in P2P mode
        // (threshold 16MB keeps network pipeline saturated while preventing memory bloat / OOM)
        if (s.webrtc) {
            while (s.rawBytesTransferred - s.receiverReportedProgress > 1024 * 1024 * 16) {
                await new Promise((r) => setTimeout(r, 10));
            }
        }

        // All files exhausted — don't read more
        if (s.currentFileIndex >= s.selectedFiles.length) {
            return;
        }

        // === BATCHING: accumulate data from multiple small files into one chunk ===
        const parts: Uint8Array[] = [];
        let batchSize = 0;

        while (s.currentFileIndex < s.selectedFiles.length && batchSize < s.adaptiveChunkSize) {
            if (s.p2pSelectedFiles && s.p2pSelectedFiles[s.currentFileIndex] === false) {
                s.currentFileIndex++;
                s.fileOffset = 0;
                continue;
            }

            const currentFile = s.selectedFiles[s.currentFileIndex].file;
            const remaining = s.adaptiveChunkSize - batchSize;
            let end = Math.min(s.fileOffset + remaining, currentFile.size);
            const slice = currentFile.slice(s.fileOffset, end);
            
            let buffer: Uint8Array;
            try {
                const arrayBuf = await slice.arrayBuffer();
                buffer = new Uint8Array(arrayBuf);
            } catch (readErr) {
                console.warn(`File read error at index ${s.currentFileIndex} (${currentFile.name}):`, readErr);
                s.log(`⚠️ Read error: "${currentFile.name}" (file is locked or protected by the system). Skipping...`);
                
                // Keep the stream offset aligned by feeding zeroes for the rest of this file
                const bytesLeft = currentFile.size - s.fileOffset;
                buffer = new Uint8Array(bytesLeft);
                end = currentFile.size;
            }

            if (buffer.length > 0) {
                parts.push(buffer);
                batchSize += buffer.length;
            }

            const isLastChunkOfFile = end >= currentFile.size;
            const isLastFile = s.currentFileIndex === s.selectedFiles.length - 1;

            s.fileOffset = end;

            if (isLastChunkOfFile) {
                if (isLastFile) {
                    isFinal = true;
                    s.currentFileIndex++; // Push past end so allFilesRead triggers
                    break;
                }
                s.currentFileIndex++;
                s.fileOffset = 0;
                // Continue loop to batch more files into this chunk
            } else {
                break; // chunk buffer is full, stop batching
            }
        }

        if (s.currentFileIndex >= s.selectedFiles.length) {
            isFinal = true;
        }

        if (batchSize === 0 && !isFinal) return;

        // Merge parts into single buffer for encryption
        let chunk: Uint8Array;
        if (parts.length === 1) {
            chunk = parts[0];
        } else {
            chunk = new Uint8Array(batchSize);
            let off = 0;
            for (const p of parts) {
                chunk.set(p, off);
                off += p.length;
            }
        }

        s.pendingWorkerChunks++;
        const transferBuffer = chunk.buffer.slice(
            chunk.byteOffset,
            chunk.byteOffset + chunk.byteLength,
        ) as ArrayBuffer;
        s.worker!.postMessage(
            {
                id: `chunk_${Date.now()}_${s.pendingWorkerChunks}`,
                type: "ENCRYPT_CHUNK",
                payload: {
                    chunk: new Uint8Array(transferBuffer),
                    isFinal,
                },
            },
            [transferBuffer],
        );
    } finally {
        s.senderReadingInProgress = false;
    }

    // === PIPELINING: immediately queue next chunk if below inflight limit ===
    if (!isFinal && s.pendingWorkerChunks < s.MAX_INFLIGHT) {
        pushNextFileChunk(s);
    }
}


/**
 * Create a new P2P session as sender.
 */
export function initWebRTC(s: TransferState, setupWebRTC: (roomId: string) => void) {
    s.updateProgress(0, true);
    s.currentFileIndex = 0;
    s.fileOffset = 0;
    s.pendingWorkerChunks = 0;

    // Generate PSK
    const arr = new Uint8Array(32);
    window.crypto.getRandomValues(arr);
    const pskHex = Array.from(arr)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    const roomId = crypto.randomUUID();
    // Format: /#ROOM_ID:PSK_HEX (entirely in fragment — invisible to server)
    window.location.hash = `${roomId}:${pskHex}`;
    
    let origin = window.location.origin;
    if (origin.includes("tauri")) {
        origin = "https://voiddrop.ru";
    }
    s.p2pLink = `${origin}/#${roomId}:${pskHex}`;

    s.psk = new Uint8Array(
        pskHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
    );

    s.flowState = "HANDSHAKE";
    setupWebRTC(roomId);
    s.log(`UI: Connecting via Signaling Server...`);
}
