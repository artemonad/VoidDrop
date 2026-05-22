import { describe, it, expect } from 'vitest';

/**
 * PSK hex parsing logic — extracted from +page.svelte for testability.
 * These tests verify the validation logic we added in BUG-24 fix.
 */

function isValidPskHex(hex: string): boolean {
    return /^[0-9a-fA-F]+$/.test(hex) && hex.length >= 64;
}

function parsePskHex(hex: string): Uint8Array {
    return new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
}

function stripRoomPrefix(hash: string): string {
    if (hash.includes(':')) {
        return hash.substring(hash.indexOf(':') + 1);
    }
    return hash;
}

describe('PSK Hex Parsing', () => {
    it('valid 64-char hex → correct Uint8Array', () => {
        const hex = 'a0b1c2d3e4f5060718293a4b5c6d7e8f' + '00112233445566778899aabbccddeeff';
        expect(isValidPskHex(hex)).toBe(true);
        const psk = parsePskHex(hex);
        expect(psk.length).toBe(32);
        expect(psk[0]).toBe(0xa0);
        expect(psk[31]).toBe(0xff);
    });

    it('non-hex characters → validation rejects', () => {
        const badHex = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' + 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
        expect(isValidPskHex(badHex)).toBe(false);
    });

    it('mixed valid/invalid chars → validation rejects', () => {
        const mixed = 'a0b1c2d3e4f5060718293a4b5c6d7e8f' + '00112233445566778899aabbccddeezz';
        expect(isValidPskHex(mixed)).toBe(false);
    });

    it('short hash (< 64 chars) → validation rejects', () => {
        expect(isValidPskHex('abcdef')).toBe(false);
        expect(isValidPskHex('')).toBe(false);
    });

    it('exactly 64 chars → accepted', () => {
        const hex64 = '0'.repeat(64);
        expect(isValidPskHex(hex64)).toBe(true);
        expect(parsePskHex(hex64).length).toBe(32);
    });

    it('longer than 64 chars (valid hex) → accepted', () => {
        const hex128 = 'ab'.repeat(64);
        expect(isValidPskHex(hex128)).toBe(true);
    });

    it('uppercase hex → accepted', () => {
        const hex = 'AABBCCDD'.repeat(8);
        expect(isValidPskHex(hex)).toBe(true);
        const psk = parsePskHex(hex);
        expect(psk[0]).toBe(0xAA);
    });
});

describe('PSK Hash Strip (Room Prefix)', () => {
    it('strips ROOM_ID: prefix from hash', () => {
        const hash = 'some-room-uuid:a0b1c2d3e4f5060718293a4b5c6d7e8f00112233445566778899aabbccddeeff';
        const stripped = stripRoomPrefix(hash);
        expect(stripped).toBe('a0b1c2d3e4f5060718293a4b5c6d7e8f00112233445566778899aabbccddeeff');
    });

    it('no colon → returns hash unchanged', () => {
        const hash = 'a0b1c2d3e4f5060718293a4b5c6d7e8f00112233445566778899aabbccddeeff';
        expect(stripRoomPrefix(hash)).toBe(hash);
    });

    it('multiple colons → strips only up to first colon', () => {
        const hash = 'room:sub:key';
        expect(stripRoomPrefix(hash)).toBe('sub:key');
    });

    it('empty string → returns empty', () => {
        expect(stripRoomPrefix('')).toBe('');
    });

    it('colon at start → returns everything after', () => {
        expect(stripRoomPrefix(':abcdef')).toBe('abcdef');
    });
});

describe('PSK parseInt safety (BUG-24 regression)', () => {
    it('parseInt("zz", 16) returns NaN', () => {
        // This is the core of BUG-24: non-hex chars produce NaN
        expect(parseInt("zz", 16)).toBeNaN();
    });

    it('Uint8Array([NaN]) silently becomes Uint8Array([0])', () => {
        // NaN coerced to 0 in typed arrays — this is the silent corruption
        const arr = new Uint8Array([NaN]);
        expect(arr[0]).toBe(0);
    });

    it('validation prevents NaN corruption for non-hex input', () => {
        const badHash = 'zz'.repeat(32);
        expect(isValidPskHex(badHash)).toBe(false);
        // Without validation, parsePskHex would produce all-zero key
    });
});
