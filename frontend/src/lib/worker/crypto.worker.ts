import _sodium from 'libsodium-wrappers';
import { encode, decode } from 'cbor-x';
import type { 
    CryptoWorkerMessage, InitEncryptPayload, EncapsulatePayload, DecapsulatePayload 
} from './types';
import init, * as pqcWasmModule from '../../../../crypto-worker/pkg/crypto_worker.js';

let sodium: typeof _sodium;
let pqcWasm: typeof pqcWasmModule;

interface SessionState {
    sharedSecret: Uint8Array | null;
    keys: { manifest: CryptoKey, segBase: CryptoKey } | null;
    encryptState: any | null;
    decryptState: any | null;
    lastTag?: number;
    tempDK?: Uint8Array;
    tempX25519Sk?: Uint8Array;
}
const sessions = new Map<string, SessionState>();

function getSession(id?: string): SessionState {
    const key = id || 'default';
    if (!sessions.has(key)) {
        sessions.set(key, { sharedSecret: null, keys: null, encryptState: null, decryptState: null });
    }
    return sessions.get(key)!;
}

async function initCrypto() {
    await _sodium.ready;
    sodium = _sodium;
    
    try {
        await init();
        pqcWasm = pqcWasmModule;
        // PQC WASM loaded
    } catch (err) {
        console.error("[Worker] Failed to load PQC WASM", err);
    }

    postMessage({ id: 'SYSTEM', type: 'WASM_LOADED' });
}

async function deriveKeys(session: SessionState, psk: Uint8Array, sharedSecretPqc: Uint8Array, sharedSecretX25519?: Uint8Array) {
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
        "raw",
        ikm.buffer as ArrayBuffer,
        "HKDF",
        false,
        ["deriveBits"]
    );

    const manifestBits = await crypto.subtle.deriveBits(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: salt,
            info: new TextEncoder().encode("manifest"),
        },
        keyMaterial,
        256
    );

    const segBaseBits = await crypto.subtle.deriveBits(
        {   
            name: "HKDF",
            hash: "SHA-256",
            salt: salt,
            info: new TextEncoder().encode("p2p-seg-base"),
        },
        keyMaterial,
        256
    );

    session.keys = {
        manifest: await crypto.subtle.importKey("raw", manifestBits, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]),
        segBase: await crypto.subtle.importKey("raw", segBaseBits, { name: "AES-GCM" }, true, ["encrypt", "decrypt"])
    };
}

async function deriveOfflineKeys(session: SessionState, psk: Uint8Array, fileId: string) {
    const contextStr = new TextEncoder().encode(`voiddrop-v1-offline-${fileId}`);
    const salt = await crypto.subtle.digest("SHA-256", contextStr);

    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        psk.buffer as ArrayBuffer,
        "HKDF",
        false,
        ["deriveBits"]
    );

    const manifestBits = await crypto.subtle.deriveBits(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: salt,
            info: new TextEncoder().encode("manifest"),
        },
        keyMaterial,
        256
    );

    const segBaseBits = await crypto.subtle.deriveBits(
        {   
            name: "HKDF",
            hash: "SHA-256",
            salt: salt,
            info: new TextEncoder().encode("s3-seg-base"),
        },
        keyMaterial,
        256
    );

    session.keys = {
        manifest: await crypto.subtle.importKey("raw", manifestBits, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]),
        segBase: await crypto.subtle.importKey("raw", segBaseBits, { name: "AES-GCM" }, true, ["encrypt", "decrypt"])
    };
}

async function getRawKeyBytes(cryptoKey: CryptoKey): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.exportKey("raw", cryptoKey));
}

