import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

import {
    AudioCodec,
    AudioSampleRate,
    chooseVideoConfig,
    decodeSetupEndpointsResponse,
    decodeSupportedAudio,
    decodeSupportedRtp,
    decodeSupportedVideo,
    encodeSelectedStreamConfig,
    encodeSetupEndpoints,
    SessionCommand,
    SetupStatus,
    SrtpSuite,
    SupportedAudioConfig,
    VideoCodec,
    VideoCodecConfig,
    VideoResolution,
} from '../hap/cameraTlv';
import { CharacteristicId, HapClient } from '../hap/HapClient';
import { Characteristic, findCharacteristic, findServices, HapAccessory, Service } from '../hap/types';
import { buildPictureLossIndication, buildReceiverReport, findSenderReport, ReceiverReportState } from './rtcp';
import { isRtcp, SrtpSession } from './srtp';

export const VIDEO_PAYLOAD_TYPE = 99;
const AUDIO_PAYLOAD_TYPE = 110;
const RTCP_INTERVAL_MS = 2000;
const NO_MEDIA_TIMEOUT_MS = 10000;

export interface StreamManagement {
    aid: number;
    setupEndpoints: CharacteristicId;
    selectedConfig: CharacteristicId;
    supportedVideo: CharacteristicId;
    supportedAudio: CharacteristicId;
    supportedRtp: CharacteristicId;
    streamingStatus?: CharacteristicId;
}

export interface CameraCapabilities {
    video: VideoCodecConfig[];
    audio: SupportedAudioConfig;
    srtpSuites: number[];
}

export interface CameraStreamOptions {
    /** The IP address the camera should send media to (this machine's LAN address). */
    localAddress: string;
    /** Highest resolution to ask for. */
    maxHeight?: number;
    /** Video bitrate to ask the camera for, in kbit/s. Fewer bits means fewer packets per second. */
    maxBitrate?: number;
    /** Which CameraRTPStreamManagement service to use, when the camera has several. */
    streamIndex?: number;
    log?: (...args: unknown[]) => void;
}

export interface StreamInfo {
    resolution: VideoResolution;
    profile: number;
    level: number;
    cameraAddress: string;
    cameraVideoPort: number;
    localVideoPort: number;
}

/** Locate the CameraRTPStreamManagement services of a camera. */
export function findStreamManagement(accessories: HapAccessory[]): StreamManagement[] {
    return findServices(accessories, Service.CameraRTPStreamManagement).flatMap((service) => {
        const id = (type: string): CharacteristicId | undefined => {
            const c = findCharacteristic(service, type);
            return c ? { aid: c.aid, iid: c.iid } : undefined;
        };
        const setupEndpoints = id(Characteristic.SetupEndpoints);
        const selectedConfig = id(Characteristic.SelectedRTPStreamConfiguration);
        const supportedVideo = id(Characteristic.SupportedVideoStreamConfiguration);
        const supportedAudio = id(Characteristic.SupportedAudioStreamConfiguration);
        const supportedRtp = id(Characteristic.SupportedRTPConfiguration);
        if (!setupEndpoints || !selectedConfig || !supportedVideo || !supportedAudio || !supportedRtp) return [];
        return [
            {
                aid: service.aid,
                setupEndpoints,
                selectedConfig,
                supportedVideo,
                supportedAudio,
                supportedRtp,
                streamingStatus: id(Characteristic.StreamingStatus),
            },
        ];
    });
}

export async function readCameraCapabilities(client: HapClient, management: StreamManagement): Promise<CameraCapabilities> {
    const values = await client.getCharacteristics([management.supportedVideo, management.supportedAudio, management.supportedRtp]);
    const get = (id: CharacteristicId) => Buffer.from(String(values.find((v) => v.aid === id.aid && v.iid === id.iid)?.value ?? ''), 'base64');
    return {
        video: decodeSupportedVideo(get(management.supportedVideo)),
        audio: decodeSupportedAudio(get(management.supportedAudio)),
        srtpSuites: decodeSupportedRtp(get(management.supportedRtp)),
    };
}

