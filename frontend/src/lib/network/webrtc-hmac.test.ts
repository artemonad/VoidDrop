import { describe, it, expect, beforeAll } from 'vitest';
import { encode, decode } from 'cbor-x';

/**
 * Tests for the WebRTC signaling HMAC sign/verify logic.
 * This mirrors the WebRTCConnection.sendSignal / verifyAndDecodeSignal methods
 * but in a testable pure-function form.
 */

async function deriveHmacKey(psk: Uint8Array): Promise<CryptoKey> {
    const keyMaterial = await crypto.subtle.importKey(
        "raw", psk as BufferSource, "HKDF", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(), // matches production code (BUG-26 noted)
            info: new TextEncoder().encode("signaling-mac"),
        },
        keyMaterial,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"]
    );
}

async function signSignal(key: CryptoKey, msg: any): Promise<Uint8Array> {
    const payload = new Uint8Array(encode(msg));
    const macBuffer = await crypto.subtle.sign("HMAC", key, payload);
    const mac = new Uint8Array(macBuffer);

    const packet = new Uint8Array(32 + payload.length);
    packet.set(mac, 0);
    packet.set(payload, 32);
    return packet;
}

async function verifySignal(key: CryptoKey, packet: Uint8Array): Promise<any | null> {
    if (packet.length < 32) return null;

    const mac = packet.slice(0, 32);
    const payload = packet.slice(32);

    const isValid = await crypto.subtle.verify("HMAC", key, mac, payload);
    if (!isValid) return null;

    return decode(payload);
}

describe('WebRTC Signaling HMAC', () => {
    it('sign + verify roundtrip succeeds', async () => {
        const psk = new Uint8Array(32);
        crypto.getRandomValues(psk);
        const key = await deriveHmacKey(psk);

        const msg = { type: 'offer', payload: { sdp: 'v=0...' }, sid: 'test-uuid-123' };
        const packet = await signSignal(key, msg);
        const result = await verifySignal(key, packet);

        expect(result).not.toBeNull();
        expect(result.type).toBe('offer');
        expect(result.sid).toBe('test-uuid-123');
    });

    it('tampered payload → verification fails', async () => {
        const psk = new Uint8Array(32);
        crypto.getRandomValues(psk);
        const key = await deriveHmacKey(psk);

        const msg = { type: 'offer', payload: { sdp: 'original' }, sid: 'abc' };
        const packet = await signSignal(key, msg);

        // Tamper with payload (byte 33 = first byte of CBOR)
        packet[33] ^= 0xFF;

        const result = await verifySignal(key, packet);
        expect(result).toBeNull();
    });

    it('truncated packet (< 32 bytes) → null', async () => {
        const psk = new Uint8Array(32);
        crypto.getRandomValues(psk);
        const key = await deriveHmacKey(psk);

        const result = await verifySignal(key, new Uint8Array(16));
        expect(result).toBeNull();
    });

    it('different PSK → verification fails', async () => {
        const psk1 = new Uint8Array(32);
        crypto.getRandomValues(psk1);
        const psk2 = new Uint8Array(32);
        crypto.getRandomValues(psk2);

        const key1 = await deriveHmacKey(psk1);
        const key2 = await deriveHmacKey(psk2);

        const msg = { type: 'answer', payload: {}, sid: 'x' };
        const packet = await signSignal(key1, msg);

        // Verify with wrong key
        const result = await verifySignal(key2, packet);
        expect(result).toBeNull();
    });

    it('same PSK → same HMAC key (deterministic)', async () => {
        const psk = new Uint8Array(32);
        crypto.getRandomValues(psk);

        const key1 = await deriveHmacKey(psk);
        const key2 = await deriveHmacKey(psk);

        const msg = { type: 'ice', payload: { candidate: 'a=...' }, sid: 'z' };
        const packet1 = await signSignal(key1, msg);
        const packet2 = await signSignal(key2, msg);

        // MACs should be identical
        expect(packet1.slice(0, 32)).toEqual(packet2.slice(0, 32));
    });

    it('empty payload is still signed correctly', async () => {
        const psk = new Uint8Array(32);
        crypto.getRandomValues(psk);
        const key = await deriveHmacKey(psk);

        const msg = {};
        const packet = await signSignal(key, msg);
        const result = await verifySignal(key, packet);

        expect(result).not.toBeNull();
        expect(result).toEqual({});
    });

    it('large payload (simulating SDP) roundtrips correctly', async () => {
        const psk = new Uint8Array(32);
        crypto.getRandomValues(psk);
        const key = await deriveHmacKey(psk);

        const largeSdp = 'v=0\r\n' + 'a=candidate:'.repeat(500);
        const msg = { type: 'offer', payload: { type: 'offer', sdp: largeSdp }, sid: 'big-test' };
        const packet = await signSignal(key, msg);
        const result = await verifySignal(key, packet);

        expect(result).not.toBeNull();
        expect(result.payload.sdp).toBe(largeSdp);
    });
});
