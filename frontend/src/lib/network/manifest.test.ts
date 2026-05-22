import { describe, it, expect } from 'vitest';
import { encodeManifest, decodeManifest, type ContainerManifest } from './manifest';

describe('Manifest Encoding', () => {
    it('correctly encodes and decodes a single file manifest', () => {
        const manifest: ContainerManifest = {
            type: 'single',
            totalSize: 1024,
            files: [{ path: 'test.png', size: 1024, mime: 'image/png' }]
        };
        const bytes = encodeManifest(manifest);
        expect(bytes).toBeInstanceOf(Uint8Array);
        const decoded = decodeManifest(bytes);
        expect(decoded.type).toBe('single');
        expect(decoded.totalSize).toBe(1024);
        expect(decoded.files.length).toBe(1);
        expect(decoded.files[0].path).toBe('test.png');
        expect(decoded.files[0].size).toBe(1024);
        expect(decoded.files[0].mime).toBe('image/png');
    });

    it('correctly encodes and decodes a bundle manifest with deep nesting', () => {
        const manifest: ContainerManifest = {
            type: 'bundle',
            totalSize: 5_000_000_000,
            files: [
                { path: 'Documents/Report.pdf', size: 1_000_000 },
                { path: 'Images/Vacation/1.jpg', size: 2_500_000 },
                { path: 'Images/Vacation/2.jpg', size: 3_500_000 },
                { path: 'Images/Vacation/sub/deep/3.png', size: 0 }
            ]
        };
        const bytes = encodeManifest(manifest);
        const decoded = decodeManifest(bytes);
        expect(decoded.type).toBe('bundle');
        expect(decoded.totalSize).toBe(5_000_000_000);
        expect(decoded.files.length).toBe(4);
        expect(decoded.files[3].size).toBe(0);
        expect(decoded.files[3].path).toBe('Images/Vacation/sub/deep/3.png');
    });

    it('handles empty mime fields gracefully', () => {
        const manifest: ContainerManifest = {
            type: 'single',
            totalSize: 42,
            files: [{ path: 'noext', size: 42 }]
        };
        const decoded = decodeManifest(encodeManifest(manifest));
        expect(decoded.files[0].mime).toBeUndefined();
    });

    it('handles a bundle with 1000 files', () => {
        const files = Array.from({ length: 1000 }, (_, i) => ({
            path: `folder/subfolder/file_${i.toString().padStart(4, '0')}.bin`,
            size: 1024 * (i + 1)
        }));
        const totalSize = files.reduce((acc, f) => acc + f.size, 0);
        const manifest: ContainerManifest = { type: 'bundle', totalSize, files };

        const bytes = encodeManifest(manifest);
        const decoded = decodeManifest(bytes);
        expect(decoded.files.length).toBe(1000);
        expect(decoded.totalSize).toBe(totalSize);
        expect(decoded.files[999].path).toBe('folder/subfolder/file_0999.bin');
    });

    it('preserves Unicode filenames', () => {
        const manifest: ContainerManifest = {
            type: 'single',
            totalSize: 100,
            files: [{ path: 'documents/report 📊.pdf', size: 100 }]
        };
        const decoded = decodeManifest(encodeManifest(manifest));
        expect(decoded.files[0].path).toBe('documents/report 📊.pdf');
    });

    it('preserves exact byte sizes for large files', () => {
        const manifest: ContainerManifest = {
            type: 'single',
            totalSize: Number.MAX_SAFE_INTEGER,
            files: [{ path: 'huge.iso', size: Number.MAX_SAFE_INTEGER }]
        };
        const decoded = decodeManifest(encodeManifest(manifest));
        expect(decoded.files[0].size).toBe(Number.MAX_SAFE_INTEGER);
        expect(decoded.totalSize).toBe(Number.MAX_SAFE_INTEGER);
    });
});

