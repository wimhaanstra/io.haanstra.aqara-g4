/* Starts a live stream, decrypts it and writes raw H.264 (and optionally the RTP packets) to disk. */
import fs from 'node:fs';
import path from 'node:path';

import { CameraStream, findStreamManagement, readCameraCapabilities } from '../lib/stream/CameraStream';
import { H264Depacketizer, startsKeyframe } from '../lib/stream/h264';
import { arg, connectSaved, DATA_DIR, fail, localAddressFor } from './common';

async function main() {
    const seconds = Number(arg('seconds') || 10);
    const maxHeight = Number(arg('max-height') || 1080);
    const output = path.resolve(arg('out') || path.join(DATA_DIR, 'out.h264'));

    const { client } = await connectSaved();
    const accessories = await client.getAccessories();
    const [management] = findStreamManagement(accessories);
    if (!management) throw new Error('This accessory has no camera stream service.');

    const capabilities = await readCameraCapabilities(client, management);
    const localAddress = arg('local-address') || (await localAddressFor(client.host));

    fs.mkdirSync(path.dirname(output), { recursive: true });
    const file = fs.createWriteStream(output);
    const rtpLog = fs.createWriteStream(path.join(DATA_DIR, 'video.rtp'));
    const depacketizer = new H264Depacketizer();

    const stream = new CameraStream(client, management, capabilities, { localAddress, maxHeight, log: (...a) => console.log('[stream]', ...a) });
    let packets = 0;
    let keyframes = 0;
    let bytes = 0;
    stream.on('rtp', (packet: Buffer) => {
        packets++;
        if (startsKeyframe(packet)) keyframes++;
        // Length-prefixed raw packets, used as test fixtures.
        const length = Buffer.alloc(2);
        length.writeUInt16BE(packet.length);
        rtpLog.write(Buffer.concat([length, packet]));
        for (const nal of depacketizer.push(packet)) {
            bytes += nal.length;
            file.write(nal);
        }
    });

    const ended = new Promise<Error | undefined>((resolve) => stream.once('ended', resolve));
    const info = await stream.start();
    console.log(`Recording ${seconds}s from ${info.resolution.width}x${info.resolution.height} to ${output} ...`);

    const progress = setInterval(() => console.log(`  ${packets} packets, ${keyframes} keyframes, ${(bytes / 1024).toFixed(0)} KiB`), 2000);
    setTimeout(() => stream.requestKeyframe(), 3000);

    const error = await Promise.race([ended, new Promise<undefined>((resolve) => setTimeout(resolve, seconds * 1000))]);
    clearInterval(progress);
    await stream.stop();
    file.end();
    rtpLog.end();
    client.stop();

    if (error) throw error;
    if (packets === 0) throw new Error('No video packets arrived. Check that UDP traffic from the doorbell can reach this computer.');
    console.log(`Done: ${packets} packets, ${keyframes} keyframes. Play it with: ffplay -f h264 ${output}`);
}

main().catch(fail);
