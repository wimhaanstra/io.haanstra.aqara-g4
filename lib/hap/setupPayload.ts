import { createHash } from 'node:crypto';

/**
 * HomeKit setup codes and QR payloads.
 *
 * The QR code on a HomeKit accessory encodes `X-HM://` + 9 base-36 characters + 4-character setup ID.
 * The 9 characters hold a 45-bit value:
 *   bits  0-26  setup code (8 decimal digits)
 *   bits 27-30  flags (bit 27 NFC, bit 28 IP, bit 29 BLE, bit 30 WAC)
 *   bits 31-38  accessory category
 *   bits 39-42  reserved
 *   bits 43-45  version
 */

export interface SetupPayload {
    setupCode: string; // formatted as XXX-XX-XXX
    setupId?: string;
    category?: number;
    flags?: number;
    version?: number;
}

/** Setup codes HAP forbids (trivial or sequential patterns). */
const INVALID_CODES = new Set([
    '00000000',
    '11111111',
    '22222222',
    '33333333',
    '44444444',
    '55555555',
    '66666666',
    '77777777',
    '88888888',
    '99999999',
    '12345678',
    '87654321',
]);

export function formatSetupCode(digits: string): string {
    return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 8)}`;
}

/**
 * Normalise a typed setup code. Accepts `12345678`, `123-45-678`, `1234-5678` and spaces.
 * Returns the code as `XXX-XX-XXX` or throws on an invalid code.
 */
export function normalizeSetupCode(input: string): string {
    const digits = input.replace(/[\s-]/g, '');
    if (!/^\d{8}$/.test(digits)) {
        throw new Error('A HomeKit setup code has 8 digits.');
    }
    if (INVALID_CODES.has(digits)) {
        throw new Error('This is not a valid HomeKit setup code.');
    }
    return formatSetupCode(digits);
}

/** Decode an `X-HM://` QR payload. */
export function decodeSetupUri(uri: string): SetupPayload {
    const match = /^X-HM:\/\/([0-9A-Z]{9})([0-9A-Z]{4})?$/i.exec(uri.trim());
    if (!match) {
        throw new Error('This is not a HomeKit QR code (expected X-HM://…).');
    }

    let value = 0n;
    for (const char of match[1].toUpperCase()) {
        value = value * 36n + BigInt(parseInt(char, 36));
    }

    const code = Number(value & 0x7ffffffn);
    const digits = code.toString().padStart(8, '0');

    return {
        setupCode: normalizeSetupCode(digits),
        flags: Number((value >> 27n) & 0xfn),
        category: Number((value >> 31n) & 0xffn),
        version: Number((value >> 43n) & 0x7n),
        setupId: match[2]?.toUpperCase(),
    };
}

/** Accept either a setup code or a QR payload. */
export function parseSetupInput(input: string): SetupPayload {
    const trimmed = input.trim();
    if (/^X-HM:\/\//i.test(trimmed)) {
        return decodeSetupUri(trimmed);
    }
    return { setupCode: normalizeSetupCode(trimmed) };
}

/**
 * The `sh` mDNS TXT record: base64 of the first 4 bytes of SHA-512(setupId + deviceId).
 * Used to find the accessory that belongs to a scanned QR code.
 */
export function setupHash(setupId: string, deviceId: string): string {
    return createHash('sha512').update(`${setupId.toUpperCase()}${deviceId.toUpperCase()}`).digest().subarray(0, 4).toString('base64');
}

/** Encode a payload back into an `X-HM://` URI (used by tests and the spike tooling). */
export function encodeSetupUri(payload: Required<Omit<SetupPayload, 'version'>> & { version?: number }): string {
    const digits = BigInt(parseInt(payload.setupCode.replace(/-/g, ''), 10));
    const value =
        digits |
        (BigInt(payload.flags & 0xf) << 27n) |
        (BigInt(payload.category & 0xff) << 31n) |
        (BigInt((payload.version ?? 0) & 0x7) << 43n);
    return `X-HM://${value.toString(36).toUpperCase().padStart(9, '0')}${payload.setupId.toUpperCase()}`;
}
