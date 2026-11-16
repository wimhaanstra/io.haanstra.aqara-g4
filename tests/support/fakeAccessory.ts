import net from 'node:net';

import { SRP, SrpServer } from 'fast-srp-hap';

import {
    chachaDecrypt,
    chachaEncrypt,
    ed25519Sign,
    ed25519Verify,
    generateEd25519,
    generateX25519,
    hapNonce,
    hkdfSha512,
    KeyPair,
    x25519SharedSecret,
} from '../../lib/hap/crypto';
import { PairTlv } from '../../lib/hap/pairing';
import { decodeTlv, encodeTlv, tlvGet } from '../../lib/hap/tlv8';

/**
 * A minimal HomeKit accessory for tests: pair-setup, pair-verify, encrypted HTTP,
 * characteristics with events, snapshots and pairing removal.
 */
export class FakeAccessory {
    readonly accessoryId = 'AA:BB:CC:DD:EE:FF';
    readonly longTerm: KeyPair = generateEd25519();
    readonly pairings = new Map<string, Buffer>();
    readonly permissions = new Map<string, number>();
    readonly values = new Map<string, unknown>();
    readonly writes: Array<{ aid: number; iid: number; value?: unknown; ev?: boolean }> = [];
    readonly subscriptions = new Set<string>();
    /** Value returned in the write-response for SetupEndpoints-like characteristics. */
    writeResponses = new Map<string, string>();
    /** Called for every characteristic write; may return a write-response value (base64). */
    onWrite?: (key: string, value: unknown) => string | undefined;
    snapshot = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

    private server?: net.Server;
    private readonly sockets = new Set<FakeSession>();

    constructor(
        readonly setupCode: string,
        readonly accessories: unknown,
    ) {}

    async listen(): Promise<number> {
        this.server = net.createServer((socket) => {
            const session = new FakeSession(this, socket);
            this.sockets.add(session);
            socket.on('close', () => this.sockets.delete(session));
        });
        await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
        return (this.server!.address() as net.AddressInfo).port;
    }

    async close(): Promise<void> {
        for (const s of this.sockets) s.socket.destroy();
        await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    }

    /** Push an event to every subscribed, verified session. */
    notify(aid: number, iid: number, value: unknown): void {
        this.values.set(`${aid}.${iid}`, value);
        for (const session of this.sockets) {
            if (session.verified && this.subscriptions.has(`${aid}.${iid}`)) {
                session.sendRaw('EVENT/1.0 200 OK', JSON.stringify({ characteristics: [{ aid, iid, value }] }), 'application/hap+json');
            }
        }
    }

    dropConnections(): void {
        for (const s of this.sockets) s.socket.destroy();
    }
}

class FakeSession {
    verified = false;
    private buffer: Buffer = Buffer.alloc(0);
    private srp?: SrpServer;
    private srpKey?: Buffer;
    private verifyKeys?: { ephemeral: KeyPair; controllerPublic: Buffer; shared: Buffer; sessionKey: Buffer };
    private readKey?: Buffer;
    private writeKey?: Buffer;
    private readCounter = 0n;
    private writeCounter = 0n;

    constructor(
        private readonly accessory: FakeAccessory,
        readonly socket: net.Socket,
    ) {
        socket.on('data', (data) => this.onData(data));
        socket.on('error', () => undefined);
    }

    private onData(data: Buffer): void {
        if (this.readKey) {
            let encrypted = Buffer.concat([this.buffer, data]);
            let plain = Buffer.alloc(0);
            while (encrypted.length >= 2) {
                const length = encrypted.readUInt16LE(0);
                if (encrypted.length < 2 + length + 16) break;
                plain = Buffer.concat([
                    plain,
                    chachaDecrypt(this.readKey, hapNonce(this.readCounter++), encrypted.subarray(2, 2 + length + 16), encrypted.subarray(0, 2)),
                ]);
                encrypted = encrypted.subarray(2 + length + 16);
            }
            this.buffer = encrypted;
            this.handleHttp(plain);
        } else {
            this.handleHttp(data);
        }
    }

    private pendingHttp: Buffer = Buffer.alloc(0);

    private handleHttp(data: Buffer): void {
        this.pendingHttp = Buffer.concat([this.pendingHttp, data]);
        for (;;) {
            const headerEnd = this.pendingHttp.indexOf('\r\n\r\n');
            if (headerEnd < 0) return;
            const head = this.pendingHttp.subarray(0, headerEnd).toString();
            const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
            if (this.pendingHttp.length < headerEnd + 4 + length) return;
            const body = this.pendingHttp.subarray(headerEnd + 4, headerEnd + 4 + length);
            this.pendingHttp = this.pendingHttp.subarray(headerEnd + 4 + length);
            const [method, path] = head.split('\r\n')[0].split(' ');
            this.route(method, path, Buffer.from(body));
        }
    }

