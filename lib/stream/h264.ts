import { rtpHeaderLength } from './srtp';

/** H.264 over RTP helpers (RFC 6184): NAL inspection and depacketizing to Annex-B. */

export const NalType = { NonIdr: 1, Idr: 5, Sei: 6, Sps: 7, Pps: 8, StapA: 24, FuA: 28 } as const;

const START_CODE = Buffer.from([0, 0, 0, 1]);

export function rtpPayload(packet: Buffer): Buffer {
    let end = packet.length;
    if (packet[0] & 0x20) end -= packet[packet.length - 1]; // padding
    return packet.subarray(rtpHeaderLength(packet), end);
}

/** NAL unit types that start in this RTP packet. */
export function startingNalTypes(packet: Buffer): number[] {
    const payload = rtpPayload(packet);
    if (payload.length === 0) return [];
    const type = payload[0] & 0x1f;

    if (type === NalType.StapA) {
        const types: number[] = [];
        let offset = 1;
        while (offset + 2 < payload.length) {
            const size = payload.readUInt16BE(offset);
            types.push(payload[offset + 2] & 0x1f);
            offset += 2 + size;
        }
        return types;
    }
    if (type === NalType.FuA) {
        return payload.length > 1 && payload[1] & 0x80 ? [payload[1] & 0x1f] : [];
    }
    return [type];
}

/** True when the packet starts a keyframe (SPS or IDR slice). */
export function startsKeyframe(packet: Buffer): boolean {
    return startingNalTypes(packet).some((t) => t === NalType.Sps || t === NalType.Idr);
}

/** Reassembles RTP packets into Annex-B NAL units. */
export class H264Depacketizer {
    private fragments: Buffer[] = [];

    push(packet: Buffer): Buffer[] {
        const payload = rtpPayload(packet);
        if (payload.length === 0) return [];
        const type = payload[0] & 0x1f;

        if (type >= 1 && type <= 23) {
            return [Buffer.concat([START_CODE, payload])];
        }

        if (type === NalType.StapA) {
            const units: Buffer[] = [];
            let offset = 1;
            while (offset + 2 <= payload.length) {
                const size = payload.readUInt16BE(offset);
                offset += 2;
                if (offset + size > payload.length) break;
                units.push(Buffer.concat([START_CODE, payload.subarray(offset, offset + size)]));
                offset += size;
            }
            return units;
        }

        if (type === NalType.FuA && payload.length > 2) {
            const start = (payload[1] & 0x80) !== 0;
            const end = (payload[1] & 0x40) !== 0;
            if (start) {
                const header = (payload[0] & 0xe0) | (payload[1] & 0x1f);
                this.fragments = [Buffer.from([header]), payload.subarray(2)];
            } else if (this.fragments.length) {
                this.fragments.push(payload.subarray(2));
            }
            if (end && this.fragments.length) {
                const nal = Buffer.concat([START_CODE, ...this.fragments]);
                this.fragments = [];
                return [nal];
            }
        }
        return [];
    }
}

/** Extract `profile-level-id` (6 hex chars) from an SPS NAL unit (without start code). */
export function profileLevelIdFromSps(sps: Buffer): string | undefined {
    if (sps.length < 4) return undefined;
    return sps.subarray(1, 4).toString('hex');
}
