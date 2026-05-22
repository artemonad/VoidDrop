import sodium from 'libsodium-wrappers';

export interface Identity {
    publicKeyHex: string;
    privateKeyHex: string;
}

export function toHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

export async function getIdentity(): Promise<Identity> {
    await sodium.ready;
    let pubHex = sessionStorage.getItem('nt_pub');
    let privHex = sessionStorage.getItem('nt_priv');

    if (!pubHex || !privHex) {
        const keypair = sodium.crypto_sign_keypair();
        pubHex = toHex(keypair.publicKey);
        privHex = toHex(keypair.privateKey);
        sessionStorage.setItem('nt_pub', pubHex);
        sessionStorage.setItem('nt_priv', privHex);
    }

    return {
        publicKeyHex: pubHex,
        privateKeyHex: privHex
    };
}

export async function signPayload(payload: string): Promise<{ pubkey: string, signature: string }> {
    const identity = await getIdentity();
    const privateKeyBytes = fromHex(identity.privateKeyHex);
    
    const signature = sodium.crypto_sign_detached(payload, privateKeyBytes);
    return {
        pubkey: identity.publicKeyHex,
        signature: toHex(signature)
    };
}
