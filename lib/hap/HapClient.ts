import { EventEmitter } from 'node:events';

import { HapConnection } from './HapConnection';
import { HttpMessage } from './httpParser';
import { addPairing, listPairings, PairingData, PairingEntry, pairVerify, removePairing } from './pairing';
import { HapAccessory, normalizeAccessories } from './types';

export interface CharacteristicId {
    aid: number;
    iid: number;
}

export interface CharacteristicValue extends CharacteristicId {
    value: unknown;
}

export interface HapEndpoint {
    host: string;
    port: number;
}

type Logger = (...args: unknown[]) => void;

/**
 * A paired, verified HAP session that stays connected.
 *
 * - `start()` connects and keeps reconnecting with backoff until `stop()`.
 * - Event subscriptions are restored after every reconnect.
 *
 * Events: `connected`, `disconnected` (Error | undefined), `characteristic` (CharacteristicValue)
 */
export class HapClient extends EventEmitter {
    private connection?: HapConnection;
    private connecting?: Promise<HapConnection>;
    private readonly subscriptions = new Map<string, CharacteristicId>();
    private reconnectTimer?: NodeJS.Timeout;
    private reconnectDelay = 1000;
    private running = false;
    private accessoriesCache?: HapAccessory[];

    constructor(
        private endpoint: HapEndpoint,
        private readonly pairing: PairingData,
        private readonly log: Logger = () => undefined,
    ) {
        super();
    }

    get connected(): boolean {
        return !!this.connection?.isOpen && this.connection.isEncrypted;
    }

    get host(): string {
        return this.endpoint.host;
    }

    /** Point the client at a new address (e.g. after an mDNS update) and reconnect if it changed. */
    updateEndpoint(endpoint: HapEndpoint): void {
        if (endpoint.host === this.endpoint.host && endpoint.port === this.endpoint.port) return;
        this.log(`HAP endpoint changed to ${endpoint.host}:${endpoint.port}`);
        this.endpoint = endpoint;
        this.connection?.close();
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.ensureConnected().catch((error) => this.log('Initial HAP connect failed:', error.message));
    }

    stop(): void {
        this.running = false;
        clearTimeout(this.reconnectTimer);
        this.connection?.close();
        this.connection = undefined;
    }

    /** Returns a verified connection, connecting first when needed. */
    async ensureConnected(): Promise<HapConnection> {
        if (this.connected) return this.connection!;
        if (!this.connecting) {
            this.connecting = this.openConnection().finally(() => {
                this.connecting = undefined;
            });
        }
        return this.connecting;
    }

    private async openConnection(): Promise<HapConnection> {
        const connection = new HapConnection(this.endpoint.host, this.endpoint.port);
        try {
            await connection.connect();
            const keys = await pairVerify(connection, this.pairing);
            connection.enableEncryption(keys.writeKey, keys.readKey);
        } catch (error) {
            connection.close();
            this.scheduleReconnect();
            throw error;
        }

        connection.on('event', (message: HttpMessage) => this.onEvent(message));
        connection.on('close', (error?: Error) => {
            if (this.connection === connection) {
                this.connection = undefined;
                this.emit('disconnected', error);
                this.scheduleReconnect();
            }
        });

        this.connection = connection;
        this.reconnectDelay = 1000;
        this.log(`HAP session verified with ${this.endpoint.host}:${this.endpoint.port}`);

        if (this.subscriptions.size > 0) {
            await this.writeSubscriptions([...this.subscriptions.values()], true).catch((error) =>
                this.log('Restoring event subscriptions failed:', error.message),
            );
        }
        this.emit('connected');
        return connection;
    }

    private scheduleReconnect(): void {
        if (!this.running) return;
        clearTimeout(this.reconnectTimer);
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
        this.reconnectTimer = setTimeout(() => {
            this.ensureConnected().catch((error) => this.log(`HAP reconnect failed (next try in ${this.reconnectDelay / 1000}s):`, error.message));
        }, delay);
    }

    private onEvent(message: HttpMessage): void {
        try {
            const body = JSON.parse(message.body.toString('utf8'));
            for (const c of body.characteristics ?? []) {
                this.emit('characteristic', { aid: c.aid, iid: c.iid, value: c.value } satisfies CharacteristicValue);
            }
        } catch (error) {
            this.log('Could not parse HAP event:', (error as Error).message);
        }
    }

    async getAccessories(refresh = false): Promise<HapAccessory[]> {
        if (!this.accessoriesCache || refresh) {
            const connection = await this.ensureConnected();
            this.accessoriesCache = normalizeAccessories(await connection.json('GET', '/accessories'));
        }
        return this.accessoriesCache;
    }

