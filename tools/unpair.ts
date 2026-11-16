/* Removes this computer's pairing from the doorbell, so the Homey app (or Apple Home) can pair. */
import fs from 'node:fs';
import path from 'node:path';

import { connectSaved, DATA_DIR, fail } from './common';

async function main() {
    const { client } = await connectSaved();
    await client.unpair();
    client.stop();
    fs.rmSync(path.join(DATA_DIR, 'pairing.json'), { force: true });
    console.log('Pairing removed from the doorbell and deleted locally.');
}

main().catch(fail);
