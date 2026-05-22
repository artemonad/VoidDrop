/**
 * Crypto Orchestrator — Worker message handler and WebRTC frame setup.
 *
 * This is the central coordination layer between the crypto worker,
 * WebRTC connection, and the sender/receiver engines.
 */

import { encode, decode } from "cbor-x";
import type { CryptoWorkerMessage } from "$lib/worker/types";
import { WebRTCConnection } from "$lib/network/webrtc";
import { buildManifest } from "$lib/fileTree";
import type { TransferState } from "./transferState.svelte";
import { pushNextFileChunk } from "./senderEngine";
import { drainReceiverWriteQueue, joinP2PSession } from "./receiverEngine";

/**
 * Initialize the crypto worker and set up the message handler.
 * Returns a cleanup function to terminate the worker and close WebRTC.
 */
export function initCryptoOrchestrator(
    s: TransferState,
    apiBase: string,
): () => void {
    const worker = new Worker(
        new URL("$lib/worker/crypto.worker.ts", import.meta.url),
        { type: "module" },
    );
    s.worker = worker;

    // Parse P2P session from hash: #ROOM_ID:PSK_HEX or #ROOM_ID^PSK_HEX or #ROOM_ID;PSK_HEX
    let pendingRoomId: string | null = null;
    let pendingPsk: string | null = null;
    const hashContent = decodeURIComponent(window.location.hash.substring(1));
    let sepIdx = -1;
    for (const sep of [":", ";", "^"]) {
        const idx = hashContent.indexOf(sep);
        if (idx !== -1) {
            sepIdx = idx;
            break;
        }
    }
    if (sepIdx !== -1) {
        pendingRoomId = hashContent.substring(0, sepIdx);
        pendingPsk = hashContent.substring(sepIdx + 1);
    }

    let workerMessageQueue = Promise.resolve();

    worker.onmessage = (e: MessageEvent<CryptoWorkerMessage>) => {
        workerMessageQueue = workerMessageQueue.then(async () => {
            const { type, payload } = e.data;

            switch (type) {
                case "WASM_LOADED":
                    s.isWorkerReady = true;
                    
                    // Parse P2P session from hash at the moment WASM is loaded to ensure we have the latest hash
                    let currentRoomId = pendingRoomId;
                    let currentPsk = pendingPsk;
                    
                    if (!currentRoomId || !currentPsk) {
                        const currentHash = decodeURIComponent(window.location.hash.substring(1));
                        let currentSepIdx = -1;
                        for (const sep of [":", ";", "^"]) {
                            const idx = currentHash.indexOf(sep);
                            if (idx !== -1) {
                                currentSepIdx = idx;
                                break;
                            }
                        }
                        if (currentSepIdx !== -1) {
                            currentRoomId = currentHash.substring(0, currentSepIdx);
                            currentPsk = currentHash.substring(currentSepIdx + 1);
                        }
                    }

                    // If we have a pending P2P room, auto-connect as receiver
                    if (currentRoomId && currentPsk) {
                        s.log("Auto-joining P2P session as receiver...");
                        joinP2PSession(s, currentRoomId, currentPsk, (roomId: string) =>
                            setupWebRTC(s, roomId, apiBase),
                        );
                    }
                    break;
                case "RESULT_PQC_KEY":
                    s.webrtc?.sendFrame(0x01, encode(payload));
                    s.log("Sent Hybrid KEM Public Key");
                    break;
                case "RESULT_PQC_CIPHERTEXT":
                    s.webrtc?.sendFrame(0x02, encode(payload));
                    s.flowState = "STREAMING";
                    s.log("Handshake Secure (Sender). Initiating file stream...");

                    worker.postMessage({
                        id: "init",
                        type: "INIT_ENCRYPT_STREAM",
                        payload: {
                            psk: s.psk,
                            manifest: buildManifest(
                                s.selectedFiles,
                                s.totalSelectionSize,
                            ),
                        },
                    });
                    break;
                case "RESULT_PQC_STATUS":
                    s.flowState = "HANDSHAKE";
                    s.log("Handshake Secure (Receiver). Waiting for manifest...");
                    break;
                case "RESULT_ENCRYPT_MANIFEST": {
                    const { header, manifestCiphertext, streamHeader } = payload;
                    const buffer = new Uint8Array(
                        header.length +
                            manifestCiphertext.length +
                            streamHeader.length,
                    );
                    buffer.set(header, 0);
                    buffer.set(manifestCiphertext, header.length);
                    buffer.set(
                        streamHeader,
                        header.length + manifestCiphertext.length,
                    );

                    // P2P Mode — chunk the manifest container and send via 0x09 frame type
                    const totalSize = buffer.length;
                    const CHUNK_LIMIT = 64 * 1024; // 64KB
                    
                    const chunkedBuffer = new Uint8Array(4 + totalSize);
                    const view = new DataView(chunkedBuffer.buffer);
                    view.setUint32(0, totalSize, true);
                    chunkedBuffer.set(buffer, 4);

                    s.log(`Sending cryptographic manifest in chunks (${totalSize} bytes)...`);
                    for (let offset = 0; offset < chunkedBuffer.length; offset += CHUNK_LIMIT) {
                        const chunk = chunkedBuffer.slice(offset, offset + CHUNK_LIMIT);
                        s.webrtc?.sendFrame(0x09, chunk);
                    }
                    
                    s.log(`Manifest sent. Waiting for receiver to select destination...`);
                    s.fileOffset = 0;
                    // DO NOT call pushNextFileChunk() here — wait for 0x05 RECEIVER_READY
                    break;
                }
                case "RESULT_DECRYPT_MANIFEST": {
                    s.receiverManifest = payload;
                    s.receiverFileTotalSize = payload.totalSize;
                    s.receiverFileIndex = 0;
                    s.receiverFileBytesWritten = 0;
                    s.p2pSelectedFiles = new Array(payload.files.length).fill(true);

                    const isBundle =
                        payload.type === "bundle" && payload.files.length > 1;
                    s.log(
                        `Manifest Unlocked: ${isBundle ? `Bundle (${payload.files.length} files)` : payload.files[0].path} — ${(payload.totalSize / 1024 / 1024).toFixed(2)} MB`,
                    );
                    s.flowState = "MANIFEST";
                    break;
                }
                case "RESULT_STREAM_DONE":
                    s.log("Cryptographic integrity verified: TAG_FINAL validated successfully.");
                    break;
                case "RESULT_CHUNK": {
                    if (s.peerRole === "sender") {
                        s.pendingWorkerChunks--;

                        // WebRTC P2P Direct
                        s.webrtc?.sendData(payload);
                        s.updateProgress(s.rawBytesTransferred + Math.max(0, payload.length - 21));
                        s.senderBuffered = s.webrtc?.getBufferedAmount() ?? 0;

                        // Check if this was the final encrypted chunk
                        const allFilesRead =
                            s.currentFileIndex >= s.selectedFiles.length;
                        const isAbsolutelyFinal =
                            allFilesRead && s.pendingWorkerChunks === 0;
                        if (isAbsolutelyFinal) {
                            // Wait for WebRTC buffer to flush
                            while (s.webrtc && s.webrtc.getBufferedAmount() > 0) {
                                await new Promise((r) => setTimeout(r, 4));
                            }
                            s.log("Data sent. Waiting for receiver to confirm...");
                            // Don't set flowState = "DONE" yet — wait for 0x07 ACK from receiver.
                        } else {
                            // Pipeline: push more chunks if below inflight limit
                            if (s.pendingWorkerChunks < s.MAX_INFLIGHT) {
                                pushNextFileChunk(s);
                            }
                        }
                    } else if (s.peerRole === "receiver") {
                        // Buffer decrypted chunk for async write — don't block decryption pipeline
                        s.receiverWriteQueue.push({ data: payload, isFinal: !!e.data.isFinal });
                        drainReceiverWriteQueue(s);
                        if (e.data.isFinal) {
                            worker.postMessage({ id: "done", type: "STREAM_DONE" });
                        }
                    }
                    break;
                }
                case "ERROR":
                    s.log(`Critical worker encryption error: ${payload}`);
                    s.flowState = "ERROR";
                    break;
            }
        }).catch(err => {
            console.error("Worker message processing error:", err);
        });
    };

    // Return cleanup function
    return () => {
        if (s.connectionStatsInterval) {
            clearInterval(s.connectionStatsInterval);
            s.connectionStatsInterval = null;
        }
        if (s.heartbeatInterval) {
            clearInterval(s.heartbeatInterval);
            s.heartbeatInterval = null;
        }
        try {
            worker.postMessage({ type: "CLEANUP_SESSION" });
        } catch {}
        worker.terminate();
        s.webrtc?.close();
    };
}

