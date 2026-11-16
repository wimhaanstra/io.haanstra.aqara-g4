import dgram from 'node:dgram';

import { HapClient } from '../../lib/hap/HapClient';
import { HapConnection } from '../../lib/hap/HapConnection';
import { pairSetup } from '../../lib/hap/pairing';
import { decodeTlv, encodeTlv, readUInt, tlvGet, u16, u32 } from '../../lib/hap/tlv8';
import { CameraStream, findStreamManagement, readCameraCapabilities } from '../../lib/stream/CameraStream';
import { isRtcp, SrtpSession } from '../../lib/stream/srtp';
import { FakeAccessory } from './fakeAccessory';

export const CAMERA_ACCESSORIES = {
    accessories: [
        {
            aid: 1,
            services: [
                {
                    iid: 30,
                    type: '110',
                    characteristics: [
                        { iid: 31, type: '114', perms: ['pr'] },
                        { iid: 32, type: '115', perms: ['pr'] },
                        { iid: 33, type: '116', perms: ['pr'] },
                        { iid: 34, type: '117', perms: ['pr', 'pw'] },
                        { iid: 35, type: '118', perms: ['pr', 'pw'] },
                        { iid: 36, type: '120', perms: ['pr', 'ev'] },
                    ],
                },
            ],
        },
    ],
};

const SUPPORTED_VIDEO = encodeTlv([
    [
        1,
        encodeTlv([
            [1, 0],
            [
                2,
                encodeTlv([
                    [1, 1],
                    [2, 2],
                    [3, 0],
                ]),
            ],
            [
                3,
                encodeTlv([
                    [1, u16(1280)],
                    [2, u16(720)],
                    [3, 30],
                ]),
            ],
        ]),
    ],
]);
const SUPPORTED_AUDIO = encodeTlv([
    [
        1,
        encodeTlv([
            [1, 2],
            [
                2,
                encodeTlv([
                    [1, 1],
                    [2, 0],
                    [3, 1],
                ]),
            ],
        ]),
    ],
    [2, 0],
]);
const SUPPORTED_RTP = encodeTlv([[2, 0]]);

/** Simulates the camera side of a HomeKit stream: answers SetupEndpoints and sends SRTP H.264. */
export class FakeCamera {
    readonly socket = dgram.createSocket('udp4');
    private srtp?: SrtpSession;
    private controllerRtcp?: SrtpSession;
    private target?: { host: string; port: number };
    private timer?: NodeJS.Timeout;
    private seq = 1000;
    private frame = 0;
    started = 0;
    ended = 0;
    rtcpReceived = 0;
    pliReceived = 0;

    async listen(): Promise<number> {
        await new Promise<void>((resolve) => this.socket.bind(0, '127.0.0.1', resolve));
        this.socket.on('message', (msg) => {
            if (!isRtcp(msg)) return;
            const rtcp = this.controllerRtcp?.decryptRtcp(msg);
            if (!rtcp) return;
            this.rtcpReceived++;
            for (let offset = 0; offset + 4 <= rtcp.length; offset += (rtcp.readUInt16BE(offset + 2) + 1) * 4) {
                if (rtcp[offset + 1] === 206 && (rtcp[offset] & 0x1f) === 1) {
                    this.pliReceived++;
                    this.frame = 0; // next frame is a keyframe
                }
            }
        });
        return this.socket.address().port;
    }

    attach(accessory: FakeAccessory, port: number): void {
        accessory.values.set('1.31', SUPPORTED_VIDEO.toString('base64'));
        accessory.values.set('1.32', SUPPORTED_AUDIO.toString('base64'));
        accessory.values.set('1.33', SUPPORTED_RTP.toString('base64'));
        accessory.onWrite = (key, value) => {
            const tlv = decodeTlv(Buffer.from(String(value), 'base64'));
            if (key === '1.35') {
                const address = decodeTlv(tlvGet(tlv, 3)!);
                const video = decodeTlv(tlvGet(tlv, 4)!);
                const key16 = tlvGet(video, 2)!;
                const salt = tlvGet(video, 3)!;
                this.srtp = new SrtpSession(key16, salt);
                this.controllerRtcp = new SrtpSession(key16, salt);
                this.target = { host: tlvGet(address, 2)!.toString(), port: readUInt(tlvGet(address, 3))! };
                return encodeTlv([
                    [1, tlvGet(tlv, 1)!],
                    [2, 0],
                    [
                        3,
                        encodeTlv([
                            [1, 0],
                            [2, '127.0.0.1'],
                            [3, u16(port)],
                            [4, u16(port)],
                        ]),
                    ],
                    [4, tlvGet(tlv, 4)!],
                    [5, tlvGet(tlv, 5)!],
                    [6, u32(0x1111)],
                    [7, u32(0x2222)],
                ]).toString('base64');
            }
            if (key === '1.34') {
                const command = readUInt(tlvGet(decodeTlv(tlvGet(tlv, 1)!), 2));
                if (command === 1) this.start();
                if (command === 0) this.stop();
            }
            return undefined;
        };
    }

    private packet(nal: Buffer, marker: boolean): Buffer {
        const header = Buffer.alloc(12);
        header[0] = 0x80;
        header[1] = (marker ? 0x80 : 0) | 99;
        header.writeUInt16BE(this.seq++ & 0xffff, 2);
        header.writeUInt32BE((this.frame * 3000) >>> 0, 4);
        header.writeUInt32BE(0x1111, 8);
        return Buffer.concat([header, nal]);
    }

    private send(nal: Buffer, marker: boolean): void {
        if (!this.srtp || !this.target) return;
        this.socket.send(this.srtp.encryptRtp(this.packet(nal, marker)), this.target.port, this.target.host);
    }

    private start(): void {
        this.started++;
        this.frame = 0;
        clearInterval(this.timer);
        this.timer = setInterval(() => {
            if (this.frame % 30 === 0) {
                this.send(Buffer.from([0x67, 0x4d, 0x00, 0x1f, 0xaa]), false); // SPS
                this.send(Buffer.from([0x68, 0xee, 0x3c, 0x80]), false); // PPS
                this.send(Buffer.concat([Buffer.from([0x65]), Buffer.alloc(200, 1)]), true); // IDR
            } else {
                this.send(Buffer.concat([Buffer.from([0x41]), Buffer.alloc(100, 2)]), true); // P
            }
            this.frame++;
        }, 33);
    }

    stop(): void {
        if (this.timer) this.ended++;
        clearInterval(this.timer);
        this.timer = undefined;
    }

    close(): void {
        this.stop();
        this.socket.close();
    }
}

/** A paired HapClient talking to a FakeAccessory that streams like a camera. */
export async function startFakeCameraSetup() {
    const accessory = new FakeAccessory('031-45-154', CAMERA_ACCESSORIES);
    const port = await accessory.listen();
    const camera = new FakeCamera();
    camera.attach(accessory, await camera.listen());

    const connection = new HapConnection('127.0.0.1', port);
    await connection.connect();
    const pairing = await pairSetup(connection, '031-45-154');
    connection.close();

    const client = new HapClient({ host: '127.0.0.1', port }, pairing);
    client.start();
    await client.ensureConnected();

    const createStream = async () => {
        const [management] = findStreamManagement(await client.getAccessories());
        const capabilities = await readCameraCapabilities(client, management);
        return new CameraStream(client, management, capabilities, { localAddress: '127.0.0.1' });
    };

    const close = async () => {
        client.stop();
        camera.close();
        await accessory.close();
    };

    return { accessory, camera, client, createStream, close };
}