    sendRaw(statusLine: string, body: Buffer | string, contentType: string): void {
        const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
        const message = Buffer.concat([Buffer.from(`${statusLine}\r\nContent-Type: ${contentType}\r\nContent-Length: ${payload.length}\r\n\r\n`), payload]);
        if (this.writeKey) {
            const frames: Buffer[] = [];
            for (let offset = 0; offset < message.length; offset += 1024) {
                const chunk = message.subarray(offset, offset + 1024);
                const aad = Buffer.alloc(2);
                aad.writeUInt16LE(chunk.length);
                frames.push(aad, chachaEncrypt(this.writeKey, hapNonce(this.writeCounter++), chunk, aad));
            }
            this.socket.write(Buffer.concat(frames));
        } else {
            this.socket.write(message);
        }
    }

    private tlv(items: Array<[number, Buffer | number | string]>): void {
        this.sendRaw('HTTP/1.1 200 OK', encodeTlv(items), 'application/pairing+tlv8');
    }

    private json(status: string, body: unknown): void {
        this.sendRaw(`HTTP/1.1 ${status}`, JSON.stringify(body), 'application/hap+json');
    }

    private route(method: string, path: string, body: Buffer): void {
        if (method === 'POST' && path === '/pair-setup') {
            this.pairSetup(decodeTlv(body)).catch(() => this.socket.destroy());
            return undefined;
        }
        if (method === 'POST' && path === '/pair-verify') return this.pairVerify(decodeTlv(body));
        if (!this.verified) return this.json('470 Connection Authorization Required', { status: -70401 });

        if (method === 'GET' && path === '/accessories') return this.json('200 OK', this.accessory.accessories);
        if (method === 'GET' && path.startsWith('/characteristics')) {
            const ids = new URL(`http://x${path}`).searchParams.get('id')!.split(',');
            return this.json('200 OK', {
                characteristics: ids.map((id) => {
                    const [aid, iid] = id.split('.').map(Number);
                    return { aid, iid, value: this.accessory.values.get(id) ?? null };
                }),
            });
        }
        if (method === 'PUT' && path === '/characteristics') {
            const request = JSON.parse(body.toString());
            const responses: unknown[] = [];
            for (const c of request.characteristics) {
                this.accessory.writes.push(c);
                const key = `${c.aid}.${c.iid}`;
                if (c.ev === true) this.accessory.subscriptions.add(key);
                if (c.ev === false) this.accessory.subscriptions.delete(key);
                let written: string | undefined;
                if (c.value !== undefined) {
                    this.accessory.values.set(key, c.value);
                    written = this.accessory.onWrite?.(key, c.value) ?? this.accessory.writeResponses.get(key);
                    // Like a real camera: the response is what a following read returns.
                    if (written !== undefined) this.accessory.values.set(key, written);
                }
                if (c.r) responses.push({ aid: c.aid, iid: c.iid, status: 0, value: written ?? this.accessory.writeResponses.get(key) ?? '' });
            }
            if (responses.length) return this.json('207 Multi-Status', { characteristics: responses });
            return this.sendRaw('HTTP/1.1 204 No Content', '', 'application/hap+json');
        }
        if (method === 'POST' && path === '/resource') return this.sendRaw('HTTP/1.1 200 OK', this.accessory.snapshot, 'image/jpeg');
        if (method === 'POST' && path === '/pairings') {
            const tlv = decodeTlv(body);
            const pairMethod = tlvGet(tlv, PairTlv.Method)![0];
            if (pairMethod === 3) {
                this.accessory.pairings.set(tlvGet(tlv, PairTlv.Identifier)!.toString(), tlvGet(tlv, PairTlv.PublicKey)!);
                this.accessory.permissions.set(tlvGet(tlv, PairTlv.Identifier)!.toString(), tlvGet(tlv, PairTlv.Permissions)![0]);
                return this.tlv([[PairTlv.State, 2]]);
            }
            if (pairMethod === 5) {
                const items: Array<[number, Buffer | number | string]> = [[PairTlv.State, 2]];
                [...this.accessory.pairings.entries()].forEach(([id, ltpk], index) => {
                    if (index > 0) items.push([PairTlv.Separator, Buffer.alloc(0)]);
                    items.push([PairTlv.Identifier, id], [PairTlv.PublicKey, ltpk], [PairTlv.Permissions, this.accessory.permissions.get(id) ?? 1]);
                });
                return this.tlv(items);
            }
            this.accessory.pairings.delete(tlvGet(tlv, PairTlv.Identifier)!.toString());
            return this.tlv([[PairTlv.State, 2]]);
        }
        return this.json('404 Not Found', {});
    }

