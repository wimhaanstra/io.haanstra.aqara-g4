import crypto from 'node:crypto';
import net from 'node:net';

import { NalType, rtpPayload } from './h264';
import { StreamHub } from './StreamHub';
import { VIDEO_PAYLOAD_TYPE } from './CameraStream';

/**
 * A minimal RTSP server (RFC 2326) that serves the doorbell's H.264 once to Homey's own streaming
 * service (go2rtc), which then delivers it to every viewer. The app does the per-packet work for a
 * single consumer instead of once per viewer.
 *
 * Only what go2rtc/ffmpeg/VLC need: OPTIONS, DESCRIBE, SETUP (RTP over the RTSP TCP connection,
 * "interleaved"), PLAY, GET_PARAMETER (keep-alive) and TEARDOWN. The URL carries a random token so
 * other devices on the network can't watch the doorbell.
 */

const DESCRIBE_WAIT_MS = 4000;
/** Disconnect a client that can't keep up instead of buffering video in memory. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

interface ParameterSets {
    sps: Buffer;
    pps: Buffer;
}

interface Client {
    id: string;
    socket: net.Socket;
    session?: string;
    channel: number;
    playing: boolean;
    packetsSent: number;
}

/** Collect SPS and PPS NAL units from H.264 RTP packets (single NAL or STAP-A). */
export function findParameterSets(packet: Buffer, found: Partial<ParameterSets>): void {
    const payload = rtpPayload(packet);
    if (payload.length === 0) return;
    const visit = (nal: Buffer) => {
        const type = nal[0] & 0x1f;
        if (type === NalType.Sps) found.sps = Buffer.from(nal);
        if (type === NalType.Pps) found.pps = Buffer.from(nal);
    };
    const type = payload[0] & 0x1f;
    if (type === NalType.StapA) {
        let offset = 1;
        while (offset + 2 <= payload.length) {
            const size = payload.readUInt16BE(offset);
            offset += 2;
            if (offset + size > payload.length) break;
            visit(payload.subarray(offset, offset + size));
            offset += size;
        }
    } else if (type >= 1 && type <= 23) {
        visit(payload);
    }
}

export function buildSdp(host: string, parameterSets?: ParameterSets): string {
    const fmtp = ['packetization-mode=1'];
    if (parameterSets) {
        fmtp.push(`profile-level-id=${parameterSets.sps.subarray(1, 4).toString('hex')}`);
        fmtp.push(`sprop-parameter-sets=${parameterSets.sps.toString('base64')},${parameterSets.pps.toString('base64')}`);
    }
    return [
        'v=0',
        `o=- ${Date.now()} 1 IN IP4 ${host}`,
        's=Aqara G4',
        'c=IN IP4 0.0.0.0',
        't=0 0',
        'a=control:*',
        `m=video 0 RTP/AVP ${VIDEO_PAYLOAD_TYPE}`,
        `a=rtpmap:${VIDEO_PAYLOAD_TYPE} H264/90000`,
        `a=fmtp:${VIDEO_PAYLOAD_TYPE} ${fmtp.join(';')}`,
        'a=control:trackID=0',
        '',
    ].join('\r\n');
}

export interface RtspStats {
    clients: number;
    packetsSent: number;
}

export class RtspServer {
    private server?: net.Server;
    private readonly clients = new Map<string, Client>();
    private parameterSets?: ParameterSets;
    private packetsSent = 0;
    readonly token = crypto.randomBytes(12).toString('hex');
    port = 0;

    constructor(
        private readonly hub: StreamHub,
        private readonly log: (...args: unknown[]) => void = () => undefined,
    ) {}

