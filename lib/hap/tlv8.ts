/**
 * TLV8 encoding as used by HomeKit (HAP).
 *
 * - Each item is `type (1 byte) | length (1 byte) | value`.
 * - Values longer than 255 bytes are split into consecutive fragments of the same type.
 * - Lists of equal-typed items are separated by an empty item (default separator type 0x00 for
 *   camera TLVs, 0xFF for pairing TLVs).
 */

export interface TlvItem {
    type: number;
    value: Buffer;
}

/** Encode a list of [type, value] pairs. Numbers are encoded as uint8. Use the u16/u32/f32 helpers for wider values. */
export function encodeTlv(items: Array<[number, Buffer | number | string]>): Buffer {
    const parts: Buffer[] = [];

    for (const [type, raw] of items) {
        let value: Buffer;
        if (Buffer.isBuffer(raw)) {
            value = raw;
        } else if (typeof raw === 'number') {
            value = Buffer.from([raw & 0xff]);
        } else {
            value = Buffer.from(raw, 'utf8');
        }

        if (value.length === 0) {
            parts.push(Buffer.from([type, 0]));
            continue;
        }

        for (let offset = 0; offset < value.length; offset += 255) {
            const chunk = value.subarray(offset, Math.min(offset + 255, value.length));
            parts.push(Buffer.from([type, chunk.length]), chunk);
        }
    }

    return Buffer.concat(parts);
}

/** Decode a TLV8 buffer into items, merging fragmented values. */
export function decodeTlv(buffer: Buffer): TlvItem[] {
    const items: TlvItem[] = [];
    let offset = 0;
    let lastFragmentFull = false;

    while (offset + 2 <= buffer.length) {
        const type = buffer[offset];
        const length = buffer[offset + 1];
        const value = buffer.subarray(offset + 2, offset + 2 + length);
        offset += 2 + length;

        const previous = items[items.length - 1];
        if (previous && lastFragmentFull && previous.type === type) {
            previous.value = Buffer.concat([previous.value, value]);
        } else {
            items.push({ type, value: Buffer.from(value) });
        }
        lastFragmentFull = length === 255;
    }

    return items;
}

export function tlvGet(items: TlvItem[], type: number): Buffer | undefined {
    return items.find((i) => i.type === type)?.value;
}

export function tlvGetAll(items: TlvItem[], type: number): Buffer[] {
    return items.filter((i) => i.type === type).map((i) => i.value);
}

/** Split a decoded item list into groups at each (empty) separator item. */
export function tlvSplit(items: TlvItem[], separator: number): TlvItem[][] {
    const groups: TlvItem[][] = [[]];
    for (const item of items) {
        if (item.type === separator && item.value.length === 0) {
            groups.push([]);
        } else {
            groups[groups.length - 1].push(item);
        }
    }
    return groups.filter((g) => g.length > 0);
}

export const u8 = (v: number): Buffer => Buffer.from([v & 0xff]);

export function u16(v: number): Buffer {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return b;
}

export function u32(v: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    return b;
}

export function f32(v: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v);
    return b;
}

/** Read a little-endian unsigned integer of 1, 2, 4 bytes. */
export function readUInt(value: Buffer | undefined): number | undefined {
    if (!value || value.length === 0) return undefined;
    if (value.length === 1) return value.readUInt8(0);
    if (value.length === 2) return value.readUInt16LE(0);
    if (value.length >= 4) return value.readUInt32LE(0);
    return value.readUIntLE(0, value.length);
}
