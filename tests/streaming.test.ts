import { startingNalTypes } from '../lib/stream/h264';
import { FakeCamera, startFakeCameraSetup } from './support/fakeCamera';

jest.setTimeout(30000);

describe('camera stream end to end (fake camera -> HAP/SRTP -> decrypted RTP)', () => {
    let setup: Awaited<ReturnType<typeof startFakeCameraSetup>>;
    let camera: FakeCamera;
    let createStream: () => ReturnType<Awaited<ReturnType<typeof startFakeCameraSetup>>['createStream']>;

    beforeEach(async () => {
        setup = await startFakeCameraSetup();
        ({ camera, createStream } = setup);
    });

    afterEach(async () => {
        await setup.close();
    });

    it('negotiates, decrypts video and keeps the camera alive with RTCP', async () => {
        const stream = await createStream();
        const packets: Buffer[] = [];
        stream.on('rtp', (p: Buffer) => packets.push(p));

        const info = await stream.start();
        expect(info.resolution).toEqual({ width: 1280, height: 720, fps: 30 });

        await new Promise((resolve) => setTimeout(resolve, 2500));
        stream.requestKeyframe();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await stream.stop();

        expect(camera.started).toBe(1);
        expect(camera.ended).toBe(1);
        expect(packets.length).toBeGreaterThan(30);
        expect(startingNalTypes(packets[0])).toEqual([7]);
        expect(camera.rtcpReceived).toBeGreaterThanOrEqual(2);
        expect(camera.pliReceived).toBe(1);
    });

});
