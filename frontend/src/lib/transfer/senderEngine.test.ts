import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TransferState } from './transferState.svelte';

/**
 * Tests for the sender engine's file chunking and batching logic.
 * We extract the pure-logic pushNextFileChunk into a testable form
 * by simulating TransferState and a mock worker.
 */

// ─── Simulated pushNextFileChunk (extracted from senderEngine.ts) ───
// We replicate the core batching logic without WebRTC wait loops and actual Worker

interface MockFile {
    size: number;
    data: Uint8Array;
}

interface SenderState {
    selectedFiles: { file: MockFile; path: string }[];
    currentFileIndex: number;
    fileOffset: number;
    pendingWorkerChunks: number;
    CHUNK_SIZE: number;
    MAX_INFLIGHT: number;
    chunks: { data: Uint8Array; isFinal: boolean }[];
    p2pSelectedFiles?: boolean[];
}

function createMockFile(size: number, fillByte = 0xAA): MockFile {
    const data = new Uint8Array(size);
    data.fill(fillByte);
    return {
        size,
        data,
    };
}

/**
 * Simulated pushNextFileChunk — mirrors senderEngine.ts logic
 * but uses synchronous array slicing instead of File.slice().arrayBuffer()
 */
function pushNextChunkSync(s: SenderState) {
    if (s.selectedFiles.length === 0) return;
    if (s.currentFileIndex >= s.selectedFiles.length) return;

    const parts: Uint8Array[] = [];
    let batchSize = 0;
    let isFinal = false;

    while (s.currentFileIndex < s.selectedFiles.length && batchSize < s.CHUNK_SIZE) {
        if (s.p2pSelectedFiles && s.p2pSelectedFiles[s.currentFileIndex] === false) {
            s.currentFileIndex++;
            s.fileOffset = 0;
            continue;
        }

        const currentFile = s.selectedFiles[s.currentFileIndex].file;
        const remaining = s.CHUNK_SIZE - batchSize;
        const end = Math.min(s.fileOffset + remaining, currentFile.size);
        const buffer = currentFile.data.slice(s.fileOffset, end);
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
                s.currentFileIndex++;
                break;
            }
            s.currentFileIndex++;
            s.fileOffset = 0;
        } else {
            break;
        }
    }

    if (s.currentFileIndex >= s.selectedFiles.length) {
        isFinal = true;
    }

    if (batchSize === 0 && !isFinal) return;

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
    s.chunks.push({ data: chunk, isFinal });
}

function createSenderState(files: { file: MockFile; path: string }[], chunkSize = 64 * 1024, selectedFiles?: boolean[]): SenderState {
    return {
        selectedFiles: files,
        currentFileIndex: 0,
        fileOffset: 0,
        pendingWorkerChunks: 0,
        CHUNK_SIZE: chunkSize,
        MAX_INFLIGHT: 4,
        chunks: [],
        p2pSelectedFiles: selectedFiles,
    };
}

