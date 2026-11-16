/* Pairs this computer with the doorbell as a HomeKit controller and saves the keys. */
import { HapConnection } from '../lib/hap/HapConnection';
import { PairMethod, pairSetup } from '../lib/hap/pairing';
import { parseSetupInput, setupHash } from '../lib/hap/setupPayload';
import { arg, discover, DiscoveredAccessory, fail, savePairing } from './common';

async function main() {
    const input = arg('code');
    if (!input) throw new Error('Pass --code with the 8-digit setup code (123-45-678) or the QR text (X-HM://...).');
    const setup = parseSetupInput(input);
    console.log(`Setup code ${setup.setupCode}${setup.setupId ? `, setup id ${setup.setupId}, category ${setup.category}` : ''}`);

    let target: Pick<DiscoveredAccessory, 'host' | 'port' | 'name'> & { ff?: number };
    const host = arg('host');
    if (host) {
        target = { host, port: Number(arg('port') || 0), name: host };
        if (!target.port) throw new Error('Pass --port together with --host.');
    } else {
        const found = (await discover(5)).filter((a) => a.unpaired);
        const match =
            (setup.setupId && found.find((a) => a.txt.sh === setupHash(setup.setupId!, a.id))) ||
            found.find((a) => a.category === 18) ||
            (found.length === 1 ? found[0] : undefined);
        if (!match) {
            console.log('Unpaired accessories found:', found.map((a) => `${a.name} (${a.host}:${a.port}, category ${a.category})`).join(', ') || 'none');
            throw new Error('Could not pick the doorbell. Remove it from other HomeKit controllers first, or pass --host and --port.');
        }
        target = { host: match.host, port: match.port, name: match.name, ff: Number(match.txt.ff ?? 0) };
    }

    let method: number = target.ff && target.ff & 1 ? PairMethod.PairSetupWithAuth : PairMethod.PairSetup;
    if (arg('method') !== undefined) method = Number(arg('method'));
    console.log(`Pairing with ${target.name} at ${target.host}:${target.port} (method ${method})...`);

    const connection = new HapConnection(target.host, target.port);
    await connection.connect();
    try {
        const pairing = await pairSetup(connection, setup.setupCode, method);
        savePairing({ host: target.host, port: target.port, pairing });
        console.log(`Paired. Accessory id ${pairing.accessoryId}. Keys saved in tools/.data/pairing.json.`);
    } finally {
        connection.close();
    }
}

main().catch(fail);
