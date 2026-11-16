import { createHash } from 'node:crypto';

import { decodeSetupUri, encodeSetupUri, normalizeSetupCode, parseSetupInput, setupHash } from '../lib/hap/setupPayload';

/** Independent re-implementation of the encoder HAP-NodeJS uses, to cross-check bit positions. */
function hapNodeJsUri(pincode: string, category: number, setupId: string): string {
    const buffer = Buffer.alloc(8);
    let valueLow = parseInt(pincode.replace(/-/g, ''), 10);
    const valueHigh = category >> 1;
    valueLow |= 1 << 28; // IP flag
    buffer.writeUInt32BE(valueLow >>> 0, 4);
    if (category & 1) buffer[4] |= 1 << 7;
    buffer.writeUInt32BE(valueHigh, 0);
    const encoded = (buffer.readUInt32BE(4) + buffer.readUInt32BE(0) * 0x100000000).toString(36).toUpperCase().padStart(9, '0');
    return `X-HM://${encoded}${setupId}`;
}

describe('setup codes', () => {
    it('normalizes typed codes', () => {
        expect(normalizeSetupCode('12345670')).toBe('123-45-670');
        expect(normalizeSetupCode('123-45-670')).toBe('123-45-670');
        expect(normalizeSetupCode(' 1234 5670 ')).toBe('123-45-670');
    });

    it('rejects malformed and forbidden codes', () => {
        expect(() => normalizeSetupCode('1234567')).toThrow();
        expect(() => normalizeSetupCode('abcdefgh')).toThrow();
        expect(() => normalizeSetupCode('123-45-678')).toThrow();
        expect(() => normalizeSetupCode('000-00-000')).toThrow();
    });
});

describe('X-HM:// payloads', () => {
    it.each([
        ['031-45-154', 18, 'AB12'],
        ['518-08-582', 17, 'ZZZZ'],
        ['482-09-301', 2, '0A1B'],
        ['999-99-998', 255, 'XY9Q'],
    ])('decodes %s (category %d, setup id %s) like HAP-NodeJS encodes it', (code, category, setupId) => {
        const uri = hapNodeJsUri(code, category, setupId);
        const decoded = decodeSetupUri(uri);
        expect(decoded.setupCode).toBe(code);
        expect(decoded.category).toBe(category);
        expect(decoded.setupId).toBe(setupId);
        expect(decoded.flags).toBe(2); // IP
        expect(decoded.version).toBe(0);
    });

    it('round-trips through the encoder', () => {
        const uri = encodeSetupUri({ setupCode: '031-45-154', category: 18, flags: 2, setupId: 'AB12' });
        expect(uri).toBe(hapNodeJsUri('031-45-154', 18, 'AB12'));
        expect(decodeSetupUri(uri.toLowerCase().replace('x-hm://', 'X-HM://')).setupCode).toBe('031-45-154');
    });

    it('accepts both forms through parseSetupInput', () => {
        expect(parseSetupInput('03145154').setupCode).toBe('031-45-154');
        expect(parseSetupInput(hapNodeJsUri('031-45-154', 18, 'AB12')).setupId).toBe('AB12');
    });

    it('rejects other QR codes', () => {
        expect(() => decodeSetupUri('https://example.com')).toThrow();
        expect(() => decodeSetupUri('X-HM://SHORT')).toThrow();
    });
});

describe('setup hash', () => {
    it('matches base64(sha512(setupId + deviceId)[0..4])', () => {
        const expected = createHash('sha512').update('AB12AA:BB:CC:DD:EE:FF').digest().subarray(0, 4).toString('base64');
        expect(setupHash('ab12', 'aa:bb:cc:dd:ee:ff')).toBe(expected);
        expect(setupHash('AB12', 'AA:BB:CC:DD:EE:FF')).toHaveLength(8);
    });
});
