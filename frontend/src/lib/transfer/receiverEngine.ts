/**
 * Receiver Engine — All receiver-side transfer logic.
 *
 * Handles: file writing, bundle chunk slicing, write queue draining, P2P download initiation.
 */

import type { TransferState } from "./transferState.svelte";
import { isTauri } from "../isTauri";
import { TauriDirHandle, sanitizeRelativePath } from "../tauriFs";
import JSZip from "jszip";
import { encode } from "cbor-x";

/**
 * Open (or create) a file for writing inside a directory handle, creating subdirs as needed.
 */
export async function openFileInDir(
    rootDir: any,
    relativePath: string,
    options?: { keepExistingData?: boolean; seekOffset?: number },
): Promise<any> {
    if (!rootDir) {
        throw new Error("Cannot open file in directory: rootDir handle is null or undefined.");
    }
    const sanitizedPath = sanitizeRelativePath(relativePath) || "downloaded_file";
    const parts = sanitizedPath.split("/");
    let dirHandle = rootDir;
    
    if (!rootDir._dirCache) {
        rootDir._dirCache = new Map();
    }
    const cache = rootDir._dirCache;
    let currentPath = "";
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        if (cache.has(currentPath)) {
            dirHandle = cache.get(currentPath);
        } else {
            dirHandle = await dirHandle.getDirectoryHandle(part, {
                create: true,
            });
            cache.set(currentPath, dirHandle);
        }
    }

    const nameToTry = parts[parts.length - 1];
    const fileHandle = await dirHandle.getFileHandle(nameToTry, { create: true });
    const writer = await fileHandle.createWritable({ keepExistingData: options?.keepExistingData });
    if (options?.seekOffset && options.seekOffset > 0) {
        if (typeof writer.seek === 'function') {
            await writer.seek(options.seekOffset);
        }
    }
    return writer;
}

/**
 * P2P receiver: user confirmed download after reviewing manifest.
 * Opens file picker and signals sender to begin streaming.
 */