function bindUdp(): Promise<dgram.Socket> {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', reject);
        socket.bind(0, () => {
            socket.off('error', reject);
            resolve(socket);
        });
    });
}

function bitrateFor(resolution: VideoResolution): number {
    if (resolution.height >= 1080) return 2000;
    if (resolution.height >= 720) return 1200;
    return 600;
}

/**
 * One live HomeKit camera stream: negotiates the session, receives and decrypts SRTP,
 * keeps it alive with RTCP receiver reports, and emits decrypted RTP packets.
 *
 * Events: `rtp` (Buffer, H.264 RTP packet), `audio` (Buffer, AAC-ELD RTP packet), `ended` (Error | undefined)
 */
export class CameraStream extends EventEmitter {
    private videoSocket?: dgram.Socket;
    private audioSocket?: dgram.Socket;
    private sessionId?: Buffer;
    private incomingVideo?: SrtpSession;
    private incomingAudio?: SrtpSession;
    private outgoingVideo?: SrtpSession;
    private outgoingAudio?: SrtpSession;
    private cameraAddress = '';
    private cameraVideoPort = 0;
    private cameraAudioPort = 0;
    private rtcpTimer?: NodeJS.Timeout;
    private watchdog?: NodeJS.Timeout;
    private lastMediaAt = 0;
    private stopped = false;
    private readonly videoReport: ReceiverReportState;
    private readonly audioReport: ReceiverReportState;
    private readonly log: (...args: unknown[]) => void;

    info?: StreamInfo;

    constructor(
        private readonly client: HapClient,
        private readonly management: StreamManagement,
        private readonly capabilities: CameraCapabilities,
        private readonly options: CameraStreamOptions,
    ) {
        super();
        this.log = options.log ?? (() => undefined);
        const random = () => crypto.randomBytes(4).readUInt32BE(0);
        this.videoReport = { senderSsrc: random(), mediaSsrc: 0, highestSeq: 0, cycles: 0, lastSr: 0, lastSrReceivedAt: 0 };
        this.audioReport = { senderSsrc: random(), mediaSsrc: 0, highestSeq: 0, cycles: 0, lastSr: 0, lastSrReceivedAt: 0 };
    }

