import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { encode, decode } from 'cbor-x';
import { encodeManifest, decodeManifest, type ContainerManifest } from '../network/manifest';

/**
 * End-to-End Crypto Flow Tests
 * 
 * Simulates the FULL sender → receiver pipeline:
 * 1. Derive keys from PSK
 * 2. Encrypt manifest with AEAD
 * 3. Encrypt file chunks with secretstream
 * 4. Decrypt manifest
 * 5. Decrypt file chunks
 * 6. Verify data integrity
 */

// ─── Key Derivation (mirrors crypto.worker.ts) ───

async function deriveOfflineKeys(psk: Uint8Array, fileId: string) {
    const contextStr = new TextEncoder().encode(`voiddrop-v1-offline-${fileId}`);
    const salt = await crypto.subtle.digest("SHA-256", contextStr);
    const keyMaterial = await crypto.subtle.importKey("raw", psk.buffer as ArrayBuffer, "HKDF", false, ["deriveBits"]);

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

function buildGlobalHeader(manifestCiphertextLen: number): Uint8Array {
    const header = new Uint8Array(26);
    const view = new DataView(header.buffer);
    header.set(new TextEncoder().encode("VDDP01\0\0"), 0);
    view.setUint16(8, 1, true);
    view.setUint16(10, 1, true);
    view.setUint16(12, 1, true);
    view.setUint32(14, 16777216, true);
    view.setUint32(18, 32768, true);
    view.setUint32(22, manifestCiphertextLen, true);
    return header;
}

// ─── Full Pipeline ───

async function encryptFullPipeline(
    psk: Uint8Array,
    fileId: string,
    manifest: ContainerManifest,
    fileData: Uint8Array,
    chunkSize: number
) {
    const keys = await deriveOfflineKeys(psk, fileId);

    // 1. Encrypt manifest
    const manifestBytes = encodeManifest(manifest);
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const manifestCt = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        manifestBytes, null, null, nonce, keys.manifestKey
    );
    const manifestCiphertextWithNonce = new Uint8Array(24 + manifestCt.length);
    manifestCiphertextWithNonce.set(nonce, 0);
    manifestCiphertextWithNonce.set(manifestCt, 24);

    // 2. Build header
    const header = buildGlobalHeader(manifestCiphertextWithNonce.length);

    // 3. Init secretstream for file data
    const pushState = sodium.crypto_secretstream_xchacha20poly1305_init_push(keys.segBaseKey);
    const streamHeader = pushState.header;

    // 4. Encrypt file data in chunks
    const encryptedChunks: Uint8Array[] = [];
    let offset = 0;
    while (offset < fileData.length) {
        const end = Math.min(offset + chunkSize, fileData.length);
        const chunk = fileData.slice(offset, end);
        const isFinal = end >= fileData.length;
        const tag = isFinal
            ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
            : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;

        const ct = sodium.crypto_secretstream_xchacha20poly1305_push(
            pushState.state, chunk, null, tag
        );
        encryptedChunks.push(ct);
        offset = end;
    }

    return { header, manifestCiphertextWithNonce, streamHeader, encryptedChunks };
}

async function decryptFullPipeline(
    psk: Uint8Array,
    fileId: string,
    header: Uint8Array,
    manifestCiphertextWithNonce: Uint8Array,
    streamHeader: Uint8Array,
    encryptedChunks: Uint8Array[]
) {
    const keys = await deriveOfflineKeys(psk, fileId);

    // 1. Decrypt manifest
    const nonce = manifestCiphertextWithNonce.slice(0, 24);
    const manifestCt = manifestCiphertextWithNonce.slice(24);
    const manifestBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, manifestCt, null, nonce, keys.manifestKey
    );
    const manifest = decodeManifest(new Uint8Array(manifestBytes));

    // 2. Init secretstream pull
    const pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(streamHeader, keys.segBaseKey);

    // 3. Decrypt chunks
    const decryptedChunks: Uint8Array[] = [];
    let lastTag = -1;
    for (const ct of encryptedChunks) {
        const result = sodium.crypto_secretstream_xchacha20poly1305_pull(pullState, ct, null);
        if (result === false) throw new Error('Decryption failed — authentication error');
        decryptedChunks.push(new Uint8Array(result.message));
        lastTag = result.tag;
    }

    const sawFinal = lastTag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;

    // Reassemble
    const totalLen = decryptedChunks.reduce((sum, c) => sum + c.length, 0);
    const fileData = new Uint8Array(totalLen);
    let off = 0;
    for (const c of decryptedChunks) {
        fileData.set(c, off);
        off += c.length;
    }

    return { manifest, fileData, sawFinal };
}

// ═══════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════