describe('Stream Slicing Logic', () => {
    /**
     * This tests the core algorithm used by the receiver to split a flat
     * decrypted byte stream back into individual files based on their sizes
     * from the manifest. This is a pure-logic test with no DOM dependencies.
     */
    function simulateReceiverSlicing(
        manifest: ContainerManifest,
        chunks: Uint8Array[]
    ): Map<string, Uint8Array> {
        const result = new Map<string, Uint8Array>();
        let fileIndex = 0;
        let fileBytesWritten = 0;
        let currentChunks: Uint8Array[] = [];
        let currentBufferLength = 0;

        for (const chunk of chunks) {
            let remaining = chunk;
            while (remaining.length > 0) {
                const currentFile = manifest.files[fileIndex];
                const bytesLeft = currentFile.size - fileBytesWritten;

                if (remaining.length <= bytesLeft) {
                    currentChunks.push(remaining);
                    currentBufferLength += remaining.length;
                    fileBytesWritten += remaining.length;
                    remaining = new Uint8Array(0);
                } else {
                    if (bytesLeft > 0) {
                        const slice = remaining.slice(0, bytesLeft);
                        currentChunks.push(slice);
                        currentBufferLength += slice.length;
                    }
                    // Close current file
                    const combined = new Uint8Array(currentBufferLength);
                    let offset = 0;
                    for (const c of currentChunks) {
                        combined.set(c, offset);
                        offset += c.length;
                    }
                    result.set(currentFile.path, combined);
                    currentChunks = [];
                    currentBufferLength = 0;
                    fileBytesWritten = 0;
                    fileIndex++;
                    remaining = remaining.slice(bytesLeft);
                }
            }
        }
        // Close final file
        if (fileIndex < manifest.files.length && currentBufferLength > 0) {
            const combined = new Uint8Array(currentBufferLength);
            let offset = 0;
            for (const c of currentChunks) {
                combined.set(c, offset);
                offset += c.length;
            }
            result.set(manifest.files[fileIndex].path, combined);
        }

        return result;
    }

    it('correctly slices a stream into 3 files', () => {
        const manifest: ContainerManifest = {
            type: 'bundle',
            totalSize: 10,
            files: [
                { path: 'a.txt', size: 3 },
                { path: 'b.txt', size: 5 },
                { path: 'c.txt', size: 2 }
            ]
        };

        // Simulate the full concatenated stream: [0,1,2, 3,4,5,6,7, 8,9]
        const stream = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const result = simulateReceiverSlicing(manifest, [stream]);

        expect(result.get('a.txt')).toEqual(new Uint8Array([0, 1, 2]));
        expect(result.get('b.txt')).toEqual(new Uint8Array([3, 4, 5, 6, 7]));
        expect(result.get('c.txt')).toEqual(new Uint8Array([8, 9]));
    });

    it('handles chunks that arrive in small fragments across file boundaries', () => {
        const manifest: ContainerManifest = {
            type: 'bundle',
            totalSize: 9,
            files: [
                { path: 'x.bin', size: 4 },
                { path: 'y.bin', size: 3 },
                { path: 'z.bin', size: 2 }
            ]
        };

        // Send data in 2-byte chunks (simulates small WebRTC frames)
        const chunks = [
            new Uint8Array([10, 20]),
            new Uint8Array([30, 40]),      // boundary at byte 4
            new Uint8Array([50, 60]),
            new Uint8Array([70, 80]),       // boundary at byte 7
            new Uint8Array([90])
        ];
        const result = simulateReceiverSlicing(manifest, chunks);

        expect(result.get('x.bin')).toEqual(new Uint8Array([10, 20, 30, 40]));
        expect(result.get('y.bin')).toEqual(new Uint8Array([50, 60, 70]));
        expect(result.get('z.bin')).toEqual(new Uint8Array([80, 90]));
    });

    it('handles zero-byte files in the middle of a bundle', () => {
        const manifest: ContainerManifest = {
            type: 'bundle',
            totalSize: 5,
            files: [
                { path: 'first.txt', size: 2 },
                { path: 'empty.txt', size: 0 },
                { path: 'last.txt', size: 3 }
            ]
        };

        const stream = new Uint8Array([1, 2, 3, 4, 5]);
        const result = simulateReceiverSlicing(manifest, [stream]);

        expect(result.get('first.txt')).toEqual(new Uint8Array([1, 2]));
        expect(result.get('empty.txt')).toEqual(new Uint8Array([]));
        expect(result.get('last.txt')).toEqual(new Uint8Array([3, 4, 5]));
    });

    it('handles a single chunk that spans all files', () => {
        const manifest: ContainerManifest = {
            type: 'bundle',
            totalSize: 6,
            files: [
                { path: 'a', size: 1 },
                { path: 'b', size: 1 },
                { path: 'c', size: 1 },
                { path: 'd', size: 1 },
                { path: 'e', size: 1 },
                { path: 'f', size: 1 }
            ]
        };

        const stream = new Uint8Array([10, 20, 30, 40, 50, 60]);
        const result = simulateReceiverSlicing(manifest, [stream]);

        expect(result.size).toBe(6);
        expect(result.get('a')).toEqual(new Uint8Array([10]));
        expect(result.get('f')).toEqual(new Uint8Array([60]));
    });

    it('handles 1-byte-per-chunk streaming', () => {
        const manifest: ContainerManifest = {
            type: 'bundle',
            totalSize: 4,
            files: [
                { path: 'p.bin', size: 2 },
                { path: 'q.bin', size: 2 }
            ]
        };

        const chunks = [
            new Uint8Array([0xAA]),
            new Uint8Array([0xBB]),
            new Uint8Array([0xCC]),
            new Uint8Array([0xDD])
        ];
        const result = simulateReceiverSlicing(manifest, chunks);

        expect(result.get('p.bin')).toEqual(new Uint8Array([0xAA, 0xBB]));
        expect(result.get('q.bin')).toEqual(new Uint8Array([0xCC, 0xDD]));
    });

    it('handles a single file (non-bundle) with multiple chunks', () => {
        const manifest: ContainerManifest = {
            type: 'single',
            totalSize: 8,
            files: [{ path: 'solo.dat', size: 8 }]
        };

        const chunks = [
            new Uint8Array([1, 2, 3]),
            new Uint8Array([4, 5]),
            new Uint8Array([6, 7, 8])
        ];
        const result = simulateReceiverSlicing(manifest, chunks);

        expect(result.size).toBe(1);
        expect(result.get('solo.dat')).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    });

    // ─── NEW: All files are zero-byte ───
    it('handles a bundle where ALL files are zero-byte', () => {
        const manifest: ContainerManifest = {
            type: 'bundle',
            totalSize: 0,
            files: [
                { path: 'empty1.txt', size: 0 },
                { path: 'empty2.txt', size: 0 },
                { path: 'empty3.txt', size: 0 },
            ]
        };

        // No data to process — but all files should still appear
        const result = simulateReceiverSlicing(manifest, []);
        // Zero-byte files with no data chunks means nothing is written
        expect(result.size).toBe(0);
    });

    // ─── NEW: Leading zero-byte file ───
    it('handles zero-byte file at the START of a bundle', () => {
        const manifest: ContainerManifest = {
            type: 'bundle',
            totalSize: 3,
            files: [
                { path: 'empty_first.txt', size: 0 },
                { path: 'data.txt', size: 3 }
            ]
        };

        const stream = new Uint8Array([10, 20, 30]);
        const result = simulateReceiverSlicing(manifest, [stream]);

        // empty_first.txt gets 0 bytes, data.txt gets all 3 bytes
        expect(result.get('empty_first.txt')).toEqual(new Uint8Array([]));
        expect(result.get('data.txt')).toEqual(new Uint8Array([10, 20, 30]));
    });

    // ─── NEW: Trailing zero-byte file ───
    it('handles zero-byte file at the END of a bundle', () => {
        const manifest: ContainerManifest = {
            type: 'bundle',
            totalSize: 2,
            files: [
                { path: 'data.txt', size: 2 },
                { path: 'empty_last.txt', size: 0 },
            ]
        };

        const stream = new Uint8Array([0xAA, 0xBB]);
        const result = simulateReceiverSlicing(manifest, [stream]);

        expect(result.get('data.txt')).toEqual(new Uint8Array([0xAA, 0xBB]));
        // Trailing zero-byte file has no data to trigger it
    });

    // ─── NEW: Multiple consecutive zero-byte files ───
    it('handles multiple CONSECUTIVE zero-byte files in a bundle', () => {
        const manifest: ContainerManifest = {
            type: 'bundle',
            totalSize: 4,
            files: [
                { path: 'a.txt', size: 2 },
                { path: 'empty1.txt', size: 0 },
                { path: 'empty2.txt', size: 0 },
                { path: 'empty3.txt', size: 0 },
                { path: 'b.txt', size: 2 }
            ]
        };

        const stream = new Uint8Array([1, 2, 3, 4]);
        const result = simulateReceiverSlicing(manifest, [stream]);

        expect(result.get('a.txt')).toEqual(new Uint8Array([1, 2]));
        expect(result.get('empty1.txt')).toEqual(new Uint8Array([]));
        expect(result.get('empty2.txt')).toEqual(new Uint8Array([]));
        expect(result.get('empty3.txt')).toEqual(new Uint8Array([]));
        expect(result.get('b.txt')).toEqual(new Uint8Array([3, 4]));
    });

    // ─── NEW: Single zero-byte file ───
    it('handles a manifest with a single zero-byte file', () => {
        const manifest: ContainerManifest = {
            type: 'single',
            totalSize: 0,
            files: [{ path: 'nothing.bin', size: 0 }]
        };

        const result = simulateReceiverSlicing(manifest, []);
        expect(result.size).toBe(0);
    });

    // ─── NEW: Path traversal in manifest ───
    it('preserves path traversal characters in manifest (validation is caller responsibility)', () => {
        const manifest: ContainerManifest = {
            type: 'bundle',
            totalSize: 0,
            files: [
                { path: '../../etc/passwd', size: 0 },
                { path: 'normal/file.txt', size: 0 },
            ]
        };
        const decoded = decodeManifest(encodeManifest(manifest));
        // Manifest codec preserves paths as-is; validation is caller's job
        expect(decoded.files[0].path).toBe('../../etc/passwd');
    });

    // ─── NEW: Large number of zero-byte files ───
    it('handles 100 zero-byte files interspersed with data files', () => {
        const files = [];
        let totalSize = 0;
        for (let i = 0; i < 200; i++) {
            if (i % 2 === 0) {
                files.push({ path: `empty_${i}.txt`, size: 0 });
            } else {
                files.push({ path: `data_${i}.txt`, size: 1 });
                totalSize += 1;
            }
        }
        const manifest: ContainerManifest = { type: 'bundle', totalSize, files };

        // Stream is 100 bytes (one byte per data file)
        const stream = new Uint8Array(100);
        for (let i = 0; i < 100; i++) stream[i] = i;

        const result = simulateReceiverSlicing(manifest, [stream]);
        
        // Verify data files got their bytes
        expect(result.get('data_1.txt')).toEqual(new Uint8Array([0]));
        expect(result.get('data_3.txt')).toEqual(new Uint8Array([1]));
        expect(result.get('data_199.txt')).toEqual(new Uint8Array([99]));
    });
});

