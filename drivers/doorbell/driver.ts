import Homey from 'homey';
import { PairSession } from 'homey/lib/Driver';
import DiscoveryResultMDNSSD from 'homey/lib/DiscoveryResultMDNSSD';

import { HapConnection } from '../../lib/hap/HapConnection';
import { PairingError, PairMethod, pairSetup } from '../../lib/hap/pairing';
import { parseSetupInput, setupHash } from '../../lib/hap/setupPayload';

interface Candidate {
    id: string;
    name: string;
    model: string;
    address: string;
    port: number;
    category: number;
    paired: boolean;
    setupHash?: string;
    featureFlags: number;
}

const CATEGORY_DOORBELL = 18;

class DoorbellDriver extends Homey.Driver {
    async onInit() {
        this.homey.flow.getActionCard('take_snapshot').registerRunListener(async (args) => {
            const image = await args.device.takeSnapshot();
            return { snapshot: image };
        });
        this.homey.flow.getActionCard('set_chime_volume').registerRunListener(async (args) => {
            // The card asks for 0-100%; the capability is a 0-1 fraction.
            await args.device.writeSetting('chime_volume', Number(args.volume) / 100);
        });
        this.homey.flow.getActionCard('set_chime_enabled').registerRunListener(async (args) => {
            await args.device.writeSetting('chime_enabled', args.state === 'on');
        });
        this.homey.flow.getActionCard('set_camera_enabled').registerRunListener(async (args) => {
            await args.device.writeSetting('camera_enabled', args.state === 'on');
        });
        this.homey.flow.getActionCard('identify').registerRunListener(async (args) => {
            await args.device.identify();
        });
    }

    /** HomeKit cameras and doorbells currently visible on the network. */
    private candidates(): Candidate[] {
        const results = Object.values(this.homey.discovery.getStrategy('hap').getDiscoveryResults()) as DiscoveryResultMDNSSD[];
        const known = new Set(this.getDevices().map((d) => d.getData().id));
        return results
            .filter((r) => r.address && r.port)
            .map((r) => ({
                id: (r.txt.id ?? r.id).toUpperCase(),
                name: (r.name ?? r.txt.md ?? 'HomeKit camera').replace(/\._hap\._tcp\.local\.?$/, ''),
                model: r.txt.md ?? '',
                address: r.address,
                port: r.port!,
                category: Number(r.txt.ci ?? 0),
                paired: (Number(r.txt.sf ?? 1) & 1) === 0,
                setupHash: r.txt.sh,
                featureFlags: Number(r.txt.ff ?? 0),
            }))
            .filter((c) => !known.has(c.id))
            .sort((a, b) => Number(b.category === CATEGORY_DOORBELL) - Number(a.category === CATEGORY_DOORBELL) || a.name.localeCompare(b.name));
    }

    async onPair(session: PairSession) {
        session.setHandler('list', async () => this.candidates());

        /** Decode a typed code or scanned QR text, and find the doorbell it belongs to. */
        session.setHandler('decode', async ({ text }: { text: string }) => {
            const setup = parseSetupInput(text);
            const match = setup.setupId ? this.candidates().find((c) => c.setupHash && c.setupHash === setupHash(setup.setupId!, c.id)) : undefined;
            return { setupCode: setup.setupCode, setupId: setup.setupId, category: setup.category, matchId: match?.id };
        });

        session.setHandler('pair', async ({ id, code }: { id: string; code: string }) => {
            const setup = parseSetupInput(code);
            const candidate = this.candidates().find((c) => c.id === id);
            if (!candidate) throw new Error(this.homey.__('pair.not_found'));
            if (candidate.paired) throw new Error(this.homey.__('pair.already_paired'));

            const method = candidate.featureFlags & 1 ? PairMethod.PairSetupWithAuth : PairMethod.PairSetup;
            this.log(`Pairing with ${candidate.name} (${candidate.id}) at ${candidate.address}:${candidate.port}, method ${method}`);

            const connection = new HapConnection(candidate.address, candidate.port);
            try {
                await connection.connect();
                const pairing = await pairSetup(connection, setup.setupCode, method);
                return {
                    name: candidate.model.includes('SVD') || candidate.category === CATEGORY_DOORBELL ? 'Aqara G4 Doorbell' : candidate.name,
                    data: { id: candidate.id },
                    store: { pairing, address: candidate.address, port: candidate.port },
                    settings: { address: `${candidate.address}:${candidate.port}`, model: candidate.model },
                };
            } catch (error) {
                this.error('Pairing failed:', error);
                if (error instanceof PairingError && error.code === 2) throw new Error(this.homey.__('pair.wrong_code'));
                throw error;
            } finally {
                connection.close();
            }
        });
    }
}

module.exports = DoorbellDriver;
