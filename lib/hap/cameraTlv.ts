import { decodeTlv, encodeTlv, f32, readUInt, tlvGet, tlvGetAll, TlvItem, u16, u32, u8 } from './tlv8';

/**
 * TLV structures of the HomeKit CameraRTPStreamManagement service (HAP spec chapter 11).
 * All integers are little-endian.
 */

export const VideoCodec = { H264: 0, H265: 1 } as const;
export const H264Profile = { Baseline: 0, Main: 1, High: 2 } as const;
export const H264Level = { L3_1: 0, L3_2: 1, L4: 2 } as const;
export const AudioCodec = { PCMU: 0, PCMA: 1, AAC_ELD: 2, OPUS: 3, MSBC: 4, AMR: 5, AMR_WB: 6 } as const;
export const AudioSampleRate = { KHz8: 0, KHz16: 1, KHz24: 2 } as const;
export const SrtpSuite = { AES_CM_128_HMAC_SHA1_80: 0, AES_256_CM_HMAC_SHA1_80: 1, NONE: 2 } as const;
export const SessionCommand = { End: 0, Start: 1, Suspend: 2, Resume: 3, Reconfigure: 4 } as const;
export const SetupStatus = { Success: 0, Busy: 1, Error: 2 } as const;
export const StreamingState = { Available: 0, InUse: 1, Unavailable: 2 } as const;

export interface VideoResolution {
    width: number;
    height: number;
    fps: number;
}

export interface VideoCodecConfig {
    codec: number;
    profiles: number[];
    levels: number[];
    packetizationModes: number[];
    resolutions: VideoResolution[];
}

export interface AudioCodecConfig {
    codec: number;
    channels: number;
    bitrateMode: number;
    sampleRates: number[];
}

export interface SupportedAudioConfig {
    codecs: AudioCodecConfig[];
    comfortNoise: boolean;
}

export interface SrtpParams {
    suite: number;
    masterKey: Buffer;
    masterSalt: Buffer;
}

export interface Address {
    ipv6: boolean;
    address: string;
    videoPort: number;
    audioPort: number;
}

export interface SetupEndpointsRequest {
    sessionId: Buffer; // 16 bytes
    controller: Address;
    video: SrtpParams;
    audio: SrtpParams;
}

export interface SetupEndpointsResponse {
    sessionId: Buffer;
    status: number;
    accessory?: Address;
    video?: SrtpParams;
    audio?: SrtpParams;
    videoSsrc?: number;
    audioSsrc?: number;
}

export interface RtpParams {
    payloadType: number;
    ssrc: number;
    maxBitrate: number; // kbps
    rtcpInterval: number; // seconds
    maxMtu?: number;
    comfortNoisePayloadType?: number;
}

export interface SelectedStreamConfig {
    sessionId: Buffer;
    command: number;
    video?: {
        codec: number;
        profile: number;
        level: number;
        packetizationMode: number;
        resolution: VideoResolution;
        rtp: RtpParams;
    };
    audio?: {
        codec: number;
        channels: number;
        bitrateMode: number;
        sampleRate: number;
        packetTime: number; // ms
        rtp: RtpParams;
        comfortNoise: boolean;
    };
}

// ---- Supported configurations (read) ----

function decodeVideoCodecConfig(items: TlvItem[]): VideoCodecConfig {
    const params = decodeTlv(tlvGet(items, 2) ?? Buffer.alloc(0));
    return {
        codec: readUInt(tlvGet(items, 1)) ?? 0,
        profiles: tlvGetAll(params, 1).map((v) => readUInt(v)!),
        levels: tlvGetAll(params, 2).map((v) => readUInt(v)!),
        packetizationModes: tlvGetAll(params, 3).map((v) => readUInt(v)!),
        resolutions: tlvGetAll(items, 3).map((value) => {
            const attr = decodeTlv(value);
            return {
                width: readUInt(tlvGet(attr, 1)) ?? 0,
                height: readUInt(tlvGet(attr, 2)) ?? 0,
                fps: readUInt(tlvGet(attr, 3)) ?? 0,
            };
        }),
    };
}

export function decodeSupportedVideo(buffer: Buffer): VideoCodecConfig[] {
    return tlvGetAll(decodeTlv(buffer), 1).map((value) => decodeVideoCodecConfig(decodeTlv(value)));
}

export function decodeSupportedAudio(buffer: Buffer): SupportedAudioConfig {
    const items = decodeTlv(buffer);
    return {
        comfortNoise: readUInt(tlvGet(items, 2)) === 1,
        codecs: tlvGetAll(items, 1).map((value) => {
            const codec = decodeTlv(value);
            const params = decodeTlv(tlvGet(codec, 2) ?? Buffer.alloc(0));
            return {
                codec: readUInt(tlvGet(codec, 1)) ?? 0,
                channels: readUInt(tlvGet(params, 1)) ?? 1,
                bitrateMode: readUInt(tlvGet(params, 2)) ?? 0,
                sampleRates: tlvGetAll(params, 3).map((v) => readUInt(v)!),
            };
        }),
    };
}

export function decodeSupportedRtp(buffer: Buffer): number[] {
    return tlvGetAll(decodeTlv(buffer), 2).map((v) => readUInt(v)!);
}

// ---- Setup endpoints ----

function encodeAddress(address: Address): Buffer {
    return encodeTlv([
        [1, address.ipv6 ? 1 : 0],
        [2, address.address],
        [3, u16(address.videoPort)],
        [4, u16(address.audioPort)],
    ]);
}

