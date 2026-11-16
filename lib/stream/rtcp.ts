/** The handful of RTCP packets the camera stream needs (RFC 3550, RFC 4585). */

export interface ReceiverReportState {
    senderSsrc: number;
    mediaSsrc: number;
    highestSeq: number;
    cycles: number;
    /** Middle 32 bits of the NTP timestamp of the last SR, 0 when none. */
    lastSr: number;
    /** When the last SR arrived (ms since epoch). */
    lastSrReceivedAt: number;
}

export function buildReceiverReport(state: ReceiverReportState): Buffer {
    const packet = Buffer.alloc(32);
    packet[0] = 0x81; // V=2, RC=1
    packet[1] = 201; // RR
    packet.writeUInt16BE(7, 2); // length in 32-bit words minus one
    packet.writeUInt32BE(state.senderSsrc >>> 0, 4);
    packet.writeUInt32BE(state.mediaSsrc >>> 0, 8);
    // fraction lost + cumulative lost stay 0
    packet.writeUInt32BE(((state.cycles << 16) | state.highestSeq) >>> 0, 16);
    packet.writeUInt32BE(0, 20); // jitter
    packet.writeUInt32BE(state.lastSr >>> 0, 24);
    const dlsr = state.lastSr ? Math.min(0xffffffff, Math.round(((Date.now() - state.lastSrReceivedAt) / 1000) * 65536)) : 0;
    packet.writeUInt32BE(dlsr >>> 0, 28);
    return packet;
}

export function buildPictureLossIndication(senderSsrc: number, mediaSsrc: number): Buffer {
    const packet = Buffer.alloc(12);
    packet[0] = 0x81; // V=2, FMT=1 (PLI)
    packet[1] = 206; // PSFB
    packet.writeUInt16BE(2, 2);
    packet.writeUInt32BE(senderSsrc >>> 0, 4);
    packet.writeUInt32BE(mediaSsrc >>> 0, 8);
    return packet;
}

/** Find a sender report in a compound RTCP packet and return the middle 32 bits of its NTP timestamp. */
export function findSenderReport(packet: Buffer): { ssrc: number; lsr: number } | undefined {
    let offset = 0;
    while (offset + 8 <= packet.length) {
        const type = packet[offset + 1];
        const length = (packet.readUInt16BE(offset + 2) + 1) * 4;
        if (type === 200 && offset + 20 <= packet.length) {
            const ssrc = packet.readUInt32BE(offset + 4);
            const ntpHigh = packet.readUInt32BE(offset + 8);
            const ntpLow = packet.readUInt32BE(offset + 12);
            return { ssrc, lsr: (((ntpHigh & 0xffff) << 16) | (ntpLow >>> 16)) >>> 0 };
        }
        offset += length;
    }
    return undefined;
}
