import { describe, it, expect } from 'vitest';

/**
 * Tests for WebRTC DataChannel frame protocol and signaling logic.
 * 
 * Frame format (Control Channel):
 *   [1 byte type][N bytes payload]
 * 
 * Data Channel:
 *   Raw encrypted bytes (type is implicitly 0x04)
 * 
 * Control frame types:
 *   0x01 - PQC Public Key
 *   0x02 - PQC Ciphertext
 *   0x03 - Container Header + Manifest
 *   0x05 - Receiver Ready (start streaming)
 *   0x06 - Stream End (legacy, now no-op)
 *   0x07 - Receiver ACK (download complete, verified)
 */

// ─── Frame Encoding (mirrors WebRTCConnection.sendFrame) ───
function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = type;
    frame.set(payload, 1);
    return frame;
}

// ─── Frame Decoding (mirrors dcControl.onmessage) ───
function decodeFrame(buffer: Uint8Array): { type: number; payload: Uint8Array } | null {
    if (buffer.length < 1) return null;
    return {
        type: buffer[0],
        payload: buffer.slice(1),
    };
}

describe('WebRTC Frame Protocol', () => {
    it('encode → decode roundtrip preserves type and payload', () => {
        const payload = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
        const frame = encodeFrame(0x03, payload);
        const decoded = decodeFrame(frame);

        expect(decoded).not.toBeNull();
        expect(decoded!.type).toBe(0x03);
        expect(decoded!.payload).toEqual(payload);
    });

    it('all control frame types are distinct', () => {
        const types = [0x01, 0x02, 0x03, 0x05, 0x06, 0x07];
        const uniqueTypes = new Set(types);
        expect(uniqueTypes.size).toBe(types.length);
    });

    it('empty payload frame', () => {
        const frame = encodeFrame(0x05, new Uint8Array([]));
        expect(frame.length).toBe(1);

        const decoded = decodeFrame(frame);
        expect(decoded!.type).toBe(0x05);
        expect(decoded!.payload.length).toBe(0);
    });

    it('receiver ready (0x05) frame format', () => {
        const frame = encodeFrame(0x05, new Uint8Array([1]));
        expect(frame.length).toBe(2);
        expect(frame[0]).toBe(0x05);
        expect(frame[1]).toBe(1);
    });

    it('receiver ACK (0x07) frame format', () => {
        const frame = encodeFrame(0x07, new Uint8Array([1]));
        expect(frame[0]).toBe(0x07);
    });

    it('large payload (simulating manifest)', () => {
        const payload = new Uint8Array(50000);
        for (let i = 0; i < payload.length; i++) payload[i] = i & 0xFF;

        const frame = encodeFrame(0x03, payload);
        expect(frame.length).toBe(50001);

        const decoded = decodeFrame(frame);
        expect(decoded!.type).toBe(0x03);
        expect(decoded!.payload.length).toBe(50000);
        expect(decoded!.payload).toEqual(payload);
    });

    it('buffer too short (< 1 byte) → null', () => {
        expect(decodeFrame(new Uint8Array(0))).toBeNull();
    });

    it('1-byte frame (type only, no payload)', () => {
        const frame = new Uint8Array([0x07]);
        const decoded = decodeFrame(frame);
        expect(decoded!.type).toBe(0x07);
        expect(decoded!.payload.length).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════
// Global Header (26 bytes) format
// ═══════════════════════════════════════════════════════
describe('Global Header Format', () => {
    function buildGlobalHeader(manifestCiphertextLen: number, isOffline = false): Uint8Array {
        const header = new Uint8Array(26);
        const view = new DataView(header.buffer);
        const magic = new TextEncoder().encode("VDDP01\0\0");
        header.set(magic, 0);
        view.setUint16(8, 1, true);  // version
        view.setUint16(10, isOffline ? 1 : 0, true);  // flags
        view.setUint16(12, 1, true); // cipher suite (XChaCha20)
        view.setUint32(14, 16777216, true); // segment size (16MB)
        view.setUint32(18, 32768, true);    // max frame
        view.setUint32(22, manifestCiphertextLen, true);
        return header;
    }

    function parseGlobalHeader(header: Uint8Array) {
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        const magic = new TextDecoder().decode(header.slice(0, 8));
        return {
            magic,
            version: view.getUint16(8, true),
            flags: view.getUint16(10, true),
            cipherSuite: view.getUint16(12, true),
            segmentSize: view.getUint32(14, true),
            maxFrame: view.getUint32(18, true),
            manifestLen: view.getUint32(22, true),
        };
    }

    it('header is exactly 26 bytes', () => {
        const header = buildGlobalHeader(1000);
        expect(header.length).toBe(26);
    });

    it('magic bytes are VDDP01\\0\\0', () => {
        const header = buildGlobalHeader(0);
        const magic = new TextDecoder().decode(header.slice(0, 6));
        expect(magic).toBe('VDDP01');
        expect(header[6]).toBe(0);
        expect(header[7]).toBe(0);
    });

    it('version is 1', () => {
        const parsed = parseGlobalHeader(buildGlobalHeader(0));
        expect(parsed.version).toBe(1);
    });

    it('offline flag = 1 when isOffline = true', () => {
        const p2p = parseGlobalHeader(buildGlobalHeader(0, false));
        const offline = parseGlobalHeader(buildGlobalHeader(0, true));
        expect(p2p.flags).toBe(0);
        expect(offline.flags).toBe(1);
    });

    it('cipher suite = 1 (XChaCha20-Poly1305)', () => {
        const parsed = parseGlobalHeader(buildGlobalHeader(0));
        expect(parsed.cipherSuite).toBe(1);
    });

    it('segment size = 16MB', () => {
        const parsed = parseGlobalHeader(buildGlobalHeader(0));
        expect(parsed.segmentSize).toBe(16 * 1024 * 1024);
    });

    it('manifest length is correctly stored', () => {
        const parsed = parseGlobalHeader(buildGlobalHeader(12345));
        expect(parsed.manifestLen).toBe(12345);
    });

    it('large manifest length (max u32)', () => {
        const parsed = parseGlobalHeader(buildGlobalHeader(0xFFFFFFFF));
        expect(parsed.manifestLen).toBe(0xFFFFFFFF);
    });

    it('build → parse roundtrip preserves all fields', () => {
        const header = buildGlobalHeader(99999, true);
        const parsed = parseGlobalHeader(header);

        expect(parsed.magic.startsWith('VDDP01')).toBe(true);
        expect(parsed.version).toBe(1);
        expect(parsed.flags).toBe(1);
        expect(parsed.cipherSuite).toBe(1);
        expect(parsed.segmentSize).toBe(16777216);
        expect(parsed.maxFrame).toBe(32768);
        expect(parsed.manifestLen).toBe(99999);
    });
});

// ═══════════════════════════════════════════════════════
// ICE Server Configuration  
// ═══════════════════════════════════════════════════════
describe('ICE Server Configuration Logic', () => {
    // Mirror the logic from webrtc.ts constructor
    function buildIceServers(turnUrl?: string, turnUser?: string, turnCred?: string): RTCIceServer[] {
        const iceServers: RTCIceServer[] = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ];

        if (turnUrl && turnUser && turnCred) {
            iceServers.push({
                urls: turnUrl,
                username: turnUser,
                credential: turnCred,
            });
            iceServers.push({
                urls: turnUrl + '?transport=tcp',
                username: turnUser,
                credential: turnCred,
            });
        }

        return iceServers;
    }

    it('without TURN → only 2 STUN servers', () => {
        const servers = buildIceServers();
        expect(servers.length).toBe(2);
        expect(servers[0].urls).toContain('stun');
        expect(servers[1].urls).toContain('stun');
    });

    it('with TURN → 4 servers (2 STUN + 1 UDP TURN + 1 TCP TURN)', () => {
        const servers = buildIceServers('turn:turn.example.com:3478', 'user', 'pass');
        expect(servers.length).toBe(4);
        expect(servers[2].urls).toBe('turn:turn.example.com:3478');
        expect(servers[2].username).toBe('user');
        expect(servers[2].credential).toBe('pass');
    });

    it('TCP TURN fallback has ?transport=tcp suffix', () => {
        const servers = buildIceServers('turn:turn.example.com:3478', 'user', 'pass');
        expect(servers[3].urls).toBe('turn:turn.example.com:3478?transport=tcp');
    });

    it('partial TURN config (missing credential) → no TURN', () => {
        const servers = buildIceServers('turn:turn.example.com:3478', 'user', undefined);
        expect(servers.length).toBe(2);
    });
});

// ═══════════════════════════════════════════════════════
// WebSocket URL derivation
// ═══════════════════════════════════════════════════════
describe('WebSocket URL Derivation', () => {
    function deriveWsUrl(apiBase: string, roomId: string): string {
        const wsBase = apiBase.replace('https://', 'wss://').replace('http://', 'ws://');
        return `${wsBase}/ws/${roomId}`;
    }

    it('https → wss', () => {
        expect(deriveWsUrl('https://api.example.com', 'room1'))
            .toBe('wss://api.example.com/ws/room1');
    });

    it('http → ws', () => {
        expect(deriveWsUrl('http://localhost:3000', 'test-room'))
            .toBe('ws://localhost:3000/ws/test-room');
    });

    it('preserves port numbers', () => {
        expect(deriveWsUrl('https://api.example.com:8443', 'r'))
            .toBe('wss://api.example.com:8443/ws/r');
    });

    it('preserves room ID with UUID format', () => {
        const uuid = '550e8400-e29b-41d4-a716-446655440000';
        expect(deriveWsUrl('https://api.example.com', uuid))
            .toBe(`wss://api.example.com/ws/${uuid}`);
    });
});

// ═══════════════════════════════════════════════════════
// Split Manifest Chunking
// ═══════════════════════════════════════════════════════
describe('Split Manifest Chunking', () => {
    it('chunking and accumulation roundtrip', () => {
        // Simulating 300KB manifest
        const originalManifest = new Uint8Array(300 * 1024);
        for (let i = 0; i < originalManifest.length; i++) {
            originalManifest[i] = i & 0xFF;
        }

        const totalSize = originalManifest.length;
        const CHUNK_LIMIT = 64 * 1024; // 64KB

        // Sender chunking logic
        const chunkedBuffer = new Uint8Array(4 + totalSize);
        const view = new DataView(chunkedBuffer.buffer);
        view.setUint32(0, totalSize, true);
        chunkedBuffer.set(originalManifest, 4);

        const chunks: Uint8Array[] = [];
        for (let offset = 0; offset < chunkedBuffer.length; offset += CHUNK_LIMIT) {
            chunks.push(chunkedBuffer.slice(offset, offset + CHUNK_LIMIT));
        }

        // Receiver accumulator simulation
        let manifestAccumulator: Uint8Array | null = null;
        let expectedManifestSize = 0;
        let manifestAccumulatorOffset = 0;

        for (const chunk of chunks) {
            const data = chunk; // in onFrame data is payload
            if (expectedManifestSize === 0) {
                const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
                expectedManifestSize = view.getUint32(0, true);
                manifestAccumulator = new Uint8Array(expectedManifestSize);
                manifestAccumulatorOffset = 0;

                const rest = data.slice(4);
                manifestAccumulator.set(rest, manifestAccumulatorOffset);
                manifestAccumulatorOffset += rest.length;
            } else {
                if (manifestAccumulator) {
                    manifestAccumulator.set(data, manifestAccumulatorOffset);
                    manifestAccumulatorOffset += data.length;
                }
            }
        }

        expect(expectedManifestSize).toBe(totalSize);
        expect(manifestAccumulatorOffset).toBe(totalSize);
        expect(manifestAccumulator).not.toBeNull();
        expect(manifestAccumulator).toEqual(originalManifest);
    });
});

describe('Signal Message Sequence Verification', () => {
    it('discards signals with out-of-order or duplicate sequence numbers', () => {
        const lastSeenSequence = new Map<string, number>();
        const peerSid = 'peer-123';

        const shouldAcceptSignal = (msg: { sid: string; seq: number }) => {
            const lastSeq = lastSeenSequence.get(msg.sid) ?? 0;
            if (msg.seq <= lastSeq) {
                return false;
            }
            lastSeenSequence.set(msg.sid, msg.seq);
            return true;
        };

        expect(shouldAcceptSignal({ sid: peerSid, seq: 1 })).toBe(true);
        expect(lastSeenSequence.get(peerSid)).toBe(1);

        expect(shouldAcceptSignal({ sid: peerSid, seq: 1 })).toBe(false);

        expect(shouldAcceptSignal({ sid: peerSid, seq: 0 })).toBe(false);

        expect(shouldAcceptSignal({ sid: peerSid, seq: 3 })).toBe(true);
        expect(lastSeenSequence.get(peerSid)).toBe(3);

        expect(shouldAcceptSignal({ sid: peerSid, seq: 2 })).toBe(false);
    });
});