/**
 * Set up WebRTC connection and frame handlers.
 */
export function setupWebRTC(s: TransferState, roomId: string, apiBase: string) {
    s.webrtc = new WebRTCConnection(roomId, s.psk, undefined, apiBase);
    s.webrtc.onLog = (msg) => s.log(msg);

    if (s.connectionStatsInterval) {
        clearInterval(s.connectionStatsInterval);
    }

    s.connectionStatsInterval = setInterval(async () => {
        if (!s.webrtc) {
            if (s.connectionStatsInterval) {
                clearInterval(s.connectionStatsInterval);
                s.connectionStatsInterval = null;
            }
            s.connectionType = "unknown";
            return;
        }
        try {
            const type = await s.webrtc.getConnectionType();
            s.connectionType = type;
        } catch {}
    }, 2000);

    // Accumulator variables for chunked manifest reception
    let manifestAccumulator: Uint8Array | null = null;
    let expectedManifestSize = 0;
    let manifestAccumulatorOffset = 0;
    s.webrtc.onStateChange = (state) => {
        s.log(`WebRTC: ${state}`);
        if (state.includes("disconnected") || state.includes("failed")) {
            if (s.flowState === "STREAMING") {
                s.isReconnecting = true;
                s.reconnectAttempts++;
                s.log(`Warning: Connection lost! Attempting recovery (Attempt ${s.reconnectAttempts})...`);
            }
        }
        if (state === "DataChannel: OPEN") {
            if (s.isReconnecting) {
                s.log("Connection re-established! Resuming transfer...");
                if (s.peerRole === "receiver") {
                    const nextNonceBase = window.crypto.getRandomValues(new Uint8Array(24));
                    const resumeBuffer = new Uint8Array(48);
                    const view = new DataView(resumeBuffer.buffer);
                    view.setUint32(0, s.receiverChunksProcessed, true);
                    view.setUint32(4, s.receiverFileIndex, true);
                    view.setBigUint64(8, BigInt(s.receiverFileBytesWritten), true);
                    view.setBigUint64(16, BigInt(s.rawBytesTransferred), true);
                    resumeBuffer.set(nextNonceBase, 24);
                    s.webrtc?.sendFrame(0x0B, resumeBuffer);

                    s.worker!.postMessage({
                        id: "reset_dec_ctr",
                        type: "RESET_DECRYPT_COUNTER",
                        payload: { counter: 0, nonceBase: nextNonceBase }
                    });
                }
            } else if (
                s.peerRole === "receiver" ||
                (!s.peerRole && s.selectedFiles.length === 0)
            ) {
                s.peerRole = "receiver";
                s.flowState = "HANDSHAKE";
                s.log("Initiating Receiver Handshake...");
                s.worker!.postMessage({
                    id: "hs1",
                    type: "HANDSHAKE_PQC_GENERATE",
                });
            }
        }
    };
    s.webrtc.onFrame = (type, data) => {
        if (type === 0x01 && s.peerRole === "sender") {
            s.log("Received Receiver's PK. Encapsulating...");
            s.worker!.postMessage({
                id: "hs2",
                type: "HANDSHAKE_PQC_ENCAPSULATE",
                payload: { psk: s.psk, publicKey: decode(data) },
            });
        } else if (type === 0x02 && s.peerRole === "receiver") {
            s.log("Received Sender's CT. Decapsulating...");
            s.worker!.postMessage({
                id: "hs3",
                type: "HANDSHAKE_PQC_DECAPSULATE",
                payload: { psk: s.psk, ciphertext: decode(data) },
            });
        } else if (type === 0x03 && s.peerRole === "receiver") {
            s.log("Received Header & Manifest.");
            const view = new DataView(
                data.buffer,
                data.byteOffset,
                data.byteLength,
            );
            const manifestLen = view.getUint32(22, true);

            const header = data.slice(0, 26);
            const manifestCiphertext = data.slice(26, 26 + manifestLen);
            const streamHeader = data.slice(26 + manifestLen);

            s.worker!.postMessage({
                id: "init_dec",
                type: "DECRYPT_MANIFEST",
                payload: { header, manifestCiphertext, streamHeader },
            });
        } else if (type === 0x09 && s.peerRole === "receiver") {
            if (expectedManifestSize === 0) {
                if (data.length < 4) {
                    console.error("Manifest chunk too small to read total size");
                    return;
                }
                const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
                const size = view.getUint32(0, true);
                const MAX_MANIFEST_SIZE = 10 * 1024 * 1024; // Strict defensive 10MB limit
                if (size <= 0 || size > MAX_MANIFEST_SIZE) {
                    console.error(`Rejected invalid or overly large manifest size: ${size} bytes (max ${MAX_MANIFEST_SIZE} bytes)`);
                    return;
                }
                expectedManifestSize = size;
                manifestAccumulator = new Uint8Array(expectedManifestSize);
                manifestAccumulatorOffset = 0;

                s.log(`Receiving chunked manifest (${expectedManifestSize} bytes)...`);

                const rest = data.slice(4);
                if (manifestAccumulatorOffset + rest.length > expectedManifestSize) {
                    console.error("Manifest chunk exceeded expected size limit");
                    manifestAccumulator = null;
                    expectedManifestSize = 0;
                    manifestAccumulatorOffset = 0;
                    return;
                }
                manifestAccumulator.set(rest, manifestAccumulatorOffset);
                manifestAccumulatorOffset += rest.length;
            } else {
                if (manifestAccumulator) {
                    if (manifestAccumulatorOffset + data.length > expectedManifestSize) {
                        console.error("Manifest chunk exceeded expected size limit");
                        manifestAccumulator = null;
                        expectedManifestSize = 0;
                        manifestAccumulatorOffset = 0;
                        return;
                    }
                    manifestAccumulator.set(data, manifestAccumulatorOffset);
                    manifestAccumulatorOffset += data.length;
                }
            }

            if (manifestAccumulator && manifestAccumulatorOffset >= expectedManifestSize) {
                s.log("Received complete manifest container. Processing...");
                
                const finalData = manifestAccumulator;
                const view = new DataView(
                    finalData.buffer,
                    finalData.byteOffset,
                    finalData.byteLength,
                );
                const manifestLen = view.getUint32(22, true);

                const header = finalData.slice(0, 26);
                const manifestCiphertext = finalData.slice(26, 26 + manifestLen);
                const streamHeader = finalData.slice(26 + manifestLen);

                s.worker!.postMessage({
                    id: "init_dec",
                    type: "DECRYPT_MANIFEST",
                    payload: { header, manifestCiphertext, streamHeader },
                });

                // Reset accumulator
                manifestAccumulator = null;
                expectedManifestSize = 0;
                manifestAccumulatorOffset = 0;
            }
        } else if (type === 0x04 && s.peerRole === "receiver") {
            const isFinalChunk = (s.rawBytesTransferred + data.length - 21) >= s.receiverFileTotalSize;
            
            // Fixed 128KB chunk size
            s.adaptiveChunkSize = 128 * 1024;

            s.worker!.postMessage(
                {
                    id: "dec",
                    type: "DECRYPT_CHUNK",
                    payload: { chunk: data, isFinal: isFinalChunk },
                },
                [data.buffer],
            );
        } else if (type === 0x05 && s.peerRole === "sender") {
            // Receiver confirmed file picker is ready — start streaming
            try {
                const selectedMask = decode(data) as boolean[];
                s.p2pSelectedFiles = selectedMask;
                
                // Recalculate total selection size for sender to match selected files only
                const selectedSize = s.selectedFiles.reduce((sum, file, i) => {
                    return sum + (selectedMask[i] !== false ? file.file.size : 0);
                }, 0);
                s.totalSelectionSize = selectedSize;

                const selectedCount = selectedMask.filter(x => x !== false).length;
                s.log(`Receiver selected ${selectedCount} / ${s.selectedFiles.length} files (${(selectedSize / 1024 / 1024).toFixed(2)} MB). Streaming...`);
            } catch (err) {
                console.warn("Failed to decode receiver selected files frame:", err);
                s.log("Receiver ready. Streaming file...");
            }
            startHeartbeat(s);
            pushNextFileChunk(s);
        } else if (type === 0x06 && s.peerRole === "receiver") {
            // Legacy: no-op. Stream end is now detected via TAG_FINAL in RESULT_CHUNK.
        } else if (type === 0x07 && s.peerRole === "sender") {
            // Receiver confirmed all data written to disk
            s.log("P2P Transfer verified by receiver!");
            s.flowState = "DONE";
        } else if (type === 0x08 && s.peerRole === "sender") {
            // Receiver reports exact progress (written bytes)
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            s.receiverReportedProgress = Number(view.getBigUint64(0, true));
            s.useReceiverProgress = true;
            s.senderBuffered = 0; // Disable sender-side buffered subtraction to show receiver's real progress
        } else if (type === 0x0A) {
            if (s.peerRole === "receiver") {
                // Echo pong immediately
                s.webrtc?.sendFrame(0x0A, data);
            } else if (s.peerRole === "sender") {
                // Process pong and compute RTT
                const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
                const sentTime = view.getFloat64(0, true);
                const rtt = performance.now() - sentTime;
                s.pingMs = rtt;

                // Fixed 128KB chunk size for stability across all networks
                s.adaptiveChunkSize = 128 * 1024;
            }
        } else if (type === 0x0B && s.peerRole === "sender") {
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const receiverChunksProcessed = view.getUint32(0, true);
            const receiverFileIndex = view.getUint32(4, true);
            const receiverFileBytesWritten = Number(view.getBigUint64(8, true));
            const rawBytesTransferred = Number(view.getBigUint64(16, true));
            const nextNonceBase = data.slice(24, 48);

            s.log(`Auto-Resume: Resuming transfer from chunk ${receiverChunksProcessed}, file ${receiverFileIndex}, offset ${receiverFileBytesWritten}`);

            s.isReconnecting = false;
            s.reconnectAttempts = 0;

            s.currentFileIndex = receiverFileIndex;
            s.fileOffset = receiverFileBytesWritten;
            s.bytesTransferred = rawBytesTransferred;
            s.rawBytesTransferred = rawBytesTransferred;
            s.receiverReportedProgress = rawBytesTransferred;
            s.pendingWorkerChunks = 0;

            s.worker!.postMessage({
                id: "resume_enc",
                type: "RESET_ENCRYPT_COUNTER",
                payload: { counter: 0, nonceBase: nextNonceBase }
            });

            s.webrtc?.sendFrame(0x0C, new Uint8Array([1]));
            pushNextFileChunk(s);
        } else if (type === 0x0C && s.peerRole === "receiver") {
            s.isReconnecting = false;
            s.log("Auto-Resume: Sender acknowledged sync. Resuming stream.");
        }
    };
}

function startHeartbeat(s: TransferState) {
    if (s.heartbeatInterval) return;

    s.heartbeatInterval = setInterval(() => {
        if (s.flowState !== "STREAMING" || !s.webrtc) {
            if (s.heartbeatInterval) {
                clearInterval(s.heartbeatInterval);
                s.heartbeatInterval = null;
            }
            return;
        }

        const pingBuf = new Uint8Array(8);
        const view = new DataView(pingBuf.buffer);
        view.setFloat64(0, performance.now(), true);
        s.webrtc.sendFrame(0x0A, pingBuf);
    }, 1000);
}

