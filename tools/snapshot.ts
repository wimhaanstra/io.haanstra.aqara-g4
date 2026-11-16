/* Saves a JPEG snapshot from the doorbell. */
import fs from 'node:fs';
import path from 'node:path';

import { arg, connectSaved, DATA_DIR, fail } from './common';

async function main() {
    const output = path.resolve(arg('out') || path.join(DATA_DIR, 'snapshot.jpg'));
    const { client } = await connectSaved();
    const jpeg = await client.getSnapshot(Number(arg('width') || 1920), Number(arg('height') || 1080));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, jpeg);
    console.log(`Saved ${(jpeg.length / 1024).toFixed(0)} KiB to ${output}`);
    client.stop();
}

main().catch(fail);
