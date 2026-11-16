import { decodeTlv, encodeTlv, readUInt, tlvGet, tlvSplit, u16, u32 } from '../lib/hap/tlv8';

describe('TLV8', () => {
    it('encodes numbers, strings and buffers', () => {
        const encoded = encodeTlv([
            [6, 1],
            [1, 'abc'],
            [3, Buffer.from([0xde, 0xad])],
        ]);
        expect(encoded.toString('hex')).toBe('06010101036162630302dead');
    });

    it('fragments and merges values longer than 255 bytes', () => {
        const long = Buffer.alloc(600, 7);
        const encoded = encodeTlv([
            [5, long],
            [6, 2],
        ]);
        expect(encoded.length).toBe(600 + 3 * 2 + 3);
        const decoded = decodeTlv(encoded);
        expect(decoded).toHaveLength(2);
        expect(tlvGet(decoded, 5)!.equals(long)).toBe(true);
        expect(readUInt(tlvGet(decoded, 6))).toBe(2);
    });

    it('keeps exactly-255 values separate from a following item of another type', () => {
        const value = Buffer.alloc(255, 1);
        const decoded = decodeTlv(
            encodeTlv([
                [1, value],
                [2, 9],
            ]),
        );
        expect(decoded.map((d) => d.type)).toEqual([1, 2]);
    });

    it('splits lists on separators', () => {
        const encoded = encodeTlv([
            [1, 1],
            [2, 2],
            [0, Buffer.alloc(0)],
            [1, 3],
        ]);
        const groups = tlvSplit(decodeTlv(encoded), 0);
        expect(groups).toHaveLength(2);
        expect(readUInt(tlvGet(groups[1], 1))).toBe(3);
    });

    it('reads little-endian integers', () => {
        expect(readUInt(u16(0x1234))).toBe(0x1234);
        expect(readUInt(u32(0xdeadbeef))).toBe(0xdeadbeef);
    });
});
