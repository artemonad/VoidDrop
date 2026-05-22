import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for receiver engine's write queue and chunk slicing logic.
 * 
 * We replicate the pure-logic parts of writeReceiverChunk and drainReceiverWriteQueue
 * without DOM dependencies (File System Access API).
 */

// ─── Simulated Receiver State ───

interface ReceiverState {
    receiverManifest: { files: { path: string; size: number }[] } | null;
    receiverFileIndex: number;
    receiverFileBytesWritten: number;
    bytesTransferred: number;
    p2pSelectedFiles: boolean[];
    receiverWriteQueue: { data: Uint8Array; isFinal: boolean }[];
    receiverWriteInProgress: boolean;
    flowState: string;
    // Output tracking
    writtenFiles: Map<string, Uint8Array[]>;
    closedFiles: string[];
}

function createReceiverState(manifest: { files: { path: string; size: number }[] }, selectedFiles?: boolean[]): ReceiverState {
    return {
        receiverManifest: manifest,
        receiverFileIndex: 0,
        receiverFileBytesWritten: 0,
        bytesTransferred: 0,
        p2pSelectedFiles: selectedFiles ?? new Array(manifest.files.length).fill(true),
        receiverWriteQueue: [],
        receiverWriteInProgress: false,
        flowState: 'STREAMING',
        writtenFiles: new Map(),
        closedFiles: [],
    };
}

/**
 * Simulated writeReceiverChunk — mirrors receiverEngine.ts logic
 * but writes to a Map instead of the filesystem.
 */
function writeReceiverChunk(s: ReceiverState, data: Uint8Array) {
    if (!s.receiverManifest) return;

    let remaining = data;
    while (remaining.length > 0) {
        // Skip zero-byte files
        while (
            s.receiverFileIndex < s.receiverManifest.files.length &&
            s.receiverManifest.files[s.receiverFileIndex].size === 0
        ) {
            const isSelected = s.p2pSelectedFiles[s.receiverFileIndex] !== false;
            if (isSelected) {
                const path = s.receiverManifest.files[s.receiverFileIndex].path;
                s.closedFiles.push(path);
                if (!s.writtenFiles.has(path)) s.writtenFiles.set(path, []);
            }
            s.receiverFileBytesWritten = 0;
            s.receiverFileIndex++;
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

        // Ensure file entry exists in the map
        if (!s.writtenFiles.has(currentFile.path)) {
            s.writtenFiles.set(currentFile.path, []);
        }

        if (remaining.length <= bytesLeft) {
            s.writtenFiles.get(currentFile.path)!.push(new Uint8Array(remaining));
            s.receiverFileBytesWritten += remaining.length;
            s.bytesTransferred += remaining.length;
            remaining = new Uint8Array(0);
        } else {
            if (bytesLeft > 0) {
                s.writtenFiles.get(currentFile.path)!.push(new Uint8Array(remaining.slice(0, bytesLeft)));
                s.bytesTransferred += bytesLeft;
            }
            s.closedFiles.push(currentFile.path);
            s.receiverFileBytesWritten = 0;
            s.receiverFileIndex++;
            remaining = remaining.slice(bytesLeft);
        }
    }
}

/**
 * Simulated drainReceiverWriteQueue — mirrors receiverEngine.ts
 */
function drainReceiverWriteQueue(s: ReceiverState) {
    if (s.receiverWriteInProgress) return;
    s.receiverWriteInProgress = true;

    while (s.receiverWriteQueue.length > 0) {
        const item = s.receiverWriteQueue.shift()!;
        writeReceiverChunk(s, item.data);

        if (item.isFinal) {
            if (s.receiverFileIndex < (s.receiverManifest?.files.length ?? 0)) {
                const isSelected = s.p2pSelectedFiles[s.receiverFileIndex] !== false;
                if (isSelected) {
                    s.closedFiles.push(s.receiverManifest!.files[s.receiverFileIndex].path);
                }
            }
            s.flowState = 'DONE';
        }
    }

    s.receiverWriteInProgress = false;
}

/** Helper: merge all written chunks for a file into one Uint8Array */
function getFileData(s: ReceiverState, path: string): Uint8Array {
    const chunks = s.writtenFiles.get(path) ?? [];
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) {
        result.set(c, off);
        off += c.length;
    }
    return result;
}

