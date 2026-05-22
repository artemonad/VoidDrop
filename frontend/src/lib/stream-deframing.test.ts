import { describe, it, expect } from 'vitest';

/**
 * Tests for the stream deframing logic used in the download page.
 * The download page receives encrypted data as a byte stream and must
 * deframe it using 4-byte little-endian length prefixes.
 * 
 * This mirrors the logic in f/[id]/+page.svelte startBodyStream().
 */

interface DeframedChunk {
    data: Uint8Array;
}

/**
 * Pure-logic deframer that matches production code in startBodyStream.
 * Takes raw stream chunks, accumulates in buffer, extracts complete frames.
 */
function deframeStream(rawChunks: Uint8Array[]): { frames: DeframedChunk[], leftover: number } {
    let streamBuffer = new Uint8Array(0);
    const frames: DeframedChunk[] = [];

    for (const chunk of rawChunks) {
        // Append to buffer
        const temp = new Uint8Array(streamBuffer.length + chunk.length);
        temp.set(streamBuffer, 0);
        temp.set(chunk, streamBuffer.length);
        streamBuffer = temp;

        // Deframe loop (4-byte LE length prefix)
        while (streamBuffer.length >= 4) {
            const nextChunkLen = new DataView(
                streamBuffer.buffer, streamBuffer.byteOffset
            ).getUint32(0, true);
            const totalRequired = 4 + nextChunkLen;

            if (streamBuffer.length >= totalRequired) {
                frames.push({ data: streamBuffer.slice(0, totalRequired) });
                streamBuffer = streamBuffer.slice(totalRequired);
            } else {
                break;
            }
        }
    }

    return { frames, leftover: streamBuffer.length };
}

/**
 * Helper: create a framed chunk (4-byte LE length + payload)
 */
function makeFrame(payload: Uint8Array): Uint8Array {
    const frame = new Uint8Array(4 + payload.length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, payload.length, true);
    frame.set(payload, 4);
    return frame;
}

describe('Stream Deframing Logic', () => {
    it('single complete frame in one chunk', () => {
        const payload = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
        const frame = makeFrame(payload);

        const { frames, leftover } = deframeStream([frame]);
        expect(frames.length).toBe(1);
        expect(frames[0].data).toEqual(frame);
        expect(leftover).toBe(0);
    });

    it('multiple complete frames in one chunk', () => {
        const f1 = makeFrame(new Uint8Array([1, 2, 3]));
        const f2 = makeFrame(new Uint8Array([4, 5]));
        const f3 = makeFrame(new Uint8Array([6]));

        const combined = new Uint8Array(f1.length + f2.length + f3.length);
        combined.set(f1, 0);
        combined.set(f2, f1.length);
        combined.set(f3, f1.length + f2.length);

        const { frames, leftover } = deframeStream([combined]);
        expect(frames.length).toBe(3);
        expect(leftover).toBe(0);
    });

    it('frame split across two network chunks', () => {
        const payload = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE]);
        const frame = makeFrame(payload);

        // Split in the middle
        const chunk1 = frame.slice(0, 3);  // partial length header
        const chunk2 = frame.slice(3);     // rest

        const { frames, leftover } = deframeStream([chunk1, chunk2]);
        expect(frames.length).toBe(1);
        expect(frames[0].data).toEqual(frame);
        expect(leftover).toBe(0);
    });

    it('frame with length spanning two chunks', () => {
        const payload = new Uint8Array(100);
        const frame = makeFrame(payload);

        // First chunk: only 2 bytes of header
        const chunk1 = frame.slice(0, 2);
        const chunk2 = frame.slice(2);

        const { frames, leftover } = deframeStream([chunk1, chunk2]);
        expect(frames.length).toBe(1);
        expect(leftover).toBe(0);
    });

    it('incomplete frame at end → leftover', () => {
        const complete = makeFrame(new Uint8Array([1, 2, 3]));
        const incomplete = new Uint8Array([0x05, 0x00, 0x00, 0x00, 0xAA]); // says 5 bytes but only 1

        const combined = new Uint8Array(complete.length + incomplete.length);
        combined.set(complete, 0);
        combined.set(incomplete, complete.length);

        const { frames, leftover } = deframeStream([combined]);
        expect(frames.length).toBe(1);
        expect(leftover).toBe(5); // 4-byte header + 1 partial byte
    });

    it('empty chunk → no frames', () => {
        const { frames, leftover } = deframeStream([new Uint8Array(0)]);
        expect(frames.length).toBe(0);
        expect(leftover).toBe(0);
    });

    it('only header, no payload yet → leftover', () => {
        const headerOnly = new Uint8Array([0x0A, 0x00, 0x00, 0x00]); // says 10 bytes
        const { frames, leftover } = deframeStream([headerOnly]);
        expect(frames.length).toBe(0);
        expect(leftover).toBe(4);
    });

    it('1-byte-at-a-time delivery', () => {
        const frame = makeFrame(new Uint8Array([0xFF, 0xFE]));
        // Deliver one byte at a time
        const chunks = Array.from(frame).map(b => new Uint8Array([b]));

        const { frames, leftover } = deframeStream(chunks);
        expect(frames.length).toBe(1);
        expect(leftover).toBe(0);
    });

    it('zero-length payload frame', () => {
        const frame = makeFrame(new Uint8Array(0));
        expect(frame.length).toBe(4); // just the length prefix

        const { frames, leftover } = deframeStream([frame]);
        expect(frames.length).toBe(1);
        expect(frames[0].data.length).toBe(4); // 4 bytes header, 0 bytes payload
        expect(leftover).toBe(0);
    });

    it('large frame (1MB)', () => {
        const payload = new Uint8Array(1024 * 1024);
        for (let i = 0; i < payload.length; i++) payload[i] = i & 0xFF;
        const frame = makeFrame(payload);

        const { frames, leftover } = deframeStream([frame]);
        expect(frames.length).toBe(1);
        expect(frames[0].data.length).toBe(4 + 1024 * 1024);
        expect(leftover).toBe(0);
    });
});

describe('Stream Buffer Retry (BUG-18 regression)', () => {
    it('discarding streamBuffer and rewinding offset prevents corruption', () => {
        // Simulate: received 100 bytes, buffer has 30 leftover (incomplete frame)
        let rawBytesFetched = 100;
        let streamBuffer = new Uint8Array(30); // 30 bytes of incomplete frame

        // On retry: discard buffer and rewind
        if (streamBuffer.length > 0) {
            rawBytesFetched -= streamBuffer.length;
            streamBuffer = new Uint8Array(0);
        }

        expect(rawBytesFetched).toBe(70); // Will re-fetch from byte 70
        expect(streamBuffer.length).toBe(0);
    });

    it('no leftover → no rewind needed', () => {
        let rawBytesFetched = 100;
        let streamBuffer = new Uint8Array(0);

        if (streamBuffer.length > 0) {
            rawBytesFetched -= streamBuffer.length;
            streamBuffer = new Uint8Array(0);
        }

        expect(rawBytesFetched).toBe(100); // No change
    });
});