self.onmessage = async (e: MessageEvent<CryptoWorkerMessage>) => {
    const { id, type, payload, sessionId } = e.data;
    const session = getSession(sessionId);

    try {
        switch (type) {
            case 'HANDSHAKE_PQC_GENERATE': {
                const kp = pqcWasm.ml_kem_768_generate_keypair();
                const pkKyber = kp.public_key;
                session.tempDK = kp.secret_key;
                
                const kpX = sodium.crypto_kx_keypair();
                session.tempX25519Sk = kpX.privateKey;
                const pkX = kpX.publicKey;
                
                postMessage({ id, type: 'RESULT_PQC_KEY', payload: { kyber: pkKyber, x25519: pkX } });
                break;
            }
            case 'HANDSHAKE_PQC_ENCAPSULATE': {
                const { psk, publicKey } = payload as EncapsulatePayload;
                const ctObj = pqcWasm.ml_kem_768_encapsulate(publicKey.kyber);
                const kyberCt = ctObj.ciphertext;
                const sharedSecretPqc = ctObj.shared_secret;
                
                const clientKp = sodium.crypto_kx_keypair();
                const x25519Pk = clientKp.publicKey;
                
                const sharedSecretX25519Raw = sodium.crypto_scalarmult(clientKp.privateKey, publicKey.x25519);

                await deriveKeys(session, psk, sharedSecretPqc!, sharedSecretX25519Raw);
                
                postMessage({ id, type: 'RESULT_PQC_CIPHERTEXT', payload: { kyberCt, x25519Pk } });
                break;
            }
            case 'HANDSHAKE_PQC_DECAPSULATE': {
                const { psk, ciphertext } = payload as DecapsulatePayload;
                const dk = session.tempDK;
                const xSk = session.tempX25519Sk;
                if (!dk || !xSk) throw new Error("No Decapsulation Key present!");
                
                session.sharedSecret = pqcWasm.ml_kem_768_decapsulate(dk, ciphertext.kyberCt);
                const sharedSecretX25519Raw = sodium.crypto_scalarmult(xSk, ciphertext.x25519Pk);

                await deriveKeys(session, psk, session.sharedSecret, sharedSecretX25519Raw);
                
                postMessage({ id, type: 'RESULT_PQC_STATUS', payload: "OK" });
                break;
            }
            case 'INIT_ENCRYPT_STREAM': {
                const { manifest } = payload as InitEncryptPayload;
                if (!session.keys) throw new Error("Keys not derived yet!");
                
                const manifestPlain = encode(manifest);
                
                // Pre-compute ciphertext length to build header BEFORE encryption (16 is tag size, 24 is nonce size)
                const manifestCiphertextLen = manifestPlain.length + 16 + 24;

                // 26 bytes Global Header (must be built first — used as AAD)
                const header = new Uint8Array(26);
                const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
                const magic = new TextEncoder().encode("VDDP01\0\0");
                header.set(magic, 0);
                view.setUint16(8, 1, true); // v1
                view.setUint16(10, 0, true); // ML-KEM flag 0 (mock)
                view.setUint16(12, 1, true); // XChaCha20
                view.setUint32(14, 16777216, true); // seg size
                view.setUint32(18, 32768, true); // max frame
                view.setUint32(22, manifestCiphertextLen, true); // manifest_len

                // Encrypt manifest with AAD = Global Header (per Protocol v1 spec)
                const nonce = new Uint8Array(24);
                crypto.getRandomValues(nonce);
                const mkBytes = await getRawKeyBytes(session.keys.manifest);
                const manifestCiphertextRaw = pqcWasm.rust_encrypt_xchacha20poly1305(
                    mkBytes, nonce, manifestPlain, header
                );
                
                const manifestCiphertext = new Uint8Array(24 + manifestCiphertextRaw.length);
                manifestCiphertext.set(nonce, 0);
                manifestCiphertext.set(manifestCiphertextRaw, 24);
                
                // Segment 0 init: Generate 24-byte random nonce base
                const streamHeader = new Uint8Array(24);
                crypto.getRandomValues(streamHeader);
                session.encryptState = { counter: 0, nonceBase: streamHeader };
                
                postMessage({ 
                    id, 
                    type: 'RESULT_ENCRYPT_MANIFEST', 
                    payload: { header, manifestCiphertext, streamHeader } 
                });
                break;
            }
            case 'INIT_OFFLINE_ENCRYPT': {
                const { psk, manifest, fileId } = payload as InitEncryptPayload;
                await deriveOfflineKeys(session, psk, fileId!);
                
                const manifestPlain = encode({ ...manifest, offline: true });
                
                // Pre-compute ciphertext length to build header BEFORE encryption
                const manifestCiphertextLen = manifestPlain.length + 16 + 24;

                // Build Global Header first (used as AAD)
                const header = new Uint8Array(26);
                const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
                const magic = new TextEncoder().encode("VDDP01\0\0");
                header.set(magic, 0);
                view.setUint16(8, 1, true); // v1
                view.setUint16(10, 1, true); // Offline flag
                view.setUint16(12, 1, true); // XChaCha20
                view.setUint32(14, 16777216, true); // seg size
                view.setUint32(18, 32768, true); // max frame
                view.setUint32(22, manifestCiphertextLen, true); // manifest_len

                // Encrypt manifest with AAD = Global Header (per Protocol v1 spec)
                const nonce = new Uint8Array(24);
                crypto.getRandomValues(nonce);
                const mkBytes = await getRawKeyBytes(session.keys!.manifest);
                const manifestCiphertextRaw = pqcWasm.rust_encrypt_xchacha20poly1305(
                    mkBytes, nonce, manifestPlain, header
                );
                const manifestCiphertext = new Uint8Array(24 + manifestCiphertextRaw.length);
                manifestCiphertext.set(nonce, 0);
                manifestCiphertext.set(manifestCiphertextRaw, 24);
                
                // Segment 0 init
                const streamHeader = new Uint8Array(24);
                crypto.getRandomValues(streamHeader);
                session.encryptState = { counter: 0, nonceBase: streamHeader };
                
                postMessage({ 
                    id, 
                    type: 'RESULT_ENCRYPT_MANIFEST', 
                    payload: { header, manifestCiphertext, streamHeader } 
                });
                break;
            }
            case 'ENCRYPT_CHUNK': {
                const { chunk, isFinal } = payload;
                const tag = isFinal ? 2 : 1; // 2 = TAG_FINAL, 1 = TAG_MESSAGE
                
                const segBytes = await getRawKeyBytes(session.keys!.segBase);
                
                // Build a 24-byte nonce using current counter
                const nonce = new Uint8Array(session.encryptState.nonceBase);
                const nonceView = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
                const c = session.encryptState.counter;
                nonceView.setUint32(16, c & 0xffffffff, true);
                nonceView.setUint32(20, Math.floor(c / 0x100000000), true);
                
                // Append tag byte to chunk
                const plaintext = new Uint8Array(chunk.length + 1);
                plaintext.set(chunk, 0);
                plaintext[chunk.length] = tag;
                
                const ciphertext = pqcWasm.rust_encrypt_xchacha20poly1305(
                    segBytes, nonce, plaintext, new Uint8Array()
                );
                
                session.encryptState.counter++;
                
                // Add 4-byte length prefix for framing in S3 streams
                const framedCt = new Uint8Array(4 + ciphertext.length);
                const view = new DataView(framedCt.buffer, framedCt.byteOffset, framedCt.byteLength);
                view.setUint32(0, ciphertext.length, true);
                framedCt.set(ciphertext, 4);

                (postMessage as any)({ id, type: 'RESULT_CHUNK', payload: framedCt }, [framedCt.buffer]); // Transfer buffer
                break;
            }
            case 'DECRYPT_MANIFEST': {
                const { header, manifestCiphertext, streamHeader } = payload;
                if (!session.keys) throw new Error("Keys not derived yet!");
                
                // Decrypt manifest with AAD = Global Header (per Protocol v1 spec)
                const nonce = manifestCiphertext.slice(0, 24);
                const actualCt = manifestCiphertext.slice(24);
                const mkBytes = await getRawKeyBytes(session.keys.manifest);
                
                const manifestPlain = pqcWasm.rust_decrypt_xchacha20poly1305(
                    mkBytes, nonce, actualCt, header
                );
                
                const manifest = decode(manifestPlain);
                
                session.decryptState = { counter: 0, nonceBase: streamHeader };

                postMessage({ id, type: 'RESULT_DECRYPT_MANIFEST', payload: manifest });
                break;
            }
            case 'INIT_OFFLINE_DECRYPT': {
                const { psk, header, manifestCiphertext, streamHeader, fileId } = payload;
                await deriveOfflineKeys(session, psk, fileId);

                // Decrypt manifest with AAD = Global Header (per Protocol v1 spec)
                const nonce = manifestCiphertext.slice(0, 24);
                const actualCt = manifestCiphertext.slice(24);
                const mkBytes = await getRawKeyBytes(session.keys!.manifest);
                
                const manifestPlain = pqcWasm.rust_decrypt_xchacha20poly1305(
                    mkBytes, nonce, actualCt, header
                );
                
                const manifest = decode(manifestPlain);
                
                session.decryptState = { counter: 0, nonceBase: streamHeader };

                postMessage({ id, type: 'RESULT_DECRYPT_MANIFEST', payload: manifest });
                break;
            }
            case 'DECRYPT_CHUNK': {
                const { chunk: prefixedCt, isFinal } = payload;
                if (!session.decryptState) throw new Error("Stream not initialized for pulling");
                
                // Strip 4-byte length prefix
                const ctLen = new DataView(prefixedCt.buffer, prefixedCt.byteOffset, prefixedCt.byteLength).getUint32(0, true);
                const ct = prefixedCt.slice(4, 4 + ctLen);

                const segBytes = await getRawKeyBytes(session.keys!.segBase);

                // Build a 24-byte nonce using current counter
                const nonce = new Uint8Array(session.decryptState.nonceBase);
                const nonceView = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
                const c = session.decryptState.counter;
                nonceView.setUint32(16, c & 0xffffffff, true);
                nonceView.setUint32(20, Math.floor(c / 0x100000000), true);

                const plaintextWithTag = pqcWasm.rust_decrypt_xchacha20poly1305(
                    segBytes, nonce, ct, new Uint8Array()
                );
                
                const pt = plaintextWithTag.slice(0, plaintextWithTag.length - 1);
                const tag = plaintextWithTag[plaintextWithTag.length - 1];
                
                session.lastTag = tag;
                const detectedFinal = tag === 2; // 2 = TAG_FINAL
                
                if (isFinal && !detectedFinal) {
                    throw new Error("Truncation attack detected! Expected TAG_FINAL on the last chunk.");
                }

                session.decryptState.counter++;

                (postMessage as any)({ id, type: 'RESULT_CHUNK', payload: pt, isFinal: detectedFinal }, [pt.buffer]); // Transfer
                break;
            }
            case 'STREAM_DONE': {
                if (session.lastTag !== 2) { // 2 = TAG_FINAL
                    throw new Error("Truncation attack detected! Stream ended but last chunk didn't have TAG_FINAL.");
                }
                postMessage({ id, type: 'RESULT_STREAM_DONE', payload: 'OK' });
                break;
            }
            case 'CLEANUP_SESSION': {
                const s = sessions.get(sessionId || 'default');
                if (s) {
                    if (s.sharedSecret) {
                        sodium.memzero(s.sharedSecret);
                    }
                    if (s.tempDK) {
                        sodium.memzero(s.tempDK);
                    }
                    if (s.tempX25519Sk) {
                        sodium.memzero(s.tempX25519Sk);
                    }
                    if (s.encryptState && s.encryptState.nonceBase) {
                        sodium.memzero(s.encryptState.nonceBase);
                    }
                    if (s.decryptState && s.decryptState.nonceBase) {
                        sodium.memzero(s.decryptState.nonceBase);
                    }
                    s.sharedSecret = null;
                    s.keys = null;
                    s.encryptState = null;
                    s.decryptState = null;
                    s.tempDK = undefined;
                    s.tempX25519Sk = undefined;
                }
                sessions.delete(sessionId || 'default');
                postMessage({ id, type: 'RESULT_CLEANUP', payload: 'OK' });
                break;
            }
            case 'RESET_ENCRYPT_COUNTER': {
                if (session.encryptState) {
                    session.encryptState.counter = payload.counter;
                    if (payload.nonceBase) {
                        session.encryptState.nonceBase = payload.nonceBase;
                    }
                }
                postMessage({ id, type: 'RESULT_RESET_COUNTER', payload: 'OK' });
                break;
            }
            case 'RESET_DECRYPT_COUNTER': {
                if (session.decryptState) {
                    session.decryptState.counter = payload.counter;
                    if (payload.nonceBase) {
                        session.decryptState.nonceBase = payload.nonceBase;
                    }
                }
                postMessage({ id, type: 'RESULT_RESET_COUNTER', payload: 'OK' });
                break;
            }
        }
    } catch (err) {
        console.error(err);
        postMessage({ id, type: 'ERROR', payload: String(err) });
    }
};

initCrypto();
