import { once } from 'node:events';

import { DOORBELL_SETTINGS, resolveSettings } from '../lib/doorbellSettings';
import { HapClient } from '../lib/hap/HapClient';
import { HapConnection } from '../lib/hap/HapConnection';
import { pairSetup } from '../lib/hap/pairing';
import { normalizeAccessories } from '../lib/hap/types';
import { FakeAccessory } from './support/fakeAccessory';

/** The settings-related part of the Aqara G4's accessory database (iids as on the real doorbell). */
const G4 = {
    accessories: [
        {
            aid: 1,
            services: [
                { iid: 1, type: '3E', characteristics: [{ iid: 65537, type: '14', perms: ['pw'], format: 'bool' }] },
                {
                    iid: 25,
                    type: '121',
                    characteristics: [
                        { iid: 1638403, type: '73', perms: ['pr', 'ev'], format: 'uint8', value: null },
                        { iid: 1638404, type: '11A', perms: ['pr', 'pw', 'ev'], format: 'bool', value: 0 },
                        { iid: 1638406, type: '119', perms: ['pr', 'pw', 'ev'], format: 'uint8', value: 10 },
                    ],
                },
                {
                    iid: 30,
                    type: '21A',
                    characteristics: [
                        { iid: 1966083, type: '21B', perms: ['pr', 'pw', 'ev'], format: 'uint8', value: 1 },
                        { iid: 1966085, type: '21D', perms: ['pr', 'pw', 'ev'], format: 'uint8', value: 1 },
                        { iid: 1966086, type: '11B', perms: ['pr', 'pw', 'ev'], format: 'bool', value: 1 },
                    ],
                },
                {
                    iid: 31,
                    type: '112',
                    characteristics: [
                        { iid: 2031619, type: '11A', perms: ['pr', 'pw', 'ev'], format: 'bool', value: 0 },
                        { iid: 2031620, type: '119', perms: ['pr', 'pw', 'ev'], format: 'uint8', value: 53 },
                    ],
                },
                {
                    iid: 32,
                    type: '113',
                    characteristics: [
                        { iid: 2097155, type: '11A', perms: ['pr', 'pw', 'ev'], format: 'bool', value: 0 },
                        { iid: 2097156, type: '119', perms: ['pr', 'pw', 'ev'], format: 'uint8', value: 78 },
                    ],
                },
            ],
        },
    ],
};

describe('doorbell settings', () => {
    it('finds every setting on the G4 and maps the doorbell service mute/volume to the chime', () => {
        const settings = resolveSettings(normalizeAccessories(G4));
        expect(settings.map((s) => s.capability).sort()).toEqual(DOORBELL_SETTINGS.map((s) => s.capability).sort());
        const chime = settings.find((s) => s.capability === 'chime_volume')!;
        expect(chime.iid).toBe(1638406);
        expect(settings.find((s) => s.capability === 'microphone_enabled')!.iid).toBe(2031619);
        expect(settings.every((s) => s.notifies)).toBe(true);
    });

    it('converts between HomeKit and Homey values', () => {
        const get = (capability: string) => DOORBELL_SETTINGS.find((s) => s.capability === capability)!;
        expect(get('chime_enabled').toHomey(0)).toBe(true); // mute off -> chime on
        expect(get('chime_enabled').toHap(false)).toBe(true); // chime off -> mute on
        expect(get('camera_enabled').toHap(true)).toBe(1);
        expect(get('camera_enabled').toHomey(0)).toBe(false);
        expect(get('chime_volume').toHap(1.2)).toBe(100);
        expect(get('chime_volume').toHap(0.336)).toBe(34);
        expect(get('chime_volume').toHomey(22)).toBeCloseTo(0.22);
        expect(get('night_vision').toHomey(1)).toBe(true);
    });

    it('skips settings the doorbell does not have or cannot write', () => {
        const readOnly = JSON.parse(JSON.stringify(G4));
        readOnly.accessories[0].services[1].characteristics[2].perms = ['pr', 'ev'];
        readOnly.accessories[0].services.splice(2, 1); // no operating-mode service
        const capabilities = resolveSettings(normalizeAccessories(readOnly)).map((s) => s.capability);
        expect(capabilities).not.toContain('chime_volume');
        expect(capabilities).not.toContain('night_vision');
        expect(capabilities).toContain('chime_enabled');
    });

    it('writes a setting to the doorbell and hears about changes made elsewhere', async () => {
        const accessory = new FakeAccessory('031-45-154', G4);
        const port = await accessory.listen();
        const connection = new HapConnection('127.0.0.1', port);
        await connection.connect();
        const pairing = await pairSetup(connection, '031-45-154');
        connection.close();
        const client = new HapClient({ host: '127.0.0.1', port }, pairing);
        client.start();
        await client.ensureConnected();

        const settings = resolveSettings(await client.getAccessories());
        const volume = settings.find((s) => s.capability === 'chime_volume')!;
        await client.putCharacteristics([{ aid: volume.aid, iid: volume.iid, value: volume.toHap(0.42) }]);
        expect(accessory.values.get(`1.${volume.iid}`)).toBe(42);

        await client.subscribe([{ aid: volume.aid, iid: volume.iid }]);
        const event = once(client, 'characteristic');
        accessory.notify(1, volume.iid, 70); // changed in the Aqara app
        expect(volume.toHomey((await event)[0].value)).toBeCloseTo(0.7);

        client.stop();
        await accessory.close();
    });
});
