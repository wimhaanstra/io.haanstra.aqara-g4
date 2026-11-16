import net from 'node:net';

import { startsKeyframe } from '../lib/stream/h264';
import { buildSdp, findParameterSets, RtspServer } from '../lib/stream/RtspServer';
import { StreamHub } from '../lib/stream/StreamHub';
import { startFakeCameraSetup } from './support/fakeCamera';

jest.setTimeout(30000);

/** A tiny RTSP client, enough to drive the server like go2rtc/ffmpeg do. */
class RtspClient {
    private socket!: net.Socket;
    private buffer = Buffer.alloc(0);
    private cseq = 0;
    private pending?: (response: { status: number; headers: Record<string, string>; body: string }) => void;
    readonly packets: Buffer[] = [];

    async connect(port: number) {
        this.socket = net.createConnection({ host: '127.0.0.1', port });
        await new Promise((resolve) => this.socket.once('connect', resolve));
        this.socket.on('data', (data) => this.onData(data));
    }

    private onData(data: Buffer) {
        this.buffer = Buffer.concat([this.buffer, data]);
        for (;;) {
            if (this.buffer.length >= 4 && this.buffer[0] === 0x24) {
                const length = this.buffer.readUInt16BE(2);
                if (this.buffer.length < 4 + length) return;
                this.packets.push(Buffer.from(this.buffer.subarray(4, 4 + length)));
                this.buffer = this.buffer.subarray(4 + length);
                continue;
            }
            const end = this.buffer.indexOf('\r\n\r\n');
            if (end < 0) return;
            const head = this.buffer.subarray(0, end).toString();
            const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
            if (this.buffer.length < end + 4 + length) return;
            const body = this.buffer.subarray(end + 4, end + 4 + length).toString();
            this.buffer = this.buffer.subarray(end + 4 + length);
            const [statusLine, ...lines] = head.split('\r\n');
            const headers = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
            this.pending?.({ status: Number(statusLine.split(' ')[1]), headers, body });
        }
    }

    request(method: string, uri: string, headers: Record<string, string> = {}) {
        const lines = [`${method} ${uri} RTSP/1.0`, `CSeq: ${++this.cseq}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
        return new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve) => {
            this.pending = resolve;
            this.socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        });
    }

    close() {
        this.socket.destroy();
    }
}

describe('RTSP helpers', () => {
    it('finds SPS/PPS in single NAL and STAP-A packets and puts them in the SDP', () => {
        const header = Buffer.from('80630001000000000000abcd', 'hex');
        const sps = Buffer.from([0x67, 0x4d, 0x00, 0x33, 0xaa]);
        const pps = Buffer.from([0x68, 0xee, 0x3c, 0x80]);
        const stap = Buffer.concat([Buffer.from([0x18, 0, sps.length]), sps, Buffer.from([0, pps.length]), pps]);
        const found: { sps?: Buffer; pps?: Buffer } = {};
        findParameterSets(Buffer.concat([header, stap]), found);
        expect(found.sps).toEqual(sps);
        expect(found.pps).toEqual(pps);

        const sdp = buildSdp('10.0.0.2', { sps, pps });
        expect(sdp).toContain('a=rtpmap:99 H264/90000');
        expect(sdp).toContain('profile-level-id=4d0033');
        expect(sdp).toContain(`sprop-parameter-sets=${sps.toString('base64')},${pps.toString('base64')}`);
    });
});

describe('RTSP server (fake camera -> HAP/SRTP -> RTSP client)', () => {
    let setup: Awaited<ReturnType<typeof startFakeCameraSetup>>;
    let hub: StreamHub;
    let server: RtspServer;

    beforeEach(async () => {
        setup = await startFakeCameraSetup();
        hub = new StreamHub(setup.createStream);
        server = new RtspServer(hub);
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
        await hub.stop();
        await setup.close();
    });

    it('does not start serving a client that hung up before PLAY was handled', async () => {
        const url = server.url('127.0.0.1');
        const client = new RtspClient();
        await client.connect(server.port);
        await client.request('DESCRIBE', url);
        const setupResponse = await client.request('SETUP', `${url}/trackID=0`, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
        const session = setupResponse.headers.session.split(';')[0];
        // Send PLAY and hang up immediately, like go2rtc sometimes does.
        (client as any).socket.write(`PLAY ${url} RTSP/1.0\r\nCSeq: 9\r\nSession: ${session}\r\n\r\n`);
        client.close();
        await new Promise((r) => setTimeout(r, 300));
        expect(server.stats().clients).toBe(0);
        expect(hub.viewerCount).toBe(0);
    });

    it('rejects URLs without the token', async () => {
        const client = new RtspClient();
        await client.connect(server.port);
        expect((await client.request('DESCRIBE', `rtsp://127.0.0.1:${server.port}/wrong`)).status).toBe(404);
        client.close();
    });

    it('describes, sets up interleaved TCP and plays from a keyframe; one camera stream for several clients', async () => {
        const url = server.url('127.0.0.1');
        const clients = [new RtspClient(), new RtspClient()];
        for (const client of clients) {
            await client.connect(server.port);
            expect((await client.request('OPTIONS', url)).headers.public).toContain('DESCRIBE');

            const describe = await client.request('DESCRIBE', url, { Accept: 'application/sdp' });
            expect(describe.status).toBe(200);
            expect(describe.body).toContain('sprop-parameter-sets=');

            expect((await client.request('SETUP', `${url}/trackID=0`, { Transport: 'RTP/AVP;unicast;client_port=5000-5001' })).status).toBe(461);
            const setupResponse = await client.request('SETUP', `${url}/trackID=0`, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
            expect(setupResponse.status).toBe(200);
            const session = setupResponse.headers.session.split(';')[0];

            expect((await client.request('PLAY', url, { Session: session })).status).toBe(200);
        }

        const deadline = Date.now() + 10000;
        while (clients.some((c) => c.packets.length < 20) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));

        for (const client of clients) {
            expect(client.packets.length).toBeGreaterThanOrEqual(20);
            expect(startsKeyframe(client.packets[0])).toBe(true);
        }
        expect(setup.camera.started).toBe(1);
        expect(server.stats().clients).toBe(2);

        for (const client of clients) client.close();
        await new Promise((r) => setTimeout(r, 200));
        expect(server.stats().clients).toBe(0);
        expect(hub.viewerCount).toBe(0);
    });
});