    async start(): Promise<number> {
        if (this.server) return this.port;
        const server = net.createServer((socket) => this.onConnection(socket));
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, () => {
                server.off('error', reject);
                resolve();
            });
        });
        this.server = server;
        this.port = (server.address() as net.AddressInfo).port;
        this.log(`RTSP server listening on port ${this.port}`);
        return this.port;
    }

    url(host: string): string {
        return `rtsp://${host}:${this.port}/${this.token}`;
    }

    stats(): RtspStats {
        return { clients: [...this.clients.values()].filter((c) => c.playing).length, packetsSent: this.packetsSent };
    }

    async stop(): Promise<void> {
        for (const client of this.clients.values()) client.socket.destroy();
        this.clients.clear();
        await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
        this.server = undefined;
    }

    // ---- connections ----

    private onConnection(socket: net.Socket): void {
        const client: Client = { id: `rtsp-${crypto.randomBytes(4).toString('hex')}`, socket, channel: 0, playing: false, packetsSent: 0 };
        this.clients.set(client.id, client);
        socket.setNoDelay(true);
        this.log(`RTSP client ${client.id} connected from ${socket.remoteAddress}`);

        let buffer = Buffer.alloc(0);
        socket.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);
            for (;;) {
                // Interleaved data from the client (RTCP receiver reports): skip it.
                if (buffer.length >= 4 && buffer[0] === 0x24) {
                    const length = buffer.readUInt16BE(2);
                    if (buffer.length < 4 + length) return;
                    buffer = buffer.subarray(4 + length);
                    continue;
                }
                const end = buffer.indexOf('\r\n\r\n');
                if (end < 0) {
                    if (buffer.length > 64 * 1024) socket.destroy();
                    return;
                }
                const head = buffer.subarray(0, end).toString('latin1');
                const contentLength = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
                if (buffer.length < end + 4 + contentLength) return;
                buffer = buffer.subarray(end + 4 + contentLength);
                this.onRequest(client, head).catch((error) => {
                    this.log(`RTSP request failed: ${(error as Error).message}`);
                    socket.destroy();
                });
            }
        });
        const cleanup = () => this.disconnect(client);
        socket.on('close', cleanup);
        socket.on('error', cleanup);
    }

    private disconnect(client: Client): void {
        if (!this.clients.delete(client.id)) return;
        this.hub.removeViewer(client.id);
        this.log(`RTSP client ${client.id} disconnected after ${client.packetsSent} packets`);
    }

    private respond(client: Client, cseq: string, status: string, headers: Record<string, string> = {}, body = ''): void {
        const lines = [`RTSP/1.0 ${status}`, `CSeq: ${cseq}`, 'Server: Aqara G4 for Homey'];
        for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
        if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
        client.socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`);
    }

    private async onRequest(client: Client, head: string): Promise<void> {
        const [requestLine, ...headerLines] = head.split('\r\n');
        const [method, uri] = requestLine.split(' ');
        const headers: Record<string, string> = {};
        for (const line of headerLines) {
            const colon = line.indexOf(':');
            if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
        const cseq = headers.cseq ?? '0';

        if (method !== 'OPTIONS' && !(uri ?? '').includes(this.token)) {
            this.respond(client, cseq, '404 Not Found');
            return;
        }

        switch (method) {
            case 'OPTIONS':
                this.respond(client, cseq, '200 OK', { Public: 'OPTIONS, DESCRIBE, SETUP, PLAY, GET_PARAMETER, TEARDOWN' });
                return;

            case 'DESCRIBE': {
                const host = client.socket.localAddress?.replace(/^::ffff:/, '') ?? '0.0.0.0';
                const parameterSets = await this.waitForParameterSets();
                this.respond(
                    client,
                    cseq,
                    '200 OK',
                    { 'Content-Type': 'application/sdp', 'Content-Base': `${uri.replace(/\/$/, '')}/` },
                    buildSdp(host, parameterSets),
                );
                return;
            }

            case 'SETUP': {
                const transport = headers.transport ?? '';
                if (!/RTP\/AVP\/TCP/i.test(transport)) {
                    // Only RTP over the RTSP connection; clients (go2rtc, ffmpeg, VLC) then retry with TCP.
                    this.respond(client, cseq, '461 Unsupported Transport');
                    return;
                }
                const interleaved = /interleaved=(\d+)/i.exec(transport);
                client.channel = interleaved ? Number(interleaved[1]) : 0;
                client.session = crypto.randomBytes(6).toString('hex');
                this.respond(client, cseq, '200 OK', {
                    Transport: `RTP/AVP/TCP;unicast;interleaved=${client.channel}-${client.channel + 1}`,
                    Session: `${client.session};timeout=60`,
                });
                return;
            }

            case 'PLAY':
                this.respond(client, cseq, '200 OK', { Session: client.session ?? '', Range: 'npt=0.000-' });
                // The client may have hung up while this request was queued; don't start serving a ghost.
                if (!client.playing && this.clients.has(client.id) && !client.socket.destroyed) {
                    client.playing = true;
                    await this.hub.addViewer({ id: client.id, send: (packet) => this.sendPacket(client, packet) });
                    if (!this.clients.has(client.id)) {
                        this.hub.removeViewer(client.id);
                        return;
                    }
                    this.log(`RTSP client ${client.id} playing`);
                }
                return;

            case 'GET_PARAMETER':
            case 'SET_PARAMETER':
                this.respond(client, cseq, '200 OK', client.session ? { Session: client.session } : {});
                return;

            case 'TEARDOWN':
                this.respond(client, cseq, '200 OK', client.session ? { Session: client.session } : {});
                client.socket.end();
                return;

            default:
                this.respond(client, cseq, '405 Method Not Allowed', { Allow: 'OPTIONS, DESCRIBE, SETUP, PLAY, GET_PARAMETER, TEARDOWN' });
        }
    }

    private sendPacket(client: Client, packet: Buffer): void {
        if (client.socket.destroyed) return;
        if (client.socket.writableLength > MAX_BUFFERED_BYTES) {
            this.log(`RTSP client ${client.id} is too slow; disconnecting`);
            client.socket.destroy();
            return;
        }
        const header = Buffer.allocUnsafe(4);
        header[0] = 0x24;
        header[1] = client.channel;
        header.writeUInt16BE(packet.length, 2);
        client.socket.write(Buffer.concat([header, packet]));
        client.packetsSent++;
        this.packetsSent++;
    }

    /**
     * The SDP should carry the camera's SPS/PPS so the consumer knows the exact profile before any
     * video arrives. They are cached; the first time, briefly watch the stream for a keyframe.
     */
    private async waitForParameterSets(): Promise<ParameterSets | undefined> {
        if (this.parameterSets) return this.parameterSets;
        const found: Partial<ParameterSets> = {};
        const id = `describe-${crypto.randomBytes(4).toString('hex')}`;
        const done = new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, DESCRIBE_WAIT_MS);
            this.hub
                .addViewer({
                    id,
                    send: (packet) => {
                        findParameterSets(packet, found);
                        if (found.sps && found.pps) {
                            clearTimeout(timer);
                            resolve();
                        }
                    },
                })
                .catch((error) => {
                    this.log(`Starting the camera for DESCRIBE failed: ${(error as Error).message}`);
                    clearTimeout(timer);
                    resolve();
                });
        });
        await done;
        this.hub.removeViewer(id);
        if (found.sps && found.pps) {
            this.parameterSets = { sps: found.sps, pps: found.pps };
        } else {
            this.log('No SPS/PPS seen yet; describing the stream without them');
        }
        return this.parameterSets;
    }

    /** Forget cached parameter sets, e.g. after the video quality changed. */
    resetParameterSets(): void {
        this.parameterSets = undefined;
    }
}