export async function startP2PDownload(s: TransferState, forceZip = false) {
    if (!s.receiverManifest) return;
    const isBundle =
        s.receiverManifest.type === "bundle" &&
        s.receiverManifest.files.length > 1;

    s.useZipFallback = forceZip;
    s.fallbackBundleFiles = [];
    s.fallbackChunks = [];

    try {
        if (isBundle) {
            if (forceZip) {
                s.log("Forced diskless mode (RAM ZIP) started. Download will begin as a ZIP archive...");
                s.receiverSaveLocationName = "RAM ZIP (In-Memory)";
                s.fallbackBundleFiles = new Array(s.receiverManifest.files.length);
            } else if (isTauri()) {
                const { open } = await import('@tauri-apps/plugin-dialog');
                const dir = await open({ directory: true, title: 'Choose download folder' });
                if (!dir) { s.log('Save cancelled.'); return; }
                
                const now = new Date();
                const pad = (n: number) => String(n).padStart(2, '0');
                const folderSuffix = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
                const autoSubfolderName = `VoidDrop_${folderSuffix}`;
                
                const { join } = await import('@tauri-apps/api/path');
                const subPath = await join(dir, autoSubfolderName);
                const { mkdir } = await import('@tauri-apps/plugin-fs');
                await mkdir(subPath, { recursive: true }).catch(() => {});
                
                s.receiverDirHandle = new TauriDirHandle(subPath);
                s.fileStreamWriter = null;
                const folderName = dir.substring(Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\')) + 1) || dir;
                s.receiverSaveLocationName = `${folderName}/${autoSubfolderName}`;
                s.log(`Created isolated folder "${autoSubfolderName}" to prevent file overwriting.`);
            } else if ('showDirectoryPicker' in window) {
                try {
                    const selectedDirHandle = await (window as any).showDirectoryPicker({
                        mode: "readwrite",
                    });
                    
                    const now = new Date();
                    const pad = (n: number) => String(n).padStart(2, '0');
                    const folderSuffix = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
                    const autoSubfolderName = `VoidDrop_${folderSuffix}`;
                    
                    const subDirHandle = await selectedDirHandle.getDirectoryHandle(autoSubfolderName, { create: true });
                    s.receiverDirHandle = subDirHandle;
                    s.fileStreamWriter = null; // Open dynamically during streaming
                    const parentName = selectedDirHandle.name || 'Local Folder';
                    s.receiverSaveLocationName = `${parentName}/${autoSubfolderName}`;
                    s.log(`Created isolated folder "${autoSubfolderName}" to prevent file overwriting.`);
                } catch (pickerErr: any) {
                    console.warn("Directory picker error, falling back to RAM ZIP:", pickerErr);
                    if (pickerErr?.name === 'SecurityError') {
                        s.log("The browser is blocking access to the root Downloads folder. Create a subfolder (e.g. Downloads/VoidDrop) and select it, or continue downloading as a ZIP archive.");
                        s.showToast("Root Downloads folder is blocked by browser. Please select a subfolder.");
                    } else {
                        s.log("Browser system protection is active or access was denied. Download will begin as a single ZIP archive...");
                    }
                    s.useZipFallback = true;
                    s.receiverSaveLocationName = "RAM ZIP (In-Memory)";
                    s.fallbackBundleFiles = new Array(s.receiverManifest.files.length);
                }
            } else {
                s.log("The browser does not support folder selection. Download will begin as a single ZIP archive...");
                s.useZipFallback = true;
                s.receiverSaveLocationName = "RAM ZIP (In-Memory)";
                s.fallbackBundleFiles = new Array(s.receiverManifest.files.length);
            }
        } else {
            if (forceZip) {
                s.log("Forced diskless mode started (RAM fallback)...");
                s.useZipFallback = true;
                s.receiverSaveLocationName = "RAM (In-Memory)";
                s.fallbackChunks = [];
            } else if (isTauri()) {
                s.useZipFallback = true;
                s.fallbackChunks = [];
                s.receiverSaveLocationName = "Local Disk (Tauri)";
                s.log(`Save location prepared (Tauri native). Signaling sender to begin...`);
            } else if ('showSaveFilePicker' in window) {
                try {
                    const handle = await (window as any).showSaveFilePicker({
                        suggestedName: s.receiverManifest.files[0].path,
                    });
                    s.fileStreamWriter = await handle.createWritable();
                    s.receiverSaveLocationName = handle.name || 'Local File';
                    s.log(`Save location selected. Signaling sender to begin...`);
                } catch (pickerErr: any) {
                    console.warn("Save file picker error, falling back to RAM:", pickerErr);
                    if (pickerErr?.name === 'SecurityError') {
                        s.log("The browser is blocking access to the selected file. Download will begin into RAM...");
                        s.showToast("The selected file is blocked by the browser. Downloading to RAM...");
                    } else {
                        s.log("Browser system protection is active. Downloading to RAM...");
                    }
                    s.useZipFallback = true;
                    s.receiverSaveLocationName = "RAM (In-Memory)";
                    s.fallbackChunks = [];
                }
            } else {
                s.useZipFallback = true;
                s.receiverSaveLocationName = "RAM (In-Memory)";
                s.fallbackChunks = [];
                s.log(`Using in-memory download (no streaming API)...`);
            }
        }
        const selectedSize = s.receiverManifest.files.reduce((sum: number, file: any, i: number) => sum + (s.p2pSelectedFiles[i] !== false ? file.size : 0), 0);
        s.receiverFileTotalSize = selectedSize;

        s.flowState = "STREAMING";
        s.webrtc?.sendFrame(0x05, encode(s.p2pSelectedFiles));
    } catch (err) {
        s.log("File save picker cancelled or failed.");
        if (s.fileStreamWriter) {
            try {
                const p = s.fileStreamWriter.close();
                if (p && typeof p.catch === 'function') {
                    p.catch((closeErr: any) => console.warn("Failed to close fileStreamWriter in startP2PDownload catch block:", closeErr));
                }
            } catch (closeErr) {
                console.warn("Failed to close fileStreamWriter in startP2PDownload catch block:", closeErr);
            }
            s.fileStreamWriter = null;
        }
    }
}

/**
 * Drain the receiver write queue — processes buffered decrypted chunks sequentially.
 * This decouples decryption from file I/O so the crypto worker isn't blocked.
 */
export async function drainReceiverWriteQueue(s: TransferState) {
    if (s.flowState === "DONE" || s.flowState === "ERROR") return;
    if (s.receiverWriteInProgress) return;
    s.receiverWriteInProgress = true;

    try {
        while (s.receiverWriteQueue.length > 0) {
            const item = s.receiverWriteQueue.shift()!;
            await writeReceiverChunk(s, item.data);
            s.receiverChunksProcessed++;

            // Send real-time progress update back to sender via 0x08 WebRTC frame
            const currentBytes = s.rawBytesTransferred;
            const shouldSendProgress = !s.lastProgressSent ||
                (currentBytes - s.lastProgressSent >= 512 * 1024) ||
                item.isFinal;
            if (shouldSendProgress) {
                s.lastProgressSent = currentBytes;
                const progressBuffer = new Uint8Array(8);
                const view = new DataView(progressBuffer.buffer);
                view.setBigUint64(0, BigInt(currentBytes), true);
                s.webrtc?.sendFrame(0x08, progressBuffer);
            }

            if (item.isFinal) {
                if (s.flowState === "DONE") {
                    continue; // Skip duplicate completion execution
                }
                if (s.useZipFallback) {
                    if (s.fallbackBundleFiles && s.fallbackBundleFiles.length > 0) {
                        s.log("Assembling ZIP archive in RAM (diskless mode)...");
                        const zip = new JSZip();
                        for (const f of s.fallbackBundleFiles) {
                            if (!f) continue;
                            const totalLen = f.chunks.reduce((acc: number, c: Uint8Array) => acc + c.length, 0);
                            const fileData = new Uint8Array(totalLen);
                            let offset = 0;
                            for (const chunk of f.chunks) {
                                fileData.set(chunk, offset);
                                offset += chunk.length;
                            }
                            zip.file(f.path, fileData);
                        }
                        const zipBlob = await zip.generateAsync({ type: "blob" });
                        const zipName = "voiddrop-bundle.zip";

                        if (isTauri()) {
                            const { saveFile } = await import("../tauriFs");
                            const bytes = new Uint8Array(await zipBlob.arrayBuffer());
                            await saveFile(zipName, bytes);
                        } else {
                            const url = URL.createObjectURL(zipBlob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = zipName;
                            a.click();
                            URL.revokeObjectURL(url);
                        }
                        s.fallbackBundleFiles = [];
                    } else if (s.fallbackChunks && s.fallbackChunks.length > 0) {
                        const fileMime = s.receiverManifest?.files?.[0]?.mime || 'application/octet-stream';
                        const fileName = s.receiverManifest?.files?.[0]?.path || 'voiddrop-file';
                        const blob = new Blob(s.fallbackChunks as BlobPart[], { type: fileMime });
                        
                        if (isTauri()) {
                            const { saveFile } = await import("../tauriFs");
                            const bytes = new Uint8Array(await blob.arrayBuffer());
                            await saveFile(fileName, bytes);
                        } else {
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            
                            // Extract basename to prevent iOS Safari from zipping the file if path contains slashes
                            let baseName = fileName;
                            const lastSlash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
                            if (lastSlash !== -1) {
                                baseName = fileName.substring(lastSlash + 1);
                            }
                            a.download = baseName;
                            
                            a.click();
                            URL.revokeObjectURL(url);
                        }
                        s.fallbackChunks = [];
                    }
                    s.useZipFallback = false;
                } else if (s.fileStreamWriter) {
                    try {
                        await s.fileStreamWriter.close();
                    } catch (closeErr) {
                        console.warn("Final file close warning:", closeErr);
                    }
                    s.fileStreamWriter = null;
                }
                s.flowState = "DONE";
                s.updateProgress(s.rawBytesTransferred, true); // Force final exact progress
                const savedCount = s.receiverManifest?.files ? s.p2pSelectedFiles.filter(Boolean).length : 1;
                s.log(`DOWNLOAD COMPLETE! ${savedCount} file(s) saved.`);
                s.webrtc?.sendFrame(0x07, new Uint8Array([1]));
            }
        }
    } catch (err) {
        console.error("Error draining receiver write queue:", err);
        s.log(`Error writing files: ${err instanceof Error ? err.message : err}`);
        s.flowState = "ERROR";
        if (s.fileStreamWriter) {
            try {
                await s.fileStreamWriter.close();
            } catch (closeErr) {
                console.warn("Failed to close fileStreamWriter in catch block:", closeErr);
            }
            s.fileStreamWriter = null;
        }
    } finally {
        s.receiverWriteInProgress = false;
    }
}

/**
 * Receiver: write decrypted chunk, slicing across file boundaries for bundles.
 */
async function writeReceiverChunk(s: TransferState, data: Uint8Array) {
    if (!s.receiverManifest) return;

    let remaining = data;

    while (remaining.length > 0) {
        // Skip zero-byte files to prevent infinite loop and create them if selected
        while (
            s.receiverFileIndex < s.receiverManifest.files.length &&
            s.receiverManifest.files[s.receiverFileIndex].size === 0
        ) {
            const isSelected = s.p2pSelectedFiles[s.receiverFileIndex] !== false;
            if (isSelected) {
                if (s.useZipFallback) {
                    if (s.fallbackBundleFiles) {
                        if (!s.fallbackBundleFiles[s.receiverFileIndex]) {
                            s.fallbackBundleFiles[s.receiverFileIndex] = {
                                path: s.receiverManifest.files[s.receiverFileIndex].path,
                                chunks: []
                            };
                        }
                    }
                } else if (s.receiverDirHandle) {
                    try {
                        const tempWriter = await openFileInDir(
                            s.receiverDirHandle,
                            s.receiverManifest.files[s.receiverFileIndex].path
                        );
                        await tempWriter.close();
                    } catch (e) {
                        console.warn("Failed to create empty file in P2P:", e);
                    }
                } else if (s.fileStreamWriter) {
                    try {
                        await s.fileStreamWriter.close();
                    } catch {}
                    s.fileStreamWriter = null;
                }
            }
            s.receiverFileBytesWritten = 0;
            s.receiverFileIndex++;
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (s.receiverFileIndex >= s.receiverManifest.files.length) break;

        const currentFile = s.receiverManifest.files[s.receiverFileIndex];
        const bytesLeft = currentFile.size - s.receiverFileBytesWritten;
        const isSelected = s.p2pSelectedFiles[s.receiverFileIndex] !== false;

        if (!isSelected) {
            s.receiverFileBytesWritten = 0;
            s.receiverFileIndex++;
            continue;
        }

        if (isSelected) {
            if (s.useZipFallback) {
                if (s.receiverManifest.files.length > 1) {
                    if (s.fallbackBundleFiles && !s.fallbackBundleFiles[s.receiverFileIndex]) {
                        s.fallbackBundleFiles[s.receiverFileIndex] = {
                            path: currentFile.path,
                            chunks: []
                        };
                    }
                } else {
                    if (!s.fallbackChunks) {
                        s.fallbackChunks = [];
                    }
                }
            } else if (!s.fileStreamWriter && !s.skipCurrentFileWrite) {
                if (s.receiverDirHandle) {
                    try {
                        s.fileStreamWriter = await openFileInDir(
                            s.receiverDirHandle,
                            currentFile.path,
                            { keepExistingData: s.receiverFileBytesWritten > 0, seekOffset: s.receiverFileBytesWritten }
                        );
                    } catch (err) {
                        console.warn("Failed to create file:", err);
                        if (s.receiverFileIndex > 0) {
                            s.log(`⚠️ Skipped file during write: "${currentFile.path}" (busy or locked)`);
                            s.skipCurrentFileWrite = true;
                        } else {
                            s.useZipFallback = true;
                            if (s.receiverManifest.files.length > 1) {
                                s.log("Error creating file on disk. Switching to RAM ZIP...");
                                if (!s.fallbackBundleFiles || s.fallbackBundleFiles.length === 0) {
                                    s.fallbackBundleFiles = new Array(s.receiverManifest.files.length);
                                }
                                s.fallbackBundleFiles[s.receiverFileIndex] = {
                                    path: currentFile.path,
                                    chunks: []
                                };
                            } else {
                                s.log("Error creating file on disk. Switching to RAM...");
                                if (!s.fallbackChunks) {
                                    s.fallbackChunks = [];
                                }
                            }
                        }
                    }
                } else {
                    // We must NEVER show picker asynchronously during streaming,
                    // as it throws a browser SecurityError and terminates WebRTC.
                    // Instead, fallback directly to RAM/Blob download.
                    s.log("Write mode unavailable. Switching to RAM...");
                    s.useZipFallback = true;
                    if (!s.fallbackChunks) {
                        s.fallbackChunks = [];
                    }
                }
            }
        }

        if (remaining.length <= bytesLeft) {
            // Entire remaining chunk fits in the current file
            if (isSelected) {
                if (s.useZipFallback) {
                    if (s.receiverManifest.files.length > 1) {
                        if (s.fallbackBundleFiles) {
                            s.fallbackBundleFiles[s.receiverFileIndex].chunks.push(remaining);
                        }
                    } else {
                        if (s.fallbackChunks) {
                            s.fallbackChunks.push(remaining);
                        }
                    }
                } else if (s.fileStreamWriter && !s.skipCurrentFileWrite) {
                    try {
                        await s.fileStreamWriter.write(remaining);
                    } catch (writeErr) {
                        console.warn("Failed to write:", writeErr);
                        if (s.receiverFileIndex > 0) {
                            s.log(`⚠️ File write error: "${currentFile.path}" (locked or busy). Skipping...`);
                            s.skipCurrentFileWrite = true;
                        } else {
                            s.useZipFallback = true;
                            if (s.receiverManifest.files.length > 1) {
                                s.log("Write error. Switching to RAM ZIP...");
                                if (!s.fallbackBundleFiles || s.fallbackBundleFiles.length === 0) {
                                    s.fallbackBundleFiles = new Array(s.receiverManifest.files.length);
                                }
                                s.fallbackBundleFiles[s.receiverFileIndex] = {
                                    path: currentFile.path,
                                    chunks: [remaining]
                                };
                            } else {
                                s.log("Write error. Switching to RAM...");
                                if (!s.fallbackChunks) {
                                    s.fallbackChunks = [];
                                }
                                s.fallbackChunks.push(remaining);
                            }
                        }
                        try { await s.fileStreamWriter?.close(); } catch {}
                        s.fileStreamWriter = null;
                    }
                }
            }
            s.updateProgress(s.rawBytesTransferred + remaining.length);
            s.receiverFileBytesWritten += remaining.length;
            
            if (s.receiverFileBytesWritten === currentFile.size) {
                if (isSelected && !s.useZipFallback && s.fileStreamWriter) {
                    try { await s.fileStreamWriter.close(); } catch {}
                }
                s.fileStreamWriter = null;
                s.skipCurrentFileWrite = false; // Reset skip flag for next file
                s.receiverFileBytesWritten = 0;
                s.receiverFileIndex++;
            }
            remaining = new Uint8Array(0);
        } else {
            // Chunk crosses file boundary — split it
            if (bytesLeft > 0) {
                if (isSelected) {
                    if (s.useZipFallback) {
                        if (s.receiverManifest.files.length > 1) {
                            if (s.fallbackBundleFiles) {
                                s.fallbackBundleFiles[s.receiverFileIndex].chunks.push(remaining.slice(0, bytesLeft));
                            }
                        } else {
                            if (s.fallbackChunks) {
                                s.fallbackChunks.push(remaining.slice(0, bytesLeft));
                            }
                        }
                    } else if (s.fileStreamWriter && !s.skipCurrentFileWrite) {
                        try {
                            await s.fileStreamWriter.write(remaining.slice(0, bytesLeft));
                        } catch (writeErr) {
                            console.warn("Failed to write:", writeErr);
                            if (s.receiverFileIndex > 0) {
                                s.log(`⚠️ File write error: "${currentFile.path}" (locked or busy). Skipping...`);
                                s.skipCurrentFileWrite = true;
                            } else {
                                s.useZipFallback = true;
                                if (s.receiverManifest.files.length > 1) {
                                    s.log("Write error. Switching to RAM ZIP...");
                                    if (!s.fallbackBundleFiles || s.fallbackBundleFiles.length === 0) {
                                        s.fallbackBundleFiles = new Array(s.receiverManifest.files.length);
                                    }
                                    s.fallbackBundleFiles[s.receiverFileIndex] = {
                                        path: currentFile.path,
                                        chunks: [remaining.slice(0, bytesLeft)]
                                    };
                                } else {
                                    s.log("Write error. Switching to RAM...");
                                    if (!s.fallbackChunks) {
                                        s.fallbackChunks = [];
                                    }
                                    s.fallbackChunks.push(remaining.slice(0, bytesLeft));
                                }
                            }
                            try { await s.fileStreamWriter?.close(); } catch {}
                            s.fileStreamWriter = null;
                        }
                    }
                }
                s.updateProgress(s.rawBytesTransferred + bytesLeft);
            }
            if (isSelected && !s.useZipFallback && s.fileStreamWriter) {
                try {
                    await s.fileStreamWriter.close();
                } catch {}
            }
            s.fileStreamWriter = null;
            s.skipCurrentFileWrite = false; // Reset skip flag for next file
            s.receiverFileBytesWritten = 0;
            s.receiverFileIndex++;
            remaining = remaining.slice(bytesLeft);
        }
    }

    // Trailing zero-byte files check
    while (
        s.receiverFileIndex < s.receiverManifest.files.length &&
        s.receiverManifest.files[s.receiverFileIndex].size === 0
    ) {
        const isSelected = s.p2pSelectedFiles[s.receiverFileIndex] !== false;
        if (isSelected) {
            if (s.useZipFallback) {
                if (s.fallbackBundleFiles) {
                    if (!s.fallbackBundleFiles[s.receiverFileIndex]) {
                        s.fallbackBundleFiles[s.receiverFileIndex] = {
                            path: s.receiverManifest.files[s.receiverFileIndex].path,
                            chunks: []
                        };
                    }
                }
            } else if (s.receiverDirHandle) {
                try {
                    const tempWriter = await openFileInDir(
                        s.receiverDirHandle,
                        s.receiverManifest.files[s.receiverFileIndex].path
                    );
                    await tempWriter.close();
                } catch (e) {
                    console.warn("Failed to create trailing empty file in P2P:", e);
                }
            } else if (s.fileStreamWriter) {
                try {
                    await s.fileStreamWriter.close();
                } catch {}
                s.fileStreamWriter = null;
            }
        }
        s.receiverFileBytesWritten = 0;
        s.receiverFileIndex++;
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

/**
 * Join an existing P2P session as receiver.
 */
export function joinP2PSession(
    s: TransferState,
    roomId: string,
    pskHex: string,
    setupWebRTC: (roomId: string) => void,
) {
    if (!pskHex || pskHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(pskHex)) {
        s.log("UI Error: Invalid PSK format.");
        return;
    }
    s.updateProgress(0, true);
    s.peerRole = "receiver";
    s.flowState = "HANDSHAKE";
    s.psk = new Uint8Array(
        pskHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
    );

    setupWebRTC(roomId);
    s.log(`UI: Joining P2P session...`);
}