    async getCharacteristics(ids: CharacteristicId[]): Promise<CharacteristicValue[]> {
        if (ids.length === 0) return [];
        const connection = await this.ensureConnected();
        const query = ids.map((id) => `${id.aid}.${id.iid}`).join(',');
        const body = await connection.json('GET', `/characteristics?id=${query}`);
        return (body?.characteristics ?? []).map((c: any) => ({ aid: c.aid, iid: c.iid, value: c.value }));
    }

    async getCharacteristic(id: CharacteristicId): Promise<unknown> {
        const [result] = await this.getCharacteristics([id]);
        return result?.value;
    }

    async putCharacteristics(values: CharacteristicValue[]): Promise<void> {
        const connection = await this.ensureConnected();
        const response = await connection.json('PUT', '/characteristics', { characteristics: values });
        const failed = (response?.characteristics ?? []).filter((c: any) => c.status && c.status !== 0);
        if (failed.length) {
            throw new Error(`Writing characteristics failed: ${JSON.stringify(failed)}`);
        }
    }

    /**
     * Write a TLV8 characteristic and read back its response, which is how the camera's
     * SetupEndpoints exchange works. HAP write-response (`r: true`) is only used when the
     * characteristic advertises the `wr` permission; cameras like the Aqara G4 reject it
     * (-70405) on SetupEndpoints and expect a plain write followed by a read.
     */
    async writeReadTlv(id: CharacteristicId, value: Buffer, writeResponse = false): Promise<Buffer> {
        const connection = await this.ensureConnected();
        const write: Record<string, unknown> = { aid: id.aid, iid: id.iid, value: value.toString('base64') };
        if (writeResponse) write.r = true;
        const response = await connection.json('PUT', '/characteristics', { characteristics: [write] });
        const echoed = response?.characteristics?.find((c: any) => c.aid === id.aid && c.iid === id.iid);
        if (echoed?.status && echoed.status !== 0) {
            throw new Error(`Writing ${id.aid}.${id.iid} failed with HAP status ${echoed.status}`);
        }
        if (typeof echoed?.value === 'string' && echoed.value.length > 0) {
            return Buffer.from(echoed.value, 'base64');
        }
        const read = await this.getCharacteristic(id);
        return Buffer.from(String(read ?? ''), 'base64');
    }

    async subscribe(ids: CharacteristicId[]): Promise<void> {
        for (const id of ids) this.subscriptions.set(`${id.aid}.${id.iid}`, id);
        if (this.connected) await this.writeSubscriptions(ids, true);
    }

    private async writeSubscriptions(ids: CharacteristicId[], enable: boolean): Promise<void> {
        const connection = await this.ensureConnected();
        await connection.json('PUT', '/characteristics', {
            characteristics: ids.map((id) => ({ aid: id.aid, iid: id.iid, ev: enable })),
        });
    }

    /** Fetch a JPEG snapshot from the camera. */
    async getSnapshot(width = 1920, height = 1080, aid = 1): Promise<Buffer> {
        const connection = await this.ensureConnected();
        const body = Buffer.from(JSON.stringify({ 'resource-type': 'image', 'image-width': width, 'image-height': height, aid }));
        const response = await connection.request('POST', '/resource', body, 'application/hap+json', 20000);
        if (response.status !== 200 || response.body.length === 0) {
            throw new Error(`Snapshot failed with status ${response.status}`);
        }
        return response.body;
    }

    /** Remove a pairing; our own by default, so the accessory can be paired again elsewhere. */
    async unpair(controllerId = this.pairing.controllerId): Promise<void> {
        const connection = await this.ensureConnected();
        await removePairing(connection, controllerId);
    }

    /** Give another controller access to the accessory (we must be an admin controller). */
    async addPairing(controllerId: string, controllerLtpk: Buffer, admin = false): Promise<void> {
        const connection = await this.ensureConnected();
        await addPairing(connection, controllerId, controllerLtpk, admin);
    }

    async listPairings(): Promise<PairingEntry[]> {
        const connection = await this.ensureConnected();
        return listPairings(connection);
    }

    /** The paired accessory's identity, for handing the session to another HomeKit client. */
    get accessory(): { id: string; ltpk: string; host: string; port: number } {
        return { id: this.pairing.accessoryId, ltpk: this.pairing.accessoryLtpk, host: this.endpoint.host, port: this.endpoint.port };
    }
}
