/* Prints the doorbell's services, characteristics and camera stream capabilities. */
import fs from 'node:fs';
import path from 'node:path';

import { AudioCodec, H264Level, H264Profile, SrtpSuite } from '../lib/hap/cameraTlv';
import { findStreamManagement, readCameraCapabilities } from '../lib/stream/CameraStream';
import { connectSaved, DATA_DIR, fail } from './common';

const name = (table: Record<string, number>, value: number) => Object.entries(table).find(([, v]) => v === value)?.[0] ?? String(value);

async function main() {
    const { client } = await connectSaved();
    const accessories = await client.getAccessories(true);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'accessories.json'), JSON.stringify(accessories, null, 2));

    for (const accessory of accessories) {
        console.log(`Accessory ${accessory.aid}`);
        for (const service of accessory.services) {
            console.log(`  service ${service.type} (iid ${service.iid})`);
            for (const c of service.characteristics) {
                const value = typeof c.value === 'string' && c.value.length > 60 ? `${c.value.slice(0, 60)}…` : JSON.stringify(c.value);
                console.log(`    ${c.type.padEnd(4)} iid ${String(c.iid).padEnd(4)} [${c.perms.join(',')}] ${c.format ?? ''} = ${value}`);
            }
        }
    }

    const streams = findStreamManagement(accessories);
    console.log(`\n${streams.length} camera stream service(s)`);
    for (const [index, management] of streams.entries()) {
        const caps = await readCameraCapabilities(client, management);
        console.log(`\nStream ${index}:`);
        for (const v of caps.video) {
            console.log(
                `  video codec ${v.codec}: profiles ${v.profiles.map((p) => name(H264Profile, p)).join('/')}, levels ${v.levels.map((l) => name(H264Level, l)).join('/')}`,
            );
            console.log(`    resolutions: ${v.resolutions.map((r) => `${r.width}x${r.height}@${r.fps}`).join(', ')}`);
        }
        for (const a of caps.audio.codecs) {
            console.log(`  audio ${name(AudioCodec, a.codec)}: ${a.channels}ch, bitrate mode ${a.bitrateMode}, sample rates ${a.sampleRates.join('/')}`);
        }
        console.log(`  SRTP suites: ${caps.srtpSuites.map((s) => name(SrtpSuite, s)).join(', ')}`);
    }

    console.log('\nFull accessory database saved to tools/.data/accessories.json');
    client.stop();
}

main().catch(fail);
