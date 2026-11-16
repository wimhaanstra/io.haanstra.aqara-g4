/* Shared helpers for the spike tools. These run on your computer, not on Homey. */
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';

import { HapClient } from '../lib/hap/HapClient';
import { PairingData } from '../lib/hap/pairing';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const multicastDns = require('multicast-dns');

export const DATA_DIR = path.join(__dirname, '.data');
const PAIRING_FILE = path.join(DATA_DIR, 'pairing.json');

export interface DiscoveredAccessory {
    name: string;
    host: string;
    port: number;
    txt: Record<string, string>;
    /** HAP device id (TXT `id`). */
    id: string;
    /** Accessory category (TXT `ci`). 17 = IP camera, 18 = video doorbell. */
    category: number;
    /** True when the accessory is not paired yet (TXT `sf` bit 0). */
    unpaired: boolean;
}

export interface SavedPairing {
    host: string;
    port: number;
    pairing: PairingData;
}

export function arg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return undefined;
    const value = process.argv[index + 1];
    return value && !value.startsWith('--') ? value : '';
}

export function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

export function savePairing(saved: SavedPairing): void {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PAIRING_FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
}

export function loadPairing(): SavedPairing {
    if (!fs.existsSync(PAIRING_FILE)) {
        throw new Error(`No pairing found at ${PAIRING_FILE}. Run "noodge spike:pair" first.`);
    }
    return JSON.parse(fs.readFileSync(PAIRING_FILE, 'utf8'));
}

/** Browse `_hap._tcp` on the local network for `seconds`. */
export async function discover(seconds = 4): Promise<DiscoveredAccessory[]> {
    const mdns = multicastDns();
    const found = new Map<string, DiscoveredAccessory>();
    const records = new Map<string, { srv?: { port: number; target: string }; txt?: Record<string, string> }>();
    const addresses = new Map<string, string>();

    const update = (instance: string) => {
        // Responders often answer with records for their other services too; keep only HomeKit ones.
        if (!instance.endsWith('._hap._tcp.local')) return;
        const r = records.get(instance);
        if (!r?.srv || !r.txt) return;
        const host = addresses.get(r.srv.target);
        if (!host) return;
        found.set(instance, {
            name: instance.replace(/\._hap\._tcp\.local$/, ''),
            host,
            port: r.srv.port,
            txt: r.txt,
            id: (r.txt.id ?? '').toUpperCase(),
            category: Number(r.txt.ci ?? 0),
            unpaired: (Number(r.txt.sf ?? 0) & 1) === 1,
        });
    };

    mdns.on('response', (response: any) => {
        for (const record of [...(response.answers ?? []), ...(response.additionals ?? [])]) {
            if (record.type === 'A') addresses.set(record.name, record.data);
            if (record.type === 'SRV') records.set(record.name, { ...records.get(record.name), srv: record.data });
            if (record.type === 'TXT') {
                const txt: Record<string, string> = {};
                for (const entry of record.data as Buffer[]) {
                    const text = entry.toString();
                    const eq = text.indexOf('=');
                    if (eq > 0) txt[text.slice(0, eq).toLowerCase()] = text.slice(eq + 1);
                }
                records.set(record.name, { ...records.get(record.name), txt });
            }
        }
        for (const instance of records.keys()) update(instance);
    });

    const query = () => mdns.query({ questions: [{ name: '_hap._tcp.local', type: 'PTR' }] });
    query();
    const timer = setInterval(query, 1000);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    clearInterval(timer);
    mdns.destroy();
    return [...found.values()];
}

/** The local IP address this machine uses to reach `host`. */
export async function localAddressFor(host: string): Promise<string> {
    const socket = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => socket.connect(9, host, (error?: Error) => (error ? reject(error) : resolve())));
    const { address } = socket.address();
    socket.close();
    return address;
}

export async function connectSaved(): Promise<{ client: HapClient; saved: SavedPairing }> {
    const saved = loadPairing();
    const host = arg('host') || saved.host;
    const client = new HapClient({ host, port: saved.port }, saved.pairing, (...args) => console.log('[hap]', ...args));
    client.start();
    await client.ensureConnected();
    return { client, saved };
}

export function fail(error: unknown): never {
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