function decodeAddress(buffer: Buffer): Address {
    const items = decodeTlv(buffer);
    return {
        ipv6: readUInt(tlvGet(items, 1)) === 1,
        address: tlvGet(items, 2)?.toString('utf8') ?? '',
        videoPort: readUInt(tlvGet(items, 3)) ?? 0,
        audioPort: readUInt(tlvGet(items, 4)) ?? 0,
    };
}

function encodeSrtp(params: SrtpParams): Buffer {
    return encodeTlv([
        [1, params.suite],
        [2, params.masterKey],
        [3, params.masterSalt],
    ]);
}

function decodeSrtp(buffer: Buffer): SrtpParams {
    const items = decodeTlv(buffer);
    return {
        suite: readUInt(tlvGet(items, 1)) ?? 0,
        masterKey: tlvGet(items, 2) ?? Buffer.alloc(0),
        masterSalt: tlvGet(items, 3) ?? Buffer.alloc(0),
    };
}

export function encodeSetupEndpoints(request: SetupEndpointsRequest): Buffer {
    return encodeTlv([
        [1, request.sessionId],
        [3, encodeAddress(request.controller)],
        [4, encodeSrtp(request.video)],
        [5, encodeSrtp(request.audio)],
    ]);
}

export function decodeSetupEndpointsResponse(buffer: Buffer): SetupEndpointsResponse {
    const items = decodeTlv(buffer);
    const accessory = tlvGet(items, 3);
    const video = tlvGet(items, 4);
    const audio = tlvGet(items, 5);
    return {
        sessionId: tlvGet(items, 1) ?? Buffer.alloc(0),
        status: readUInt(tlvGet(items, 2)) ?? SetupStatus.Error,
        accessory: accessory ? decodeAddress(accessory) : undefined,
        video: video ? decodeSrtp(video) : undefined,
        audio: audio ? decodeSrtp(audio) : undefined,
        videoSsrc: readUInt(tlvGet(items, 6)),
        audioSsrc: readUInt(tlvGet(items, 7)),
    };
}

// ---- Selected stream configuration ----

function encodeRtp(rtp: RtpParams, audio: boolean): Buffer {
    const items: Array<[number, Buffer | number]> = [
        [1, u8(rtp.payloadType)],
        [2, u32(rtp.ssrc)],
        [3, u16(rtp.maxBitrate)],
        [4, f32(rtp.rtcpInterval)],
    ];
    if (!audio && rtp.maxMtu) items.push([5, u16(rtp.maxMtu)]);
    if (audio && rtp.comfortNoisePayloadType !== undefined) items.push([6, u8(rtp.comfortNoisePayloadType)]);
    return encodeTlv(items);
}

export function encodeSelectedStreamConfig(config: SelectedStreamConfig): Buffer {
    const items: Array<[number, Buffer]> = [
        [
            1,
            encodeTlv([
                [1, config.sessionId],
                [2, config.command],
            ]),
        ],
    ];

    if (config.video) {
        const v = config.video;
        items.push([
            2,
            encodeTlv([
                [1, v.codec],
                [
                    2,
                    encodeTlv([
                        [1, v.profile],
                        [2, v.level],
                        [3, v.packetizationMode],
                    ]),
                ],
                [
                    3,
                    encodeTlv([
                        [1, u16(v.resolution.width)],
                        [2, u16(v.resolution.height)],
                        [3, v.resolution.fps],
                    ]),
                ],
                [4, encodeRtp(v.rtp, false)],
            ]),
        ]);
    }

    if (config.audio) {
        const a = config.audio;
        items.push([
            3,
            encodeTlv([
                [1, a.codec],
                [
                    2,
                    encodeTlv([
                        [1, a.channels],
                        [2, a.bitrateMode],
                        [3, a.sampleRate],
                        [4, a.packetTime],
                    ]),
                ],
                [3, encodeRtp(a.rtp, true)],
                [4, a.comfortNoise ? 1 : 0],
            ]),
        ]);
    }

    return encodeTlv(items);
}

/** Decode StreamingStatus (characteristic 120). */
export function decodeStreamingStatus(buffer: Buffer): number {
    return readUInt(tlvGet(decodeTlv(buffer), 1)) ?? StreamingState.Unavailable;
}

/** Pick the best video settings the camera supports, up to `maxHeight`. */
export function chooseVideoConfig(
    supported: VideoCodecConfig[],
    maxHeight = 1080,
): { profile: number; level: number; packetizationMode: number; resolution: VideoResolution } | undefined {
    const h264 = supported.find((c) => c.codec === VideoCodec.H264);
    if (!h264 || h264.resolutions.length === 0) return undefined;

    // Stay in the camera's native shape: the G4 also lists 4:3 modes (1280x960, 640x480) next to 16:9.
    const largest = [...h264.resolutions].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const aspect = largest.width / largest.height;
    const fits = h264.resolutions.filter((r) => r.height <= maxHeight);
    const sameShape = fits.filter((r) => Math.abs(r.width / r.height - aspect) < 0.05);
    const resolutions = (sameShape.length ? sameShape : fits).sort((a, b) => b.width * b.height - a.width * a.height || b.fps - a.fps);
    const resolution = resolutions[0] ?? h264.resolutions[0];

    const profile = h264.profiles.includes(H264Profile.Main) ? H264Profile.Main : (h264.profiles[0] ?? H264Profile.Main);
    const level = h264.levels.length ? Math.max(...h264.levels) : H264Level.L4;
    const packetizationMode = h264.packetizationModes[0] ?? 0;

    return { profile, level, packetizationMode, resolution };
}
