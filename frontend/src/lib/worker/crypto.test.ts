import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { encode, decode } from 'cbor-x';

/**
 * Helper: derive offline keys (mirrors crypto.worker.ts deriveOfflineKeys)
 */
async function deriveOfflineKeys(psk: Uint8Array, fileId: string) {
    const contextStr = new TextEncoder().encode(`voiddrop-v1-offline-${fileId}`);
    const salt = await crypto.subtle.digest("SHA-256", contextStr);

    const keyMaterial = await crypto.subtle.importKey(
        "raw", psk.buffer as ArrayBuffer, "HKDF", false, ["deriveBits"]
    );

    const manifestBits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("manifest") },
        keyMaterial, 256
    );

    const segBaseBits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("s3-seg-base") },
        keyMaterial, 256
    );

    return {
        manifestKey: new Uint8Array(manifestBits),
        segBaseKey: new Uint8Array(segBaseBits),
    };
}

/**
 * Helper: derive P2P keys (mirrors crypto.worker.ts deriveKeys)
 */
async function deriveP2PKeys(psk: Uint8Array, sharedSecretPqc: Uint8Array, sharedSecretX25519?: Uint8Array) {
    let ikm: Uint8Array;
    if (sharedSecretX25519) {
        ikm = new Uint8Array(psk.length + sharedSecretPqc.length + sharedSecretX25519.length);
        ikm.set(psk, 0);
        ikm.set(sharedSecretPqc, psk.length);
        ikm.set(sharedSecretX25519, psk.length + sharedSecretPqc.length);
    } else {
        ikm = new Uint8Array(psk.length + sharedSecretPqc.length);
        ikm.set(psk, 0);
        ikm.set(sharedSecretPqc, psk.length);
    }

    const contextStr = new TextEncoder().encode("voiddrop-v1");
    const salt = await crypto.subtle.digest("SHA-256", contextStr);

    const keyMaterial = await crypto.subtle.importKey(
        "raw", ikm.buffer as ArrayBuffer, "HKDF", false, ["deriveBits"]
    );

    const manifestBits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("manifest") },
        keyMaterial, 256
    );

    const segBaseBits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("p2p-seg-base") },
        keyMaterial, 256
    );

    return {
        manifestKey: new Uint8Array(manifestBits),
        segBaseKey: new Uint8Array(segBaseBits),
    };
}

/**
 * Helper: build the 26-byte Global Header (mirrors crypto.worker.ts)
 */
function buildGlobalHeader(manifestCiphertextLen: number, isOffline = false): Uint8Array {
    const header = new Uint8Array(26);
    const view = new DataView(header.buffer);
    const magic = new TextEncoder().encode("VDDP01\0\0");
    header.set(magic, 0);
    view.setUint16(8, 1, true);  // v1
    view.setUint16(10, isOffline ? 1 : 0, true);  // flags
    view.setUint16(12, 1, true); // XChaCha20
    view.setUint32(14, 16777216, true); // seg size
    view.setUint32(18, 32768, true);    // max frame
    view.setUint32(22, manifestCiphertextLen, true);
    return header;
}