    private async pairSetup(tlv: ReturnType<typeof decodeTlv>): Promise<void> {
        const state = tlvGet(tlv, PairTlv.State)![0];
        if (state === 1) {
            if (this.accessory.pairings.size > 0) return this.tlv([[PairTlv.State, 2], [PairTlv.Error, 6]]);
            const salt = Buffer.alloc(16, 3);
            this.srpKey = await SRP.genKey(32);
            this.srp = new SrpServer(SRP.params.hap, salt, Buffer.from('Pair-Setup'), Buffer.from(this.accessory.setupCode), this.srpKey);
            return this.tlv([
                [PairTlv.State, 2],
                [PairTlv.Salt, salt],
                [PairTlv.PublicKey, this.srp.computeB()],
            ]);
        }
        if (state === 3) {
            this.srp!.setA(tlvGet(tlv, PairTlv.PublicKey)!);
            try {
                this.srp!.checkM1(tlvGet(tlv, PairTlv.Proof)!);
            } catch {
                return this.tlv([[PairTlv.State, 4], [PairTlv.Error, 2]]);
            }
            return this.tlv([
                [PairTlv.State, 4],
                [PairTlv.Proof, this.srp!.computeM2()],
            ]);
        }
        if (state === 5) {
            const k = this.srp!.computeK();
            const encryptKey = hkdfSha512(k, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info');
            const sub = decodeTlv(chachaDecrypt(encryptKey, hapNonce('PS-Msg05'), tlvGet(tlv, PairTlv.EncryptedData)!));
            const controllerId = tlvGet(sub, PairTlv.Identifier)!;
            const controllerLtpk = tlvGet(sub, PairTlv.PublicKey)!;
            const controllerX = hkdfSha512(k, 'Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info');
            if (!ed25519Verify(controllerLtpk, Buffer.concat([controllerX, controllerId, controllerLtpk]), tlvGet(sub, PairTlv.Signature)!)) {
                return this.tlv([[PairTlv.State, 6], [PairTlv.Error, 2]]);
            }
            this.accessory.pairings.set(controllerId.toString(), controllerLtpk);

            const accessoryX = hkdfSha512(k, 'Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info');
            const id = Buffer.from(this.accessory.accessoryId);
            const info = Buffer.concat([accessoryX, id, this.accessory.longTerm.publicKey]);
            const response = encodeTlv([
                [PairTlv.Identifier, id],
                [PairTlv.PublicKey, this.accessory.longTerm.publicKey],
                [PairTlv.Signature, ed25519Sign(this.accessory.longTerm.privateKey, info)],
            ]);
            return this.tlv([
                [PairTlv.State, 6],
                [PairTlv.EncryptedData, chachaEncrypt(encryptKey, hapNonce('PS-Msg06'), response)],
            ]);
        }
        return undefined;
    }

    private pairVerify(tlv: ReturnType<typeof decodeTlv>): void {
        const state = tlvGet(tlv, PairTlv.State)![0];
        if (state === 1) {
            const controllerPublic = tlvGet(tlv, PairTlv.PublicKey)!;
            const ephemeral = generateX25519();
            const shared = x25519SharedSecret(ephemeral.privateKey, controllerPublic);
            const sessionKey = hkdfSha512(shared, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info');
            this.verifyKeys = { ephemeral, controllerPublic, shared, sessionKey };

            const id = Buffer.from(this.accessory.accessoryId);
            const info = Buffer.concat([ephemeral.publicKey, id, controllerPublic]);
            const sub = encodeTlv([
                [PairTlv.Identifier, id],
                [PairTlv.Signature, ed25519Sign(this.accessory.longTerm.privateKey, info)],
            ]);
            return this.tlv([
                [PairTlv.State, 2],
                [PairTlv.PublicKey, ephemeral.publicKey],
                [PairTlv.EncryptedData, chachaEncrypt(sessionKey, hapNonce('PV-Msg02'), sub)],
            ]);
        }
        if (state === 3 && this.verifyKeys) {
            const { ephemeral, controllerPublic, shared, sessionKey } = this.verifyKeys;
            const sub = decodeTlv(chachaDecrypt(sessionKey, hapNonce('PV-Msg03'), tlvGet(tlv, PairTlv.EncryptedData)!));
            const controllerId = tlvGet(sub, PairTlv.Identifier)!;
            const ltpk = this.accessory.pairings.get(controllerId.toString());
            const info = Buffer.concat([controllerPublic, controllerId, ephemeral.publicKey]);
            if (!ltpk || !ed25519Verify(ltpk, info, tlvGet(sub, PairTlv.Signature)!)) {
                return this.tlv([[PairTlv.State, 4], [PairTlv.Error, 2]]);
            }
            this.tlv([[PairTlv.State, 4]]);
            // Keys from the accessory's point of view are mirrored.
            this.readKey = hkdfSha512(shared, 'Control-Salt', 'Control-Write-Encryption-Key');
            this.writeKey = hkdfSha512(shared, 'Control-Salt', 'Control-Read-Encryption-Key');
            this.verified = true;
        }
        return undefined;
    }
}
