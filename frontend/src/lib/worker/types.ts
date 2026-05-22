export type WorkerMessageType = 
    | 'HANDSHAKE_PQC_GENERATE'
    | 'HANDSHAKE_PQC_ENCAPSULATE'
    | 'HANDSHAKE_PQC_DECAPSULATE'
    | 'INIT_ENCRYPT_STREAM'
    | 'INIT_OFFLINE_ENCRYPT'
    | 'INIT_OFFLINE_DECRYPT'
    | 'ENCRYPT_CHUNK'
    | 'DECRYPT_MANIFEST'
    | 'DECRYPT_CHUNK'
    | 'STREAM_DONE'
    | 'RESULT_PQC_KEY'
    | 'RESULT_PQC_CIPHERTEXT'
    | 'RESULT_PQC_STATUS'
    | 'RESULT_ENCRYPT_MANIFEST'
    | 'RESULT_DECRYPT_MANIFEST'
    | 'RESULT_CHUNK'
    | 'RESULT_STREAM_DONE'
    | 'WASM_LOADED'
    | 'ERROR'
    | 'PROGRESS'
    | 'RESET_ENCRYPT_COUNTER'
    | 'RESET_DECRYPT_COUNTER'
    | 'RESULT_RESET_COUNTER'
    | 'CLEANUP_SESSION'
    | 'RESULT_CLEANUP';

export interface CryptoWorkerMessage {
    id: string;
    type: WorkerMessageType;
    sessionId?: string;
    payload?: any;
    isFinal?: boolean;
}

// Payloads
import type { ContainerManifest } from '../network/manifest';

export interface InitEncryptPayload {
    psk: Uint8Array;
    manifest: ContainerManifest;
    fileId?: string;
}

export interface PqcPublicKey {
    kyber: Uint8Array;
    x25519: Uint8Array;
}

export interface PqcCiphertext {
    kyberCt: Uint8Array;
    x25519Pk: Uint8Array;
}

export interface EncapsulatePayload {
    psk: Uint8Array;
    publicKey: PqcPublicKey;
}

export interface DecapsulatePayload {
    psk: Uint8Array;
    ciphertext: PqcCiphertext;
}
