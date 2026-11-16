/* eslint-disable max-classes-per-file */
import crypto from 'node:crypto';

/**
 * SRTP / SRTCP with AES_CM_128_HMAC_SHA1_80 (RFC 3711), the suite HomeKit cameras use.
 * Key derivation rate 0, no MKI.
 */

const AUTH_TAG_LENGTH = 10;

export interface SrtpKeys {
    encryptionKey: Buffer; // 16
    authKey: Buffer; // 20
    salt: Buffer; // 14
}

/** RFC 3711 4.3.1 key derivation with kdr = 0. */
export function deriveKey(masterKey: Buffer, masterSalt: Buffer, label: number, length: number): Buffer {
    const iv = Buffer.alloc(16);
    masterSalt.copy(iv, 0, 0, 14);
    iv[7] ^= label;
    const cipher = crypto.createCipheriv('aes-128-ctr', masterKey, iv);
    return Buffer.concat([cipher.update(Buffer.alloc(length)), cipher.final()]);
}

export function deriveSrtpKeys(masterKey: Buffer, masterSalt: Buffer): { rtp: SrtpKeys; rtcp: SrtpKeys } {
    return {
        rtp: {
            encryptionKey: deriveKey(masterKey, masterSalt, 0, 16),
            authKey: deriveKey(masterKey, masterSalt, 1, 20),
            salt: deriveKey(masterKey, masterSalt, 2, 14),
        },
        rtcp: {
            encryptionKey: deriveKey(masterKey, masterSalt, 3, 16),
            authKey: deriveKey(masterKey, masterSalt, 4, 20),
            salt: deriveKey(masterKey, masterSalt, 5, 14),
        },
    };
}

function counterIv(salt: Buffer, ssrc: number, index: bigint): Buffer {
    const iv = Buffer.alloc(16);
    salt.copy(iv, 0, 0, 14);
    iv.writeUInt32BE((iv.readUInt32BE(4) ^ ssrc) >>> 0, 4);
    // XOR the 48-bit index into bytes 8..13
    for (let i = 0; i < 6; i++) {
        iv[13 - i] ^= Number((index >> BigInt(8 * i)) & 0xffn);
    }
    return iv;
}

function aesCtr(key: Buffer, iv: Buffer, data: Buffer): Buffer {
    const cipher = crypto.createCipheriv('aes-128-ctr', key, iv);
    return Buffer.concat([cipher.update(data), cipher.final()]);
}

function hmac(key: Buffer, ...parts: Buffer[]): Buffer {
    const h = crypto.createHmac('sha1', key);
    for (const part of parts) h.update(part);
    return h.digest().subarray(0, AUTH_TAG_LENGTH);
}

/** Size of the RTP header including CSRCs and the header extension. */
export function rtpHeaderLength(packet: Buffer): number {
    const csrcCount = packet[0] & 0x0f;
    let length = 12 + 4 * csrcCount;
    if (packet[0] & 0x10) {
        if (packet.length < length + 4) return -1;
        length += 4 + 4 * packet.readUInt16BE(length + 2);
    }
    return length;
}

/** Tracks the rollover counter for one SSRC (RFC 3711 3.3.1 / appendix A). */
class RolloverState {
    private roc = 0;
    private highestSeq = -1;

    estimate(seq: number): number {
        if (this.highestSeq < 0) return this.roc;
        if (this.highestSeq < 32768) {
            return seq - this.highestSeq > 32768 ? (this.roc - 1) >>> 0 : this.roc;
        }
        return this.highestSeq - 32768 > seq ? (this.roc + 1) >>> 0 : this.roc;
    }

    update(seq: number, roc: number): void {
        if (this.highestSeq < 0 || roc > this.roc || (roc === this.roc && seq > this.highestSeq)) {
            this.roc = roc;
            this.highestSeq = seq;
        }
    }

    next(seq: number): number {
        // For the sender: wrap ROC when seq goes back to 0.
        if (this.highestSeq >= 0 && seq < this.highestSeq && this.highestSeq - seq > 32768) {
            this.roc = (this.roc + 1) >>> 0;
        }
        this.highestSeq = seq;
        return this.roc;
    }
}

export class SrtpSession {
    private readonly keys: { rtp: SrtpKeys; rtcp: SrtpKeys };
    private readonly rollover = new Map<number, RolloverState>();
    private srtcpIndex = 0;

    constructor(masterKey: Buffer, masterSalt: Buffer) {
        if (masterKey.length !== 16 || masterSalt.length !== 14) {
            throw new Error(`SRTP needs a 16-byte key and 14-byte salt (got ${masterKey.length}/${masterSalt.length})`);
        }
        this.keys = deriveSrtpKeys(masterKey, masterSalt);
    }