    async start(): Promise<StreamInfo> {
        const video = chooseVideoConfig(this.capabilities.video, this.options.maxHeight ?? 1080);
        if (!video) throw new Error('The camera does not offer H.264 video');
        if (!this.capabilities.srtpSuites.includes(SrtpSuite.AES_CM_128_HMAC_SHA1_80)) {
            throw new Error(`The camera does not offer AES_CM_128_HMAC_SHA1_80 SRTP (offers ${this.capabilities.srtpSuites.join(', ')})`);
        }

        this.videoSocket = await bindUdp();
        this.audioSocket = await bindUdp();
        const videoPort = this.videoSocket.address().port;
        const audioPort = this.audioSocket.address().port;

        this.sessionId = crypto.randomBytes(16);
        const ourVideo = { suite: SrtpSuite.AES_CM_128_HMAC_SHA1_80, masterKey: crypto.randomBytes(16), masterSalt: crypto.randomBytes(14) };
        const ourAudio = { suite: SrtpSuite.AES_CM_128_HMAC_SHA1_80, masterKey: crypto.randomBytes(16), masterSalt: crypto.randomBytes(14) };

        const setup = encodeSetupEndpoints({
            sessionId: this.sessionId,
            controller: { ipv6: this.options.localAddress.includes(':'), address: this.options.localAddress, videoPort, audioPort },
            video: ourVideo,
            audio: ourAudio,
        });

        const response = decodeSetupEndpointsResponse(await this.client.writeReadTlv(this.management.setupEndpoints, setup));
        if (response.status !== SetupStatus.Success) {
            await this.closeSockets();
            throw new Error(response.status === SetupStatus.Busy ? 'The camera is busy with another stream' : 'The camera rejected the stream setup');
        }

        // The camera encrypts with the keys it returns; we encrypt our RTCP with the keys we sent.
        const theirVideo = response.video?.masterKey.length === 16 ? response.video : ourVideo;
        const theirAudio = response.audio?.masterKey.length === 16 ? response.audio : ourAudio;
        this.incomingVideo = new SrtpSession(theirVideo.masterKey, theirVideo.masterSalt);
        this.incomingAudio = new SrtpSession(theirAudio.masterKey, theirAudio.masterSalt);
        this.outgoingVideo = new SrtpSession(ourVideo.masterKey, ourVideo.masterSalt);
        this.outgoingAudio = new SrtpSession(ourAudio.masterKey, ourAudio.masterSalt);

        this.cameraAddress = response.accessory?.address || this.client.host;
        this.cameraVideoPort = response.accessory?.videoPort ?? 0;
        this.cameraAudioPort = response.accessory?.audioPort ?? 0;
        this.videoReport.mediaSsrc = response.videoSsrc ?? 0;
        this.audioReport.mediaSsrc = response.audioSsrc ?? 0;

        this.videoSocket.on('message', (msg) => this.onVideo(msg));
        this.audioSocket.on('message', (msg) => this.onAudio(msg));

        const audioCodec =
            this.capabilities.audio.codecs.find((c) => c.codec === AudioCodec.AAC_ELD) ??
            this.capabilities.audio.codecs.find((c) => c.codec === AudioCodec.OPUS) ??
            this.capabilities.audio.codecs[0];

        const selected = encodeSelectedStreamConfig({
            sessionId: this.sessionId,
            command: SessionCommand.Start,
            video: {
                codec: VideoCodec.H264,
                profile: video.profile,
                level: video.level,
                packetizationMode: video.packetizationMode,
                resolution: video.resolution,
                rtp: {
                    payloadType: VIDEO_PAYLOAD_TYPE,
                    ssrc: this.videoReport.senderSsrc,
                    maxBitrate: this.options.maxBitrate ?? bitrateFor(video.resolution),
                    rtcpInterval: 0.5,
                    maxMtu: 1378,
                },
            },
            audio: audioCodec
                ? {
                      codec: audioCodec.codec,
                      channels: audioCodec.channels || 1,
                      bitrateMode: audioCodec.bitrateMode,
                      sampleRate: audioCodec.sampleRates.includes(AudioSampleRate.KHz16)
                          ? AudioSampleRate.KHz16
                          : (audioCodec.sampleRates[0] ?? AudioSampleRate.KHz16),
                      packetTime: 30,
                      rtp: { payloadType: AUDIO_PAYLOAD_TYPE, ssrc: this.audioReport.senderSsrc, maxBitrate: 24, rtcpInterval: 5, comfortNoisePayloadType: 13 },
                      comfortNoise: false,
                  }
                : undefined,
        });

        await this.client.putCharacteristics([{ ...this.management.selectedConfig, value: selected.toString('base64') }]);

        this.info = {
            resolution: video.resolution,
            profile: video.profile,
            level: video.level,
            cameraAddress: this.cameraAddress,
            cameraVideoPort: this.cameraVideoPort,
            localVideoPort: videoPort,
        };
        this.log(
            `Stream started: ${video.resolution.width}x${video.resolution.height}@${video.resolution.fps}, camera ${this.cameraAddress}:${this.cameraVideoPort} -> local ${this.options.localAddress}:${videoPort}`,
        );

        // Send a first report right away; it also opens a path through any local firewall.
        this.sendReports();
        this.rtcpTimer = setInterval(() => this.sendReports(), RTCP_INTERVAL_MS);
        this.lastMediaAt = Date.now();
        this.watchdog = setInterval(() => {
            if (Date.now() - this.lastMediaAt > NO_MEDIA_TIMEOUT_MS) {
                this.finish(new Error(`No video received for ${NO_MEDIA_TIMEOUT_MS / 1000}s (is UDP port ${videoPort} reachable from the camera?)`));
            }
        }, 2000);

        return this.info;
    }