// ═══════════════════════════════════════════════════════
// Sender Chunking Tests
// ═══════════════════════════════════════════════════════
describe('Sender Engine — File Chunking', () => {
    it('single small file → one chunk, isFinal = true', () => {
        const file = createMockFile(100, 0x42);
        const s = createSenderState([{ file, path: 'small.bin' }], 1024);

        pushNextChunkSync(s);

        expect(s.chunks.length).toBe(1);
        expect(s.chunks[0].isFinal).toBe(true);
        expect(s.chunks[0].data.length).toBe(100);
        expect(s.chunks[0].data[0]).toBe(0x42);
    });

    it('file larger than chunk size → multiple chunks', () => {
        const file = createMockFile(250, 0xBB);
        const s = createSenderState([{ file, path: 'large.bin' }], 100);

        // Push all chunks
        while (s.currentFileIndex < s.selectedFiles.length) {
            pushNextChunkSync(s);
        }

        expect(s.chunks.length).toBe(3);
        expect(s.chunks[0].data.length).toBe(100);
        expect(s.chunks[0].isFinal).toBe(false);
        expect(s.chunks[1].data.length).toBe(100);
        expect(s.chunks[1].isFinal).toBe(false);
        expect(s.chunks[2].data.length).toBe(50);
        expect(s.chunks[2].isFinal).toBe(true);
    });

    it('batching: multiple small files fit in one chunk', () => {
        const files = [
            { file: createMockFile(10, 0x01), path: 'a.txt' },
            { file: createMockFile(20, 0x02), path: 'b.txt' },
            { file: createMockFile(30, 0x03), path: 'c.txt' },
        ];
        const s = createSenderState(files, 1024);

        pushNextChunkSync(s);

        expect(s.chunks.length).toBe(1);
        expect(s.chunks[0].isFinal).toBe(true);
        expect(s.chunks[0].data.length).toBe(60);

        // Verify batched data content
        expect(s.chunks[0].data[0]).toBe(0x01);
        expect(s.chunks[0].data[10]).toBe(0x02);
        expect(s.chunks[0].data[30]).toBe(0x03);
    });

    it('batching stops at chunk size boundary', () => {
        const files = [
            { file: createMockFile(80, 0x01), path: 'a.bin' },
            { file: createMockFile(80, 0x02), path: 'b.bin' },
        ];
        const s = createSenderState(files, 100);

        // First chunk: 80 bytes of a.bin + 20 bytes of b.bin = 100
        pushNextChunkSync(s);
        expect(s.chunks[0].data.length).toBe(100);
        expect(s.chunks[0].isFinal).toBe(false);

        // Second chunk: remaining 60 bytes of b.bin
        pushNextChunkSync(s);
        expect(s.chunks[1].data.length).toBe(60);
        expect(s.chunks[1].isFinal).toBe(true);
    });

    it('zero-byte files do not produce chunks', () => {
        const files = [
        { file: createMockFile(0), path: 'empty1.txt' },
        { file: createMockFile(0), path: 'empty2.txt' },
        { file: createMockFile(10, 0xFF), path: 'data.txt' },
    ];
    const s = createSenderState(files, 1024);

    pushNextChunkSync(s);

    // Empty files are "completed" by the loop, data.txt is batched
    expect(s.chunks.length).toBe(1);
    expect(s.chunks[0].data.length).toBe(10);
    expect(s.chunks[0].isFinal).toBe(true);
});

it('file exactly equal to chunk size → one full chunk', () => {
    const file = createMockFile(100, 0xCC);
    const s = createSenderState([{ file, path: 'exact.bin' }], 100);

    pushNextChunkSync(s);

    expect(s.chunks.length).toBe(1);
    expect(s.chunks[0].data.length).toBe(100);
    expect(s.chunks[0].isFinal).toBe(true);
});

it('no files → no chunks produced', () => {
    const s = createSenderState([], 1024);
    pushNextChunkSync(s);
    expect(s.chunks.length).toBe(0);
});

it('data integrity: large file → reassembled chunks match original', () => {
    const size = 1000;
    const original = new Uint8Array(size);
    for (let i = 0; i < size; i++) original[i] = i & 0xFF;
    const file: MockFile = { size, data: original };
    const s = createSenderState([{ file, path: 'data.bin' }], 256);

    while (s.currentFileIndex < s.selectedFiles.length) {
        pushNextChunkSync(s);
    }

    // Reassemble
    const totalLen = s.chunks.reduce((sum, c) => sum + c.data.length, 0);
    expect(totalLen).toBe(size);

    const reassembled = new Uint8Array(totalLen);
    let off = 0;
    for (const c of s.chunks) {
        reassembled.set(c.data, off);
        off += c.data.length;
    }
    expect(reassembled).toEqual(original);
});

it('multiple files → reassembled chunks match concatenated originals', () => {
    const file1Data = new Uint8Array(150);
    file1Data.fill(0xAA);
    const file2Data = new Uint8Array(200);
    file2Data.fill(0xBB);

    const files = [
        { file: { size: 150, data: file1Data } as MockFile, path: 'a.bin' },
        { file: { size: 200, data: file2Data } as MockFile, path: 'b.bin' },
    ];
    const s = createSenderState(files, 100);

    while (s.currentFileIndex < s.selectedFiles.length) {
        pushNextChunkSync(s);
    }

    const totalLen = s.chunks.reduce((sum, c) => sum + c.data.length, 0);
    expect(totalLen).toBe(350);

    const reassembled = new Uint8Array(totalLen);
    let off = 0;
    for (const c of s.chunks) {
        reassembled.set(c.data, off);
        off += c.data.length;
    }

    // First 150 bytes should be 0xAA, next 200 should be 0xBB
    expect(reassembled.slice(0, 150).every(b => b === 0xAA)).toBe(true);
    expect(reassembled.slice(150, 350).every(b => b === 0xBB)).toBe(true);
});

it('last chunk has isFinal = true, all others have isFinal = false', () => {
    const file = createMockFile(300, 0x11);
    const s = createSenderState([{ file, path: 'multi.bin' }], 100);

    while (s.currentFileIndex < s.selectedFiles.length) {
        pushNextChunkSync(s);
    }

    expect(s.chunks.length).toBe(3);
    expect(s.chunks[0].isFinal).toBe(false);
    expect(s.chunks[1].isFinal).toBe(false);
    expect(s.chunks[2].isFinal).toBe(true);
});

it('pendingWorkerChunks increments for each chunk', () => {
    const file = createMockFile(300, 0x11);
    const s = createSenderState([{ file, path: 'count.bin' }], 100);

    pushNextChunkSync(s);
    expect(s.pendingWorkerChunks).toBe(1);
    pushNextChunkSync(s);
    expect(s.pendingWorkerChunks).toBe(2);
    pushNextChunkSync(s);
    expect(s.pendingWorkerChunks).toBe(3);
});

    it('skips deselected files in a bundle', () => {
        const files = [
            { file: createMockFile(3, 0x01), path: 'a.bin' },
            { file: createMockFile(5, 0x02), path: 'b.bin' },
            { file: createMockFile(2, 0x03), path: 'c.bin' },
        ];
        const s = createSenderState(files, 1024, [true, false, true]);

        pushNextChunkSync(s);

        // Should skip b.bin and only batch a.bin and c.bin.
        // Total bytes = 3 + 2 = 5.
        expect(s.chunks.length).toBe(1);
        expect(s.chunks[0].data.length).toBe(5);
        expect(s.chunks[0].data[0]).toBe(0x01);
        expect(s.chunks[0].data[2]).toBe(0x01);
        expect(s.chunks[0].data[3]).toBe(0x03);
        expect(s.chunks[0].data[4]).toBe(0x03);
        expect(s.chunks[0].isFinal).toBe(true);
    });

    it('skips leading and trailing deselected files and sets isFinal properly', () => {
        const files = [
            { file: createMockFile(2, 0x01), path: 'a.bin' },
            { file: createMockFile(3, 0x02), path: 'b.bin' },
            { file: createMockFile(4, 0x03), path: 'c.bin' },
        ];
        const s = createSenderState(files, 1024, [false, true, false]);

        pushNextChunkSync(s);

        // Should skip a.bin and c.bin, only batch b.bin.
        // Total bytes = 3.
        expect(s.chunks.length).toBe(1);
        expect(s.chunks[0].data.length).toBe(3);
        expect(s.chunks[0].data.every(b => b === 0x02)).toBe(true);
        expect(s.chunks[0].isFinal).toBe(true);
    });
});
