/* Lists HomeKit accessories on the network. */
import { discover, fail } from './common';

const CATEGORIES: Record<number, string> = { 2: 'bridge', 17: 'IP camera', 18: 'video doorbell' };

async function main() {
    console.log('Looking for HomeKit accessories (_hap._tcp)...');
    const accessories = await discover(5);
    if (accessories.length === 0) {
        console.log('Nothing found. Is this computer on the same network as the doorbell, and is mDNS (UDP 5353) allowed?');
        return;
    }
    for (const a of accessories.sort((x, y) => x.name.localeCompare(y.name))) {
        const state = a.unpaired ? 'UNPAIRED (ready to pair)' : 'paired';
        console.log(`- ${a.name}`);
        console.log(`    ${a.host}:${a.port}  id=${a.id}  category=${a.category} (${CATEGORIES[a.category] ?? 'other'})  ${state}`);
        console.log(`    model=${a.txt.md ?? '?'}  sh=${a.txt.sh ?? '-'}  ff=${a.txt.ff ?? '-'}`);
    }
}

main().catch(fail);
