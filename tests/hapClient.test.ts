import { once } from 'node:events';

import { HapClient } from '../lib/hap/HapClient';
import { HapConnection } from '../lib/hap/HapConnection';
import { pairSetup, PairingError } from '../lib/hap/pairing';
import { findCharacteristic, findService, Service, Characteristic } from '../lib/hap/types';
import { FakeAccessory } from './support/fakeAccessory';

const ACCESSORIES = {
    accessories: [
        {
            aid: 1,
            services: [
                { iid: 1, type: '0000003E-0000-1000-8000-0026BB765291', characteristics: [{ iid: 2, type: '21', perms: ['pr'], value: 'G4' }] },
                {
                    iid: 10,
                    type: '00000121-0000-1000-8000-0026BB765291',
                    characteristics: [{ iid: 11, type: '00000073-0000-1000-8000-0026BB765291', perms: ['pr', 'ev'], value: null }],
                },
                { iid: 20, type: '85', characteristics: [{ iid: 21, type: '22', perms: ['pr', 'ev'], value: false }] },
            ],
        },
    ],
};

describe('HAP pairing and session against a fake accessory', () => {
    let accessory: FakeAccessory;
    let port: number;

    beforeEach(async () => {
        accessory = new FakeAccessory('031-45-154', ACCESSORIES);
        port = await accessory.listen();
    });

    afterEach(async () => {
        await accessory.close();
    });

    async function pair(code = '031-45-154') {
        const connection = new HapConnection('127.0.0.1', port);
        await connection.connect();
        try {
            return await pairSetup(connection, code);
        } finally {
            connection.close();
        }
    }

    it('rejects a wrong setup code', async () => {
        await expect(pair('111-22-333')).rejects.toBeInstanceOf(PairingError);
    });

    it('pairs, verifies, reads, subscribes, receives events and unpairs', async () => {
        const pairing = await pair();
        expect(pairing.accessoryId).toBe('AA:BB:CC:DD:EE:FF');
        expect(accessory.pairings.has(pairing.controllerId)).toBe(true);

        const client = new HapClient({ host: '127.0.0.1', port }, pairing);
        client.start();
        await once(client, 'connected');

        const accessories = await client.getAccessories();
        const doorbell = findService(accessories, Service.Doorbell);
        const press = findCharacteristic(doorbell, Characteristic.ProgrammableSwitchEvent)!;
        expect(press.iid).toBe(11);

        await client.subscribe([{ aid: 1, iid: 11 }]);
        expect(accessory.subscriptions.has('1.11')).toBe(true);

        const event = once(client, 'characteristic');
        accessory.notify(1, 11, 0);
        expect((await event)[0]).toEqual({ aid: 1, iid: 11, value: 0 });

        expect(await client.getSnapshot()).toEqual(accessory.snapshot);

        accessory.writeResponses.set('1.30', Buffer.from('response').toString('base64'));
        expect((await client.writeReadTlv({ aid: 1, iid: 30 }, Buffer.from('request'))).toString()).toBe('response');

        await client.addPairing('GO2RTC-ID', Buffer.alloc(32, 7));
        expect(accessory.permissions.get('GO2RTC-ID')).toBe(0);
        const pairings = await client.listPairings();
        expect(pairings).toEqual([
            { id: pairing.controllerId, admin: true },
            { id: 'GO2RTC-ID', admin: false },
        ]);
        await client.unpair('GO2RTC-ID');
        expect(accessory.pairings.has('GO2RTC-ID')).toBe(false);

        await client.unpair();
        expect(accessory.pairings.size).toBe(0);
        client.stop();
    });

    it('reconnects and restores subscriptions after the connection drops', async () => {
        const pairing = await pair();
        const client = new HapClient({ host: '127.0.0.1', port }, pairing);
        client.start();
        await once(client, 'connected');
        await client.subscribe([{ aid: 1, iid: 21 }]);

        accessory.subscriptions.clear();
        const reconnected = once(client, 'connected');
        accessory.dropConnections();
        await reconnected;
        expect(accessory.subscriptions.has('1.21')).toBe(true);

        const event = once(client, 'characteristic');
        accessory.notify(1, 21, true);
        expect((await event)[0].value).toBe(true);
        client.stop();
    });
});
