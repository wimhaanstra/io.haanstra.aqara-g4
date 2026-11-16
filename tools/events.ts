/* Subscribes to the doorbell's events and logs presses, motion and battery changes. */
import { Characteristic, findCharacteristic, findService, Service } from '../lib/hap/types';
import { connectSaved, fail } from './common';

async function main() {
    const { client } = await connectSaved();
    const accessories = await client.getAccessories();

    const watch = [
        { label: 'doorbell press', service: Service.Doorbell, characteristic: Characteristic.ProgrammableSwitchEvent },
        { label: 'switch press', service: Service.StatelessProgrammableSwitch, characteristic: Characteristic.ProgrammableSwitchEvent },
        { label: 'motion', service: Service.MotionSensor, characteristic: Characteristic.MotionDetected },
        { label: 'battery', service: Service.Battery, characteristic: Characteristic.BatteryLevel },
        { label: 'streaming status', service: Service.CameraRTPStreamManagement, characteristic: Characteristic.StreamingStatus },
    ];

    const labels = new Map<string, string>();
    const ids = [];
    for (const w of watch) {
        const c = findCharacteristic(findService(accessories, w.service), w.characteristic);
        if (c && c.perms.includes('ev')) {
            labels.set(`${c.aid}.${c.iid}`, w.label);
            ids.push({ aid: c.aid, iid: c.iid });
        }
    }

    client.on('characteristic', (event) => {
        console.log(`${new Date().toISOString()}  ${labels.get(`${event.aid}.${event.iid}`) ?? `${event.aid}.${event.iid}`} = ${JSON.stringify(event.value)}`);
    });
    client.on('disconnected', () => console.log('Disconnected, reconnecting...'));

    await client.subscribe(ids);
    console.log(`Subscribed to: ${[...labels.values()].join(', ')}. Press the doorbell or walk past it. Ctrl+C to stop.`);
}

main().catch(fail);