// ═══════════════════════════════════════════════════════
// Receiver Chunk Slicing
// ═══════════════════════════════════════════════════════
describe('Receiver Engine — Chunk Slicing', () => {
    it('single file, single chunk', () => {
        const s = createReceiverState({
            files: [{ path: 'single.txt', size: 10 }],
        });

        writeReceiverChunk(s, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

        expect(s.bytesTransferred).toBe(10);
        const data = getFileData(s, 'single.txt');
        expect(data).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    });

    it('single file, multiple chunks', () => {
        const s = createReceiverState({
            files: [{ path: 'multi.bin', size: 6 }],
        });

        writeReceiverChunk(s, new Uint8Array([1, 2, 3]));
        writeReceiverChunk(s, new Uint8Array([4, 5, 6]));

        expect(s.bytesTransferred).toBe(6);
        expect(getFileData(s, 'multi.bin')).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it('bundle: chunk splits across file boundary', () => {
        const s = createReceiverState({
            files: [
                { path: 'a.txt', size: 3 },
                { path: 'b.txt', size: 5 },
                { path: 'c.txt', size: 2 },
            ],
        });

        writeReceiverChunk(s, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

        expect(getFileData(s, 'a.txt')).toEqual(new Uint8Array([0, 1, 2]));
        expect(getFileData(s, 'b.txt')).toEqual(new Uint8Array([3, 4, 5, 6, 7]));
        expect(getFileData(s, 'c.txt')).toEqual(new Uint8Array([8, 9]));
        expect(s.bytesTransferred).toBe(10);
    });

    it('bundle: small chunk delivery (byte-by-byte)', () => {
        const s = createReceiverState({
            files: [
                { path: 'x.bin', size: 3 },
                { path: 'y.bin', size: 2 },
            ],
        });

        for (const byte of [10, 20, 30, 40, 50]) {
            writeReceiverChunk(s, new Uint8Array([byte]));
        }

        expect(getFileData(s, 'x.bin')).toEqual(new Uint8Array([10, 20, 30]));
        expect(getFileData(s, 'y.bin')).toEqual(new Uint8Array([40, 50]));
    });

    it('skips zero-byte files in the middle', () => {
        const s = createReceiverState({
            files: [
                { path: 'first.txt', size: 2 },
                { path: 'empty1.txt', size: 0 },
                { path: 'empty2.txt', size: 0 },
                { path: 'last.txt', size: 3 },
            ],
        });

        writeReceiverChunk(s, new Uint8Array([1, 2, 3, 4, 5]));

        expect(getFileData(s, 'first.txt')).toEqual(new Uint8Array([1, 2]));
        expect(getFileData(s, 'last.txt')).toEqual(new Uint8Array([3, 4, 5]));
        expect(s.bytesTransferred).toBe(5);
    });

    it('skips leading zero-byte files', () => {
        const s = createReceiverState({
            files: [
                { path: 'empty.txt', size: 0 },
                { path: 'data.txt', size: 3 },
            ],
        });

        writeReceiverChunk(s, new Uint8Array([7, 8, 9]));

        expect(getFileData(s, 'data.txt')).toEqual(new Uint8Array([7, 8, 9]));
    });

    it('data integrity: large bundle reassembly', () => {
        const sizes = [100, 200, 300, 150, 250];
        const files = sizes.map((size, i) => ({
            path: `file_${i}.dat`,
            size,
        }));
        const totalSize = sizes.reduce((a, b) => a + b, 0);

        const s = createReceiverState({ files });

        // Create a stream with known pattern
        const fullStream = new Uint8Array(totalSize);
        for (let i = 0; i < totalSize; i++) fullStream[i] = i & 0xFF;

        // Deliver in irregular chunk sizes (simulating network)
        const chunkSizes = [73, 127, 91, 200, 300, 209];
        let offset = 0;
        for (const cs of chunkSizes) {
            const end = Math.min(offset + cs, totalSize);
            if (end > offset) {
                writeReceiverChunk(s, fullStream.slice(offset, end));
            }
            offset = end;
        }

        expect(s.bytesTransferred).toBe(totalSize);

        // Verify each file has correct content
        let streamOffset = 0;
        for (let i = 0; i < files.length; i++) {
            const fileData = getFileData(s, files[i].path);
            expect(fileData.length).toBe(sizes[i]);
            expect(fileData).toEqual(fullStream.slice(streamOffset, streamOffset + sizes[i]));
            streamOffset += sizes[i];
        }
    });

    it('skips deselected files in the bundle', () => {
        // Files: a.txt (size 3, selected), b.txt (size 5, DESELECTED), c.txt (size 2, selected)
        const s = createReceiverState({
            files: [
                { path: 'a.txt', size: 3 },
                { path: 'b.txt', size: 5 },
                { path: 'c.txt', size: 2 },
            ],
        }, [true, false, true]);

        // The sender skips b.txt's 5 bytes entirely.
        // It only sends a.txt's 3 bytes and c.txt's 2 bytes concatenated.
        writeReceiverChunk(s, new Uint8Array([1, 2, 3, 8, 9]));

        // a.txt should have [1, 2, 3]
        expect(getFileData(s, 'a.txt')).toEqual(new Uint8Array([1, 2, 3]));
        // b.txt should not have any written data (empty or absent in writtenFiles)
        expect(s.writtenFiles.has('b.txt')).toBe(false);
        // c.txt should have [8, 9]
        expect(getFileData(s, 'c.txt')).toEqual(new Uint8Array([8, 9]));
        // Total bytes transferred must be exactly the selected bytes: 3 + 2 = 5
        expect(s.bytesTransferred).toBe(5);
    });

    it('skips leading and trailing deselected files', () => {
        // Files: a.txt (deselected, size 2), b.txt (selected, size 3), c.txt (deselected, size 4)
        const s = createReceiverState({
            files: [
                { path: 'a.txt', size: 2 },
                { path: 'b.txt', size: 3 },
                { path: 'c.txt', size: 4 },
            ],
        }, [false, true, false]);

        // Sender skips a.txt and c.txt, only sends b.txt's 3 bytes
        writeReceiverChunk(s, new Uint8Array([10, 20, 30]));

        expect(s.writtenFiles.has('a.txt')).toBe(false);
        expect(s.writtenFiles.has('c.txt')).toBe(false);
        expect(getFileData(s, 'b.txt')).toEqual(new Uint8Array([10, 20, 30]));
        expect(s.bytesTransferred).toBe(3);
    });
});

// ═══════════════════════════════════════════════════════
// Receiver Write Queue
// ═══════════════════════════════════════════════════════
describe('Receiver Engine — Write Queue', () => {
    it('drainReceiverWriteQueue processes all items in order', () => {
        const s = createReceiverState({
            files: [{ path: 'queued.bin', size: 6 }],
        });

        s.receiverWriteQueue = [
            { data: new Uint8Array([1, 2, 3]), isFinal: false },
            { data: new Uint8Array([4, 5, 6]), isFinal: true },
        ];

        drainReceiverWriteQueue(s);

        expect(s.flowState).toBe('DONE');
        expect(s.bytesTransferred).toBe(6);
        expect(getFileData(s, 'queued.bin')).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
        expect(s.receiverWriteQueue.length).toBe(0);
    });

    it('write queue prevents re-entrant processing', () => {
        const s = createReceiverState({
            files: [{ path: 'test.bin', size: 3 }],
        });

        s.receiverWriteInProgress = true;
        s.receiverWriteQueue = [
            { data: new Uint8Array([1, 2, 3]), isFinal: true },
        ];

        drainReceiverWriteQueue(s);

        // Should not process because receiverWriteInProgress is true
        expect(s.receiverWriteQueue.length).toBe(1);
        expect(s.bytesTransferred).toBe(0);
    });

    it('resets receiverWriteInProgress after drain', () => {
        const s = createReceiverState({
            files: [{ path: 'test.bin', size: 1 }],
        });

        s.receiverWriteQueue = [
            { data: new Uint8Array([1]), isFinal: true },
        ];

        drainReceiverWriteQueue(s);

        expect(s.receiverWriteInProgress).toBe(false);
    });

    it('empty queue → no-op', () => {
        const s = createReceiverState({
            files: [{ path: 'test.bin', size: 1 }],
        });

        drainReceiverWriteQueue(s);

        expect(s.flowState).toBe('STREAMING');
        expect(s.bytesTransferred).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════
// joinP2PSession validation
// ═══════════════════════════════════════════════════════
describe('Receiver Engine — joinP2PSession validation', () => {
    // Replicate the validation logic from receiverEngine.ts
    function validatePskHex(pskHex: string): boolean {
        return !!pskHex && pskHex.length === 64 && /^[0-9a-fA-F]+$/.test(pskHex);
    }

    it('valid 64-char hex → accepted', () => {
        expect(validatePskHex('a'.repeat(64))).toBe(true);
    });

    it('empty string → rejected', () => {
        expect(validatePskHex('')).toBe(false);
    });

    it('63 chars → rejected (too short)', () => {
        expect(validatePskHex('a'.repeat(63))).toBe(false);
    });

    it('65 chars → rejected (too long)', () => {
        expect(validatePskHex('a'.repeat(65))).toBe(false);
    });

    it('non-hex characters → rejected', () => {
        expect(validatePskHex('g'.repeat(64))).toBe(false);
    });

    it('mixed case hex → accepted', () => {
        expect(validatePskHex('aAbBcCdDeEfF' + '0'.repeat(52))).toBe(true);
    });
});
