import { describe, it, expect, beforeAll } from 'vitest';
import { toHex, fromHex, signPayload, getIdentity } from './identity';
import sodium from 'libsodium-wrappers';

describe('Identity Module', () => {
    beforeAll(async () => {
        await sodium.ready;
        
        // Mock sessionStorage
        const store: Record<string, string> = {};
        global.sessionStorage = {
            getItem: (key: string) => store[key] || null,
            setItem: (key: string, value: string) => { store[key] = value; },
            clear: () => { Object.keys(store).forEach(key => delete store[key]); },
            removeItem: (key: string) => { delete store[key]; },
            length: 0,
            key: (index: number) => null,
        } as Storage;

        // Mock localStorage
        global.localStorage = {
            getItem: (key: string) => store[key] || null,
            setItem: (key: string, value: string) => { store[key] = value; },
            clear: () => { Object.keys(store).forEach(key => delete store[key]); },
            removeItem: (key: string) => { delete store[key]; },
            length: 0,
            key: (index: number) => null,
        } as Storage;
    });

    it('toHex and fromHex are reversible', () => {
        const original = new Uint8Array([0, 255, 127, 42]);
        const hex = toHex(original);
        expect(hex).toBe('00ff7f2a');
        const reversed = fromHex(hex);
        expect(reversed).toEqual(original);
    });

    it('getIdentity generates and caches keys', async () => {
        // Clear session storage for clean state
        sessionStorage.clear();
        
        const id1 = await getIdentity();
        expect(id1.publicKeyHex).toBeDefined();
        expect(id1.privateKeyHex).toBeDefined();
        
        const id2 = await getIdentity();
        expect(id2.publicKeyHex).toBe(id1.publicKeyHex);
        expect(id2.privateKeyHex).toBe(id1.privateKeyHex);
    });

    it('signPayload creates valid signatures', async () => {
        sessionStorage.clear();
        const payload = "test payload: 12345";
        
        const { pubkey, signature } = await signPayload(payload);
        
        expect(pubkey.length).toBe(64); // 32 bytes hex
        expect(signature.length).toBe(128); // 64 bytes hex
        
        const pubkeyBytes = fromHex(pubkey);
        const signatureBytes = fromHex(signature);
        
        // Verify signature
        const isValid = sodium.crypto_sign_verify_detached(signatureBytes, payload, pubkeyBytes);
        expect(isValid).toBe(true);
    });
});