describe('Crypto Operations (Simulated Worker Logic)', () => {
    beforeAll(async () => {
        await sodium.ready;
    });

    // ─── EXISTING: Basic roundtrip ───
    it('should complete a full XChaCha20-Poly1305 roundtrip', async () => {
        const psk = new Uint8Array(32);
        crypto.getRandomValues(psk);

        const keys = await deriveOfflineKeys(psk, 'test-file-id');

        const mockManifest = { version: 1, files: [{ path: "secret.txt", size: 100 }], type: "bundle" };
        const manifestPlain = encode(mockManifest);
        const nonce = new Uint8Array(24);

        const manifestCiphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            manifestPlain, null, null, nonce, keys.manifestKey
        );

        const initPush = sodium.crypto_secretstream_xchacha20poly1305_init_push(keys.segBaseKey);
        const originalChunk = new TextEncoder().encode("This is a highly secret chunk of data");
        const ctChunk = sodium.crypto_secretstream_xchacha20poly1305_push(
            initPush.state, originalChunk, null, sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
        );

        const decryptedPlain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            null, manifestCiphertext, null, nonce, keys.manifestKey
        );
        expect(decode(decryptedPlain)).toEqual(mockManifest);

        const decryptState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(initPush.header, keys.segBaseKey);
        const result = sodium.crypto_secretstream_xchacha20poly1305_pull(decryptState, ctChunk, null);
        expect(result).not.toBe(false);
        if (result !== false) {
            expect(new TextDecoder().decode(result.message)).toBe("This is a highly secret chunk of data");
        }
    });

    // ─── NEW: Different fileId produces different keys ───
    it('offline key derivation: different fileId → different keys', async () => {
        const psk = new Uint8Array(32);
        crypto.getRandomValues(psk);

        const keys1 = await deriveOfflineKeys(psk, 'file-a');
        const keys2 = await deriveOfflineKeys(psk, 'file-b');

        expect(keys1.manifestKey).not.toEqual(keys2.manifestKey);
        expect(keys1.segBaseKey).not.toEqual(keys2.segBaseKey);
    });

    // ─── NEW: Same fileId + same PSK → deterministic keys ───
    it('offline key derivation: same inputs → same keys', async () => {
        const psk = new Uint8Array(32);
        crypto.getRandomValues(psk);

        const keys1 = await deriveOfflineKeys(psk, 'same-file');
        const keys2 = await deriveOfflineKeys(psk, 'same-file');

        expect(keys1.manifestKey).toEqual(keys2.manifestKey);
        expect(keys1.segBaseKey).toEqual(keys2.segBaseKey);
    });

    // ─── NEW: P2P key derivation with X25519 shared secret ───
    it('P2P key derivation includes X25519 shared secret in IKM', async () => {
        const psk = new Uint8Array(32);
        crypto.getRandomValues(psk);
        const sharedPqc = new Uint8Array(32);
        crypto.getRandomValues(sharedPqc);
        const sharedX25519 = new Uint8Array(32);
        crypto.getRandomValues(sharedX25519);

        const keysWithX = await deriveP2PKeys(psk, sharedPqc, sharedX25519);
        const keysWithout = await deriveP2PKeys(psk, sharedPqc);

        // Adding X25519 shared secret must change derived keys
        expect(keysWithX.manifestKey).not.toEqual(keysWithout.manifestKey);
        expect(keysWithX.segBaseKey).not.toEqual(keysWithout.segBaseKey);
    });

    // ─── NEW: AAD binding — manifest encrypted with wrong header decrypts to failure ───
    it('manifest encryption with AAD: wrong header → decryption fails', async () => {
        const psk = new Uint8Array(32);
        crypto.getRandomValues(psk);
        const keys = await deriveOfflineKeys(psk, 'aad-test');

        const manifest = encode({ test: true });
        const nonce = new Uint8Array(24);
        const header = buildGlobalHeader(manifest.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);

        // Encrypt with correct header as AAD
        const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            manifest, header, null, nonce, keys.manifestKey
        );

        // Decrypt with correct AAD — should succeed
        const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            null, ct, header, nonce, keys.manifestKey
        );
        expect(decode(pt)).toEqual({ test: true });

        // Tamper with header (change version byte)
        const tamperedHeader = new Uint8Array(header);
        tamperedHeader[8] = 99;

        // Decrypt with tampered AAD — should throw
        expect(() => {
            sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                null, ct, tamperedHeader, nonce, keys.manifestKey
            );
        }).toThrow();
    });

    // ─── NEW: TAG_FINAL enforcement ───
    it('TAG_FINAL on last chunk is verifiable', async () => {
        const key = new Uint8Array(32);
        crypto.getRandomValues(key);

        const initPush = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
        const state = initPush.state;

        // Encrypt chunk 1 with TAG_MESSAGE
        const ct1 = sodium.crypto_secretstream_xchacha20poly1305_push(
            state, new TextEncoder().encode("chunk1"), null,
            sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
        );

        // Encrypt chunk 2 with TAG_FINAL
        const ct2 = sodium.crypto_secretstream_xchacha20poly1305_push(
            state, new TextEncoder().encode("chunk2"), null,
            sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
        );

        // Decrypt and verify tags
        const pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(initPush.header, key);

        const r1 = sodium.crypto_secretstream_xchacha20poly1305_pull(pullState, ct1, null);
        expect(r1).not.toBe(false);
        if (r1 !== false) {
            expect(r1.tag).toBe(sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE);
        }

        const r2 = sodium.crypto_secretstream_xchacha20poly1305_pull(pullState, ct2, null);
        expect(r2).not.toBe(false);
        if (r2 !== false) {
            expect(r2.tag).toBe(sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL);
        }
    });

    // ─── NEW: Missing TAG_FINAL detection (truncation attack) ───
    it('stream without TAG_FINAL is detectable as truncation', async () => {
        const key = new Uint8Array(32);
        crypto.getRandomValues(key);

        const initPush = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);

        // Only send TAG_MESSAGE chunks (no TAG_FINAL)
        const ct1 = sodium.crypto_secretstream_xchacha20poly1305_push(
            initPush.state, new TextEncoder().encode("data"), null,
            sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
        );

        const pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(initPush.header, key);
        const r1 = sodium.crypto_secretstream_xchacha20poly1305_pull(pullState, ct1, null);
        expect(r1).not.toBe(false);

        // After processing all chunks, the last tag should NOT be TAG_FINAL
        if (r1 !== false) {
            expect(r1.tag).not.toBe(sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL);
            // This is what crypto.worker.ts STREAM_DONE handler checks
        }
    });

    // ─── NEW: Multi-chunk stream roundtrip ───
    it('multi-chunk stream: 5 chunks encrypt → decrypt with data integrity', async () => {
        const key = new Uint8Array(32);
        crypto.getRandomValues(key);

        const chunks = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
        const initPush = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);

        // Encrypt all chunks
        const ciphertexts: Uint8Array[] = [];
        for (let i = 0; i < chunks.length; i++) {
            const tag = (i === chunks.length - 1)
                ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
                : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
            ciphertexts.push(
                sodium.crypto_secretstream_xchacha20poly1305_push(
                    initPush.state, new TextEncoder().encode(chunks[i]), null, tag
                )
            );
        }

        // Decrypt all chunks
        const pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(initPush.header, key);
        const decrypted: string[] = [];
        for (const ct of ciphertexts) {
            const result = sodium.crypto_secretstream_xchacha20poly1305_pull(pullState, ct, null);
            expect(result).not.toBe(false);
            if (result !== false) {
                decrypted.push(new TextDecoder().decode(result.message));
            }
        }

        expect(decrypted).toEqual(chunks);
    });

    // ─── NEW: Offline manifest nonce prepend ───
    it('offline manifest: random nonce is prepended to ciphertext', async () => {
        const psk = new Uint8Array(32);
        crypto.getRandomValues(psk);
        const keys = await deriveOfflineKeys(psk, 'nonce-test');

        const manifestPlain = encode({ files: [{ path: 'test.txt', size: 42 }] });
        const nonce = new Uint8Array(24);
        crypto.getRandomValues(nonce);

        const ctRaw = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            manifestPlain, null, null, nonce, keys.manifestKey
        );

        // Prepend nonce (as the worker does for offline mode)
        const ctWithNonce = new Uint8Array(24 + ctRaw.length);
        ctWithNonce.set(nonce, 0);
        ctWithNonce.set(ctRaw, 24);

        // Extract and decrypt (as download page does)
        const extractedNonce = ctWithNonce.slice(0, 24);
        const extractedCt = ctWithNonce.slice(24);

        const decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            null, extractedCt, null, extractedNonce, keys.manifestKey
        );

        expect(decode(decrypted)).toEqual({ files: [{ path: 'test.txt', size: 42 }] });
    });

    // ─── NEW: Wrong key fails decryption ───
    it('decryption with wrong key throws', async () => {
        const psk1 = new Uint8Array(32);
        crypto.getRandomValues(psk1);
        const psk2 = new Uint8Array(32);
        crypto.getRandomValues(psk2);

        const keys1 = await deriveOfflineKeys(psk1, 'wrong-key');
        const keys2 = await deriveOfflineKeys(psk2, 'wrong-key');

        const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            encode({ test: 1 }), null, null, new Uint8Array(24), keys1.manifestKey
        );

        expect(() => {
            sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                null, ct, null, new Uint8Array(24), keys2.manifestKey
            );
        }).toThrow();
    });

    // ─── NEW: Empty chunk encryption ───
    it('empty chunk (0 bytes) can be encrypted and decrypted', async () => {
        const key = new Uint8Array(32);
        crypto.getRandomValues(key);

        const initPush = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
        const ct = sodium.crypto_secretstream_xchacha20poly1305_push(
            initPush.state, new Uint8Array(0), null,
            sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
        );

        const pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(initPush.header, key);
        const result = sodium.crypto_secretstream_xchacha20poly1305_pull(pullState, ct, null);
        expect(result).not.toBe(false);
        if (result !== false) {
            expect(result.message.length).toBe(0);
            expect(result.tag).toBe(sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL);
        }
    });

    // ─── NEW: Tampered ciphertext fails authentication ───
    it('tampered ciphertext fails authentication', async () => {
        const key = new Uint8Array(32);
        crypto.getRandomValues(key);

        const initPush = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
        const ct = sodium.crypto_secretstream_xchacha20poly1305_push(
            initPush.state, new TextEncoder().encode("secret"), null,
            sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
        );

        // Tamper with ciphertext
        const tampered = new Uint8Array(ct);
        tampered[ct.length - 1] ^= 0xFF;

        const pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(initPush.header, key);
        const result = sodium.crypto_secretstream_xchacha20poly1305_pull(pullState, tampered, null);
        expect(result).toBe(false);
    });
    // ─── NEW: 1-byte file roundtrip through secretstream ───
    it('1-byte file roundtrip through secretstream succeeds', async () => {
        const key = new Uint8Array(32);
        crypto.getRandomValues(key);

        const plaintext = new Uint8Array([0x42]); // single byte

        const initPush = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
        const header = initPush.header;
        const ct = sodium.crypto_secretstream_xchacha20poly1305_push(
            initPush.state, plaintext, null,
            sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
        );

        // Verify: encrypted output is LARGER than plaintext
        // ABYTES = 17 (Poly1305 tag), header = 24 bytes
        expect(ct.length).toBe(plaintext.length + sodium.crypto_secretstream_xchacha20poly1305_ABYTES);
        expect(header.length).toBe(sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES);

        // Total overhead: header (24) + ABYTES (17) = 41 bytes for 1 byte of data
        const totalOverhead = header.length + ct.length - plaintext.length;
        expect(totalOverhead).toBeGreaterThan(plaintext.length);

        // Decrypt and verify roundtrip
        const pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
        const result = sodium.crypto_secretstream_xchacha20poly1305_pull(pullState, ct, null);
        expect(result).not.toBe(false);
        if (result !== false) {
            expect(result.message.length).toBe(1);
            expect(result.message[0]).toBe(0x42);
            expect(result.tag).toBe(sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL);
        }
    });

    // ─── NEW: Manifest encryption overhead for tiny file ───
    it('manifest encryption for 1-file bundle has correct overhead', async () => {
        const psk = new Uint8Array(32);
        crypto.getRandomValues(psk);
        const fileId = 'test-file-id-tiny';

        const keys = await deriveOfflineKeys(psk, fileId);
        const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);

        const manifest = encode({
            version: 1,
            type: 'single',
            files: [{ name: 'pixel.png', size: 1, mime: 'image/png' }]
        });

        const encManifest = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            manifest, null, null, nonce, keys.manifestKey
        );

        // Encrypted manifest should be larger than plaintext by exactly ABYTES (16)
        expect(encManifest.length).toBe(
            manifest.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES
        );

        // Decrypt and verify roundtrip
        const decManifest = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            null, encManifest, null, nonce, keys.manifestKey
        );
        const parsed = decode(decManifest) as any;
        expect(parsed.files[0].name).toBe('pixel.png');
        expect(parsed.files[0].size).toBe(1);
    });

    // ─── NEW: Auto-Resume Nonce Reuse prevention ───
    it('auto-resume: updating nonceBase and resetting counter prevents nonce reuse', async () => {
        const segBytes = new Uint8Array(32);
        crypto.getRandomValues(segBytes);

        const initialNonceBase = new Uint8Array(24);
        crypto.getRandomValues(initialNonceBase);

        const encryptState = { counter: 0, nonceBase: initialNonceBase };
        const decryptState = { counter: 0, nonceBase: initialNonceBase };

        // Helper to encrypt
        const encryptChunk = (state: any, chunk: Uint8Array) => {
            const nonce = new Uint8Array(state.nonceBase);
            const nonceView = new DataView(nonce.buffer);
            const c = state.counter;
            nonceView.setUint32(16, c & 0xffffffff, true);
            nonceView.setUint32(20, Math.floor(c / 0x100000000), true);

            const pt = new Uint8Array(chunk.length + 1);
            pt.set(chunk, 0);
            pt[chunk.length] = 1; // TAG_MESSAGE

            const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
                pt, null, null, nonce, segBytes
            );
            state.counter++;
            return { ct, nonceUsed: nonce };
        };

        // Helper to decrypt
        const decryptChunk = (state: any, ct: Uint8Array) => {
            const nonce = new Uint8Array(state.nonceBase);
            const nonceView = new DataView(nonce.buffer);
            const c = state.counter;
            nonceView.setUint32(16, c & 0xffffffff, true);
            nonceView.setUint32(20, Math.floor(c / 0x100000000), true);

            const ptWithTag = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                null, ct, null, nonce, segBytes
            );
            state.counter++;
            return ptWithTag.slice(0, ptWithTag.length - 1);
        };

        // Encrypt chunk 1 before disconnection
        const chunk1 = new TextEncoder().encode("Hello Part 1");
        const res1 = encryptChunk(encryptState, chunk1);

        // Simulate reconnection / Auto-Resume triggering
        const freshNonceBase = new Uint8Array(24);
        crypto.getRandomValues(freshNonceBase);

        // Reset encrypt/decrypt states with new nonceBase and counter = 0
        encryptState.counter = 0;
        encryptState.nonceBase = freshNonceBase;

        decryptState.counter = 0;
        decryptState.nonceBase = freshNonceBase;

        // Encrypt chunk 2 after reconnection
        const chunk2 = new TextEncoder().encode("Hello Part 2 (Resumed)");
        const res2 = encryptChunk(encryptState, chunk2);

        // Verify that the nonces used are entirely different
        expect(res1.nonceUsed).not.toEqual(res2.nonceUsed);

        // Verify decryption of chunk 2 succeeds with the resumed decrypt state
        const decrypted2 = decryptChunk(decryptState, res2.ct);
        expect(new TextDecoder().decode(decrypted2)).toBe("Hello Part 2 (Resumed)");
    });
});
