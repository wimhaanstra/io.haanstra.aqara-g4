import {
    AudioCodec,
    chooseVideoConfig,
    decodeSetupEndpointsResponse,
    decodeSupportedAudio,
    decodeSupportedVideo,
    encodeSelectedStreamConfig,
    encodeSetupEndpoints,
    SessionCommand,
} from '../lib/hap/cameraTlv';
import { decodeTlv, encodeTlv, readUInt, tlvGet, u16, u32 } from '../lib/hap/tlv8';

function resolution(width: number, height: number, fps: number): Buffer {
    return encodeTlv([
        [1, u16(width)],
        [2, u16(height)],
        [3, fps],
    ]);
}

/** Supported video config as a camera like the G4 would report it. */
const supportedVideo = encodeTlv([
    [
        1,
        encodeTlv([
            [1, 0],
            [
                2,
                encodeTlv([
                    [1, 0],
                    [0, Buffer.alloc(0)],
                    [1, 1],
                    [2, 0],
                    [0, Buffer.alloc(0)],
                    [2, 2],
                    [3, 0],
                ]),
            ],
            [3, resolution(640, 360, 30)],
            [0, Buffer.alloc(0)],
            [3, resolution(1920, 1080, 30)],
            [0, Buffer.alloc(0)],
            [3, resolution(1280, 720, 30)],
            [0, Buffer.alloc(0)],
            [3, resolution(3840, 2160, 15)],
        ]),
    ],
]);

describe('camera TLVs', () => {
    it('decodes supported video and picks the best H.264 setup up to 1080p', () => {
        const supported = decodeSupportedVideo(supportedVideo);
        expect(supported).toHaveLength(1);
        expect(supported[0].resolutions).toHaveLength(4);
        expect(supported[0].profiles).toEqual([0, 1]);

        const choice = chooseVideoConfig(supported)!;
        expect(choice.resolution).toEqual({ width: 1920, height: 1080, fps: 30 });
        expect(choice.profile).toBe(1);
        expect(choice.level).toBe(2);
        expect(chooseVideoConfig(supported, 720)!.resolution.height).toBe(720);
    });

    it('keeps the 16:9 shape when the camera also lists 4:3 modes (like the G4)', () => {
        const res = (width: number, height: number) => ({ width, height, fps: 30 });
        const g4 = [
            {
                codec: 0,
                profiles: [1],
                levels: [0, 2],
                packetizationModes: [0],
                resolutions: [res(1920, 1080), res(1280, 720), res(640, 360), res(1280, 960), res(1024, 768), res(640, 480)],
            },
        ];
        expect(chooseVideoConfig(g4, 1080)!.resolution).toEqual(res(1920, 1080));
        expect(chooseVideoConfig(g4, 720)!.resolution).toEqual(res(1280, 720));
        expect(chooseVideoConfig(g4, 480)!.resolution).toEqual(res(640, 360));
        expect(chooseVideoConfig(g4, 360)!.resolution).toEqual(res(640, 360));
    });

    it('decodes supported audio', () => {
        const buffer = encodeTlv([
            [
                1,
                encodeTlv([
                    [1, AudioCodec.AAC_ELD],
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
        const audio = decodeSupportedAudio(buffer);
        expect(audio.codecs[0]).toEqual({ codec: AudioCodec.AAC_ELD, channels: 1, bitrateMode: 0, sampleRates: [1] });
        expect(audio.comfortNoise).toBe(false);
    });

    it('encodes SetupEndpoints with little-endian ports', () => {
        const sessionId = Buffer.alloc(16, 0xab);
        const encoded = decodeTlv(
            encodeSetupEndpoints({
                sessionId,
                controller: { ipv6: false, address: '192.168.1.10', videoPort: 50000, audioPort: 50002 },
                video: { suite: 0, masterKey: Buffer.alloc(16, 1), masterSalt: Buffer.alloc(14, 2) },
                audio: { suite: 0, masterKey: Buffer.alloc(16, 3), masterSalt: Buffer.alloc(14, 4) },
            }),
        );
        expect(tlvGet(encoded, 1)).toEqual(sessionId);
        const address = decodeTlv(tlvGet(encoded, 3)!);
        expect(tlvGet(address, 2)!.toString()).toBe('192.168.1.10');
        expect(tlvGet(address, 3)!.readUInt16LE(0)).toBe(50000);
        expect(decodeTlv(tlvGet(encoded, 5)!).find((i) => i.type === 2)!.value).toEqual(Buffer.alloc(16, 3));
    });

    it('decodes a SetupEndpoints response', () => {
        const response = encodeTlv([
            [1, Buffer.alloc(16, 0xab)],
            [2, 0],
            [
                3,
                encodeTlv([
                    [1, 0],
                    [2, '192.168.1.50'],
                    [3, u16(51000)],
                    [4, u16(51002)],
                ]),
            ],
            [
                4,
                encodeTlv([
                    [1, 0],
                    [2, Buffer.alloc(16, 9)],
                    [3, Buffer.alloc(14, 8)],
                ]),
            ],
            [6, u32(0xcafebabe)],
            [7, u32(7)],
        ]);
        const decoded = decodeSetupEndpointsResponse(response);
        expect(decoded.status).toBe(0);
        expect(decoded.accessory).toEqual({ ipv6: false, address: '192.168.1.50', videoPort: 51000, audioPort: 51002 });
        expect(decoded.video!.masterKey).toEqual(Buffer.alloc(16, 9));
        expect(decoded.videoSsrc).toBe(0xcafebabe);
        expect(decoded.audioSsrc).toBe(7);
    });

    it('encodes a start command with video and audio parameters', () => {
        const encoded = decodeTlv(
            encodeSelectedStreamConfig({
                sessionId: Buffer.alloc(16, 1),
                command: SessionCommand.Start,
                video: {
                    codec: 0,
                    profile: 1,
                    level: 2,
                    packetizationMode: 0,
                    resolution: { width: 1920, height: 1080, fps: 30 },
                    rtp: { payloadType: 99, ssrc: 1234, maxBitrate: 2000, rtcpInterval: 0.5, maxMtu: 1378 },
                },
                audio: {
                    codec: AudioCodec.AAC_ELD,
                    channels: 1,
                    bitrateMode: 0,
                    sampleRate: 1,
                    packetTime: 30,
                    rtp: { payloadType: 110, ssrc: 5678, maxBitrate: 24, rtcpInterval: 5, comfortNoisePayloadType: 13 },
                    comfortNoise: false,
                },
            }),
        );

        const control = decodeTlv(tlvGet(encoded, 1)!);
        expect(readUInt(tlvGet(control, 2))).toBe(SessionCommand.Start);

        const video = decodeTlv(tlvGet(encoded, 2)!);
        const attributes = decodeTlv(tlvGet(video, 3)!);
        expect(readUInt(tlvGet(attributes, 1))).toBe(1920);
        const rtp = decodeTlv(tlvGet(video, 4)!);
        expect(readUInt(tlvGet(rtp, 1))).toBe(99);
        expect(readUInt(tlvGet(rtp, 2))).toBe(1234);
        expect(tlvGet(rtp, 4)!.readFloatLE(0)).toBeCloseTo(0.5);
        expect(readUInt(tlvGet(rtp, 5))).toBe(1378);

        const audio = decodeTlv(tlvGet(encoded, 3)!);
        expect(readUInt(tlvGet(audio, 1))).toBe(AudioCodec.AAC_ELD);
        expect(readUInt(tlvGet(decodeTlv(tlvGet(audio, 3)!), 6))).toBe(13);
    });
});
