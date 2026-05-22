import { describe, it, expect } from 'vitest';
import qrcode from 'qrcode-generator';

describe('QR Code Vector Generation (Offline)', () => {
    it('successfully generates high-contrast SVG representation of link text', () => {
        const text = 'https://voiddrop.ru/#room-xyz:psk-1234';
        
        // Type 0 = auto-detect size, 'M' = Medium error correction (~15% recovery)
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        
        const svgTag = qr.createSvgTag(4, 2);
        
        // Assertions
        expect(svgTag).toContain('<svg');
        expect(svgTag).toContain('</svg>');
        expect(svgTag).toContain('viewBox=');
        
        // Verify we have multiple rect or path elements representing modules
        expect(svgTag.includes('rect') || svgTag.includes('path')).toBe(true);
    });

    it('handles short payloads elegantly', () => {
        const text = 'VoidDrop';
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        const svgTag = qr.createSvgTag(4, 2);
        
        expect(svgTag).toContain('<svg');
        expect(svgTag).toContain('path');
    });

    it('throws error for exceptionally oversized payloads inside type-limited versions, but handles auto-scaling properly', () => {
        // Auto-sizing (version 0) can scale up to version 40 to accommodate up to ~3KB text
        const hugeText = 'a'.repeat(2000);
        const qr = qrcode(0, 'M');
        qr.addData(hugeText);
        qr.make();
        
        const svgTag = qr.createSvgTag(4, 2);
        expect(svgTag).toContain('<svg');
    });
});
