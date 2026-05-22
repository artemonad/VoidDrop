import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function translateOrigin(origin: string): string {
    if (origin.includes("tauri") || origin.includes("localhost")) {
        return "https://voiddrop.ru";
    }
    return origin;
}

describe('Origin Translation Logic', () => {
    it('translates tauri://localhost to https://voiddrop.ru', () => {
        const origin = 'tauri://localhost';
        expect(translateOrigin(origin)).toBe('https://voiddrop.ru');
    });

    it('translates http://localhost:1420 to https://voiddrop.ru', () => {
        const origin = 'http://localhost:1420';
        expect(translateOrigin(origin)).toBe('https://voiddrop.ru');
    });

    it('translates http://localhost:5173 to https://voiddrop.ru', () => {
        const origin = 'http://localhost:5173';
        expect(translateOrigin(origin)).toBe('https://voiddrop.ru');
    });

    it('keeps production domain https://voiddrop.ru as is', () => {
        const origin = 'https://voiddrop.ru';
        expect(translateOrigin(origin)).toBe('https://voiddrop.ru');
    });

    it('keeps subdomain mapping https://custom.voiddrop.ru as is', () => {
        const origin = 'https://custom.voiddrop.ru';
        expect(translateOrigin(origin)).toBe('https://custom.voiddrop.ru');
    });
});