describe('End-to-End Crypto Flow', () => {
    beforeAll(async () => {
        await sodium.ready;
    });

    it('single file: encrypt → decrypt preserves data exactly', async () => {
        const psk = sodium.randombytes_buf(32);
        const fileId = 'test-e2e-single';
        const fileData = new Uint8Array(500);
        for (let i = 0; i < fileData.length; i++) fileData[i] = i & 0xFF;

        const manifest: ContainerManifest = {
            type: 'single',
            totalSize: fileData.length,
            files: [{ path: 'secret.bin', size: fileData.length, mime: 'application/octet-stream' }],
        };

        const encrypted = await encryptFullPipeline(psk, fileId, manifest, fileData, 128);
        const decrypted = await decryptFullPipeline(
            psk, fileId,
            encrypted.header,
            encrypted.manifestCiphertextWithNonce,
            encrypted.streamHeader,
            encrypted.encryptedChunks,
        );

        expect(decrypted.manifest.type).toBe('single');
        expect(decrypted.manifest.files[0].path).toBe('secret.bin');
        expect(decrypted.manifest.totalSize).toBe(500);
        expect(decrypted.fileData).toEqual(fileData);
        expect(decrypted.sawFinal).toBe(true);
    });

    it('bundle: 3 files encrypt → decrypt with correct slicing', async () => {
        const psk = sodium.randombytes_buf(32);
        const fileId = 'test-e2e-bundle';

        const file1 = new Uint8Array(100); file1.fill(0x11);
        const file2 = new Uint8Array(200); file2.fill(0x22);
        const file3 = new Uint8Array(50);  file3.fill(0x33);
        const allData = new Uint8Array(350);
        allData.set(file1, 0);
        allData.set(file2, 100);
        allData.set(file3, 300);

        const manifest: ContainerManifest = {
            type: 'bundle',
            totalSize: 350,
            files: [
                { path: 'a.bin', size: 100 },
                { path: 'b.bin', size: 200 },
                { path: 'c.bin', size: 50 },
            ],
        };

        const encrypted = await encryptFullPipeline(psk, fileId, manifest, allData, 64);
        const decrypted = await decryptFullPipeline(
            psk, fileId,
            encrypted.header,
            encrypted.manifestCiphertextWithNonce,
            encrypted.streamHeader,
            encrypted.encryptedChunks,
        );

        expect(decrypted.manifest.type).toBe('bundle');
        expect(decrypted.manifest.files.length).toBe(3);

        // Slice the decrypted stream by manifest sizes
        expect(decrypted.fileData.slice(0, 100).every(b => b === 0x11)).toBe(true);
        expect(decrypted.fileData.slice(100, 300).every(b => b === 0x22)).toBe(true);
        expect(decrypted.fileData.slice(300, 350).every(b => b === 0x33)).toBe(true);
        expect(decrypted.sawFinal).toBe(true);
    });

    it('wrong PSK → decryption fails', async () => {
        const psk1 = sodium.randombytes_buf(32);
        const psk2 = sodium.randombytes_buf(32);
        const fileId = 'test-wrong-psk';
        const data = new Uint8Array([1, 2, 3]);

        const manifest: ContainerManifest = {
            type: 'single',
            totalSize: 3,
            files: [{ path: 'test.bin', size: 3 }],
        };

        const encrypted = await encryptFullPipeline(psk1, fileId, manifest, data, 1024);

        await expect(decryptFullPipeline(
            psk2, fileId,
            encrypted.header,
            encrypted.manifestCiphertextWithNonce,
            encrypted.streamHeader,
            encrypted.encryptedChunks,
        )).rejects.toThrow();
    });

    it('wrong fileId → decryption fails', async () => {
        const psk = sodium.randombytes_buf(32);
        const data = new Uint8Array([1, 2, 3]);
        const manifest: ContainerManifest = {
            type: 'single',
            totalSize: 3,
            files: [{ path: 'test.bin', size: 3 }],
        };

        const encrypted = await encryptFullPipeline(psk, 'file-A', manifest, data, 1024);

        await expect(decryptFullPipeline(
            psk, 'file-B',
            encrypted.header,
            encrypted.manifestCiphertextWithNonce,
            encrypted.streamHeader,
            encrypted.encryptedChunks,
        )).rejects.toThrow();
    });

    it('tampered encrypted chunk → decryption fails', async () => {
        const psk = sodium.randombytes_buf(32);
        const fileId = 'test-tampered';
        const data = new Uint8Array(100);
        data.fill(0x55);

        const manifest: ContainerManifest = {
            type: 'single',
            totalSize: 100,
            files: [{ path: 'test.bin', size: 100 }],
        };

        const encrypted = await encryptFullPipeline(psk, fileId, manifest, data, 50);

        // Tamper with first encrypted chunk
        encrypted.encryptedChunks[0][5] ^= 0xFF;

        await expect(decryptFullPipeline(
            psk, fileId,
            encrypted.header,
            encrypted.manifestCiphertextWithNonce,
            encrypted.streamHeader,
            encrypted.encryptedChunks,
        )).rejects.toThrow();
    });

    it('tampered manifest → decryption fails', async () => {
        const psk = sodium.randombytes_buf(32);
        const fileId = 'test-tampered-manifest';
        const data = new Uint8Array([1]);
        const manifest: ContainerManifest = {
            type: 'single',
            totalSize: 1,
            files: [{ path: 'x.bin', size: 1 }],
        };

        const encrypted = await encryptFullPipeline(psk, fileId, manifest, data, 1024);

        // Tamper with manifest ciphertext
        encrypted.manifestCiphertextWithNonce[30] ^= 0xFF;

        await expect(decryptFullPipeline(
            psk, fileId,
            encrypted.header,
            encrypted.manifestCiphertextWithNonce,
            encrypted.streamHeader,
            encrypted.encryptedChunks,
        )).rejects.toThrow();
    });

    it('256KB file with small chunks → data integrity', async () => {
        const psk = sodium.randombytes_buf(32);
        const fileId = 'test-256kb';
        const size = 256 * 1024;
        const data = new Uint8Array(size);
        for (let i = 0; i < size; i++) data[i] = i & 0xFF;

        const manifest: ContainerManifest = {
            type: 'single',
            totalSize: size,
            files: [{ path: 'big.bin', size }],
        };

        const encrypted = await encryptFullPipeline(psk, fileId, manifest, data, 65536);
        const decrypted = await decryptFullPipeline(
            psk, fileId,
            encrypted.header,
            encrypted.manifestCiphertextWithNonce,
            encrypted.streamHeader,
            encrypted.encryptedChunks,
        );

        expect(decrypted.fileData.length).toBe(size);
        expect(decrypted.fileData).toEqual(data);
    });

    it('empty file → encrypts and decrypts correctly', async () => {
        const psk = sodium.randombytes_buf(32);
        const fileId = 'test-empty';
        const data = new Uint8Array(0);

        const manifest: ContainerManifest = {
            type: 'single',
            totalSize: 0,
            files: [{ path: 'empty.txt', size: 0 }],
        };

        // For an empty file, we still need one chunk with TAG_FINAL
        const keys = await deriveOfflineKeys(psk, fileId);
        const manifestBytes = encodeManifest(manifest);
        const nonce = sodium.randombytes_buf(24);
        const manifestCt = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            manifestBytes, null, null, nonce, keys.manifestKey
        );
        const mcwn = new Uint8Array(24 + manifestCt.length);
        mcwn.set(nonce, 0);
        mcwn.set(manifestCt, 24);

        const pushState = sodium.crypto_secretstream_xchacha20poly1305_init_push(keys.segBaseKey);
        const ct = sodium.crypto_secretstream_xchacha20poly1305_push(
            pushState.state, new Uint8Array(0), null,
            sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
        );

        const decrypted = await decryptFullPipeline(
            psk, fileId,
            buildGlobalHeader(mcwn.length),
            mcwn,
            pushState.header,
            [ct],
        );

        expect(decrypted.manifest.files[0].path).toBe('empty.txt');
        expect(decrypted.fileData.length).toBe(0);
        expect(decrypted.sawFinal).toBe(true);
    });

    it('unicode filenames in manifest survive encryption roundtrip', async () => {
        const psk = sodium.randombytes_buf(32);
        const fileId = 'test-unicode';
        const data = new Uint8Array([42]);

        const manifest: ContainerManifest = {
            type: 'single',
            totalSize: 1,
            files: [{ path: 'documents/file 📎.txt', size: 1 }],
        };

        const encrypted = await encryptFullPipeline(psk, fileId, manifest, data, 1024);
        const decrypted = await decryptFullPipeline(
            psk, fileId,
            encrypted.header,
            encrypted.manifestCiphertextWithNonce,
            encrypted.streamHeader,
            encrypted.encryptedChunks,
        );

        expect(decrypted.manifest.files[0].path).toBe('documents/file 📎.txt');
    });

    it('TAG_FINAL is set only on the last chunk', async () => {
        const psk = sodium.randombytes_buf(32);
        const fileId = 'test-tags';
        const data = new Uint8Array(300);
        const manifest: ContainerManifest = {
            type: 'single',
            totalSize: 300,
            files: [{ path: 'tagged.bin', size: 300 }],
        };

        const keys = await deriveOfflineKeys(psk, fileId);
        const pushState = sodium.crypto_secretstream_xchacha20poly1305_init_push(keys.segBaseKey);

        // Encrypt in 3 chunks of 100
        const cts: Uint8Array[] = [];
        for (let i = 0; i < 3; i++) {
            const chunk = data.slice(i * 100, (i + 1) * 100);
            const tag = i === 2
                ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
                : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
            cts.push(sodium.crypto_secretstream_xchacha20poly1305_push(pushState.state, chunk, null, tag));
        }

        // Decrypt and check tags
        const pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(pushState.header, keys.segBaseKey);
        for (let i = 0; i < 3; i++) {
            const result = sodium.crypto_secretstream_xchacha20poly1305_pull(pullState, cts[i], null);
            expect(result).not.toBe(false);
            if (result !== false) {
                if (i < 2) {
                    expect(result.tag).toBe(sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE);
                } else {
                    expect(result.tag).toBe(sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL);
                }
            }
        }
    });
});