    /** Ask the camera for a new keyframe. */
    requestKeyframe(): void {
        if (!this.outgoingVideo || !this.videoSocket || !this.videoReport.mediaSsrc) return;
        const compound = Buffer.concat([buildReceiverReport(this.videoReport), buildPictureLossIndication(this.videoReport.senderSsrc, this.videoReport.mediaSsrc)]);
        this.send(this.videoSocket, this.outgoingVideo.encryptRtcp(compound), this.cameraVideoPort);
    }

    async stop(): Promise<void> {
        if (this.stopped) return;
        if (this.sessionId) {
            const end = encodeSelectedStreamConfig({ sessionId: this.sessionId, command: SessionCommand.End });
            await this.client
                .putCharacteristics([{ ...this.management.selectedConfig, value: end.toString('base64') }])
                .catch((error) => this.log('Ending the stream failed:', error.message));
        }
        this.finish();
    }

    private finish(error?: Error): void {
        if (this.stopped) return;
        this.stopped = true;
        clearInterval(this.rtcpTimer);
        clearInterval(this.watchdog);
        this.closeSockets().catch(() => undefined);
        if (error) {
            // Best effort: tell the camera the session is over.
            if (this.sessionId) {
                const end = encodeSelectedStreamConfig({ sessionId: this.sessionId, command: SessionCommand.End });
                this.client.putCharacteristics([{ ...this.management.selectedConfig, value: end.toString('base64') }]).catch(() => undefined);
            }
        }
        this.emit('ended', error);
    }

    private async closeSockets(): Promise<void> {
        for (const socket of [this.videoSocket, this.audioSocket]) {
            try {
                socket?.close();
            } catch {
                // already closed
            }
        }
    }

    private send(socket: dgram.Socket, data: Buffer, port: number): void {
        if (!port || this.stopped) return;
        socket.send(data, port, this.cameraAddress, (error) => {
            if (error) this.log('UDP send failed:', error.message);
        });
    }

    private sendReports(): void {
        if (this.videoSocket && this.outgoingVideo && this.videoReport.mediaSsrc) {
            this.send(this.videoSocket, this.outgoingVideo.encryptRtcp(buildReceiverReport(this.videoReport)), this.cameraVideoPort);
        }
        if (this.audioSocket && this.outgoingAudio && this.audioReport.mediaSsrc) {
            this.send(this.audioSocket, this.outgoingAudio.encryptRtcp(buildReceiverReport(this.audioReport)), this.cameraAudioPort);
        }
    }

    private trackSequence(report: ReceiverReportState, packet: Buffer): void {
        const seq = packet.readUInt16BE(2);
        if (!report.mediaSsrc) report.mediaSsrc = packet.readUInt32BE(8);
        if (seq < report.highestSeq && report.highestSeq - seq > 32768) report.cycles++;
        if (seq > report.highestSeq || report.highestSeq - seq > 32768) report.highestSeq = seq;
    }

    private onVideo(message: Buffer): void {
        if (isRtcp(message)) {
            const rtcp = this.incomingVideo?.decryptRtcp(message);
            const sr = rtcp && findSenderReport(rtcp);
            if (sr) {
                this.videoReport.lastSr = sr.lsr;
                this.videoReport.lastSrReceivedAt = Date.now();
            }
            return;
        }
        const packet = this.incomingVideo?.decryptRtp(message);
        if (!packet) return;
        this.lastMediaAt = Date.now();
        this.trackSequence(this.videoReport, packet);
        this.emit('rtp', packet);
    }

    private onAudio(message: Buffer): void {
        if (isRtcp(message)) {
            const rtcp = this.incomingAudio?.decryptRtcp(message);
            const sr = rtcp && findSenderReport(rtcp);
            if (sr) {
                this.audioReport.lastSr = sr.lsr;
                this.audioReport.lastSrReceivedAt = Date.now();
            }
            return;
        }
        const packet = this.incomingAudio?.decryptRtp(message);
        if (!packet) return;
        this.trackSequence(this.audioReport, packet);
        this.emit('audio', packet);
    }
}
