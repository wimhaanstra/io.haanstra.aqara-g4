import { deriveSrtpKeys, isRtcp, SrtpSession } from '../lib/stream/srtp';

const masterKey = Buffer.from('E1F97A0D3E018BE0D64FA32C06DE4139', 'hex');
const masterSalt = Buffer.from('0EC675AD498AFEEBB6960B3AABE6', 'hex');

function rtpPacket(seq: number, ssrc: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = 99;
    header.writeUInt16BE(seq, 2);
    header.writeUInt32BE(seq * 3000, 4);
    header.writeUInt32BE(ssrc, 8);
    return Buffer.concat([header, payload]);
}

describe('SRTP key derivation (RFC 3711 B.3)', () => {
    it('derives the published session keys', () => {
        const { rtp } = deriveSrtpKeys(masterKey, masterSalt);
        expect(rtp.encryptionKey.toString('hex').toUpperCase()).toBe('C61E7A93744F39EE10734AFE3FF7A087');
        expect(rtp.salt.toString('hex').toUpperCase()).toBe('30CBBC08863D8C85D49DB34A9AE1');
        expect(rtp.authKey.toString('hex').toUpperCase()).toBe('CEBE321F6FF7716B6FD4AB49AF256A156D38BAA4');
    });
});

describe('SRTP session', () => {
    it('round-trips RTP and rejects tampered packets', () => {
        const sender = new SrtpSession(masterKey, masterSalt);
        const receiver = new SrtpSession(masterKey, masterSalt);
        const plain = rtpPacket(1000, 0x12345678, Buffer.from('hello h264 world'));

        const encrypted = sender.encryptRtp(plain);
        expect(encrypted.length).toBe(plain.length + 10);
        expect(encrypted.subarray(12, plain.length).equals(plain.subarray(12))).toBe(false);
        expect(receiver.decryptRtp(encrypted)!.equals(plain)).toBe(true);

        const tampered = Buffer.from(sender.encryptRtp(rtpPacket(1001, 0x12345678, Buffer.from('x'))));
        tampered[14] ^= 1;
        expect(receiver.decryptRtp(tampered)).toBeUndefined();
    });

    it('follows the rollover counter across a sequence number wrap', () => {
        const sender = new SrtpSession(masterKey, masterSalt);
        const receiver = new SrtpSession(masterKey, masterSalt);
        for (const seq of [65533, 65534, 65535, 0, 1, 2]) {
            const plain = rtpPacket(seq, 42, Buffer.from(`frame ${seq}`));
            expect(receiver.decryptRtp(sender.encryptRtp(plain))?.equals(plain)).toBe(true);
        }
    });

    it('round-trips SRTCP', () => {
        const sender = new SrtpSession(masterKey, masterSalt);
        const receiver = new SrtpSession(masterKey, masterSalt);
        const rr = Buffer.from(`81c900070000000100000002${'00'.repeat(20)}`, 'hex');
        const encrypted = sender.encryptRtcp(rr);
        expect(isRtcp(encrypted)).toBe(true);
        expect(receiver.decryptRtcp(encrypted)!.equals(rr)).toBe(true);
    });

    it('tells RTCP from RTP', () => {
        expect(isRtcp(rtpPacket(1, 1, Buffer.alloc(4)))).toBe(false);
        expect(isRtcp(Buffer.from([0x80, 200]))).toBe(true);
    });
});