    private state(ssrc: number): RolloverState {
        let state = this.rollover.get(ssrc);
        if (!state) {
            state = new RolloverState();
            this.rollover.set(ssrc, state);
        }
        return state;
    }

    /** Decrypt an SRTP packet. Returns undefined when authentication fails. */
    decryptRtp(packet: Buffer): Buffer | undefined {
        if (packet.length < 12 + AUTH_TAG_LENGTH) return undefined;
        const body = packet.subarray(0, packet.length - AUTH_TAG_LENGTH);
        const tag = packet.subarray(packet.length - AUTH_TAG_LENGTH);
        const headerLength = rtpHeaderLength(body);
        if (headerLength < 0 || headerLength > body.length) return undefined;

        const ssrc = body.readUInt32BE(8);
        const seq = body.readUInt16BE(2);
        const state = this.state(ssrc);
        const roc = state.estimate(seq);

        const rocBuffer = Buffer.alloc(4);
        rocBuffer.writeUInt32BE(roc);
        if (!crypto.timingSafeEqual(hmac(this.keys.rtp.authKey, body, rocBuffer), tag)) return undefined;
        state.update(seq, roc);

        const index = (BigInt(roc) << 16n) | BigInt(seq);
        const iv = counterIv(this.keys.rtp.salt, ssrc, index);
        return Buffer.concat([body.subarray(0, headerLength), aesCtr(this.keys.rtp.encryptionKey, iv, body.subarray(headerLength))]);
    }

    /** Encrypt an RTP packet (used by tests and for audio sent back to the camera). */
    encryptRtp(packet: Buffer): Buffer {
        const headerLength = rtpHeaderLength(packet);
        const ssrc = packet.readUInt32BE(8);
        const seq = packet.readUInt16BE(2);
        const roc = this.state(ssrc).next(seq);

        const index = (BigInt(roc) << 16n) | BigInt(seq);
        const iv = counterIv(this.keys.rtp.salt, ssrc, index);
        const encrypted = Buffer.concat([packet.subarray(0, headerLength), aesCtr(this.keys.rtp.encryptionKey, iv, packet.subarray(headerLength))]);

        const rocBuffer = Buffer.alloc(4);
        rocBuffer.writeUInt32BE(roc);
        return Buffer.concat([encrypted, hmac(this.keys.rtp.authKey, encrypted, rocBuffer)]);
    }

    /** Encrypt a (compound) RTCP packet into SRTCP. */
    encryptRtcp(packet: Buffer): Buffer {
        const ssrc = packet.readUInt32BE(4);
        const index = this.srtcpIndex;
        this.srtcpIndex = (this.srtcpIndex + 1) & 0x7fffffff;

        const iv = counterIv(this.keys.rtcp.salt, ssrc, BigInt(index));
        const encrypted = Buffer.concat([packet.subarray(0, 8), aesCtr(this.keys.rtcp.encryptionKey, iv, packet.subarray(8))]);
        const trailer = Buffer.alloc(4);
        trailer.writeUInt32BE((0x80000000 | index) >>> 0);

        const authenticated = Buffer.concat([encrypted, trailer]);
        return Buffer.concat([authenticated, hmac(this.keys.rtcp.authKey, authenticated)]);
    }

    /** Decrypt an SRTCP packet. Returns undefined when authentication fails. */
    decryptRtcp(packet: Buffer): Buffer | undefined {
        if (packet.length < 8 + 4 + AUTH_TAG_LENGTH) return undefined;
        const authenticated = packet.subarray(0, packet.length - AUTH_TAG_LENGTH);
        const tag = packet.subarray(packet.length - AUTH_TAG_LENGTH);
        if (!crypto.timingSafeEqual(hmac(this.keys.rtcp.authKey, authenticated), tag)) return undefined;

        const trailer = authenticated.readUInt32BE(authenticated.length - 4);
        const encryptedFlag = (trailer & 0x80000000) !== 0;
        const index = trailer & 0x7fffffff;
        const body = authenticated.subarray(0, authenticated.length - 4);
        if (!encryptedFlag) return Buffer.from(body);

        const ssrc = body.readUInt32BE(4);
        const iv = counterIv(this.keys.rtcp.salt, ssrc, BigInt(index));
        return Buffer.concat([body.subarray(0, 8), aesCtr(this.keys.rtcp.encryptionKey, iv, body.subarray(8))]);
    }
}

/** RTCP packet types 192-223 share the RTP port when RTCP is multiplexed (RFC 5761). */
export function isRtcp(packet: Buffer): boolean {
    if (packet.length < 2) return false;
    const pt = packet[1];
    return pt >= 192 && pt <= 223;
}
