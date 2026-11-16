import { EventEmitter } from 'node:events';
import net from 'node:net';

import { chachaDecrypt, chachaEncrypt, hapNonce } from './crypto';
import { buildRequest, HttpMessage, HttpParser } from './httpParser';

export interface HttpResponse {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
}

interface PendingRequest {
    resolve: (response: HttpResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

interface QueuedRequest {
    payload: Buffer;
    pending: Omit<PendingRequest, 'timer'>;
    timeoutMs: number;
}

const MAX_FRAME = 1024;

/**
 * One TCP connection to a HAP accessory.
 *
 * Starts in plain HTTP (for pair-setup and pair-verify). After `enableEncryption` every frame is
 * ChaCha20-Poly1305 encrypted as the HAP spec describes. Requests are sent one at a time; HAP
 * `EVENT/1.0` messages can arrive between responses and are emitted as `event`.
 *
 * Events: `event` (HttpMessage), `close` (Error | undefined)
 */
export class HapConnection extends EventEmitter {
    private socket?: net.Socket;
    private readonly parser: HttpParser;
    private readonly queue: QueuedRequest[] = [];
    private inFlight?: PendingRequest;
    private closed = false;

    private writeKey?: Buffer;
    private readKey?: Buffer;
    private writeCounter = 0n;
    private readCounter = 0n;
    private encryptedBuffer: Buffer = Buffer.alloc(0);

    constructor(
        readonly host: string,
        readonly port: number,
    ) {
        super();
        this.parser = new HttpParser((message) => this.onMessage(message));
    }

    get isOpen(): boolean {
        return !!this.socket && !this.closed;
    }

    get isEncrypted(): boolean {
        return !!this.writeKey;
    }

    connect(timeoutMs = 10000): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: this.host, port: this.port });
            this.socket = socket;
            socket.setNoDelay(true);
            socket.setKeepAlive(true, 10000);

            const timer = setTimeout(() => {
                socket.destroy(new Error(`Timed out connecting to ${this.host}:${this.port}`));
            }, timeoutMs);

            socket.once('connect', () => {
                clearTimeout(timer);
                resolve();
            });
            socket.on('data', (data) => this.onData(data));
            socket.on('error', (error) => {
                clearTimeout(timer);
                reject(error);
                this.shutdown(error);
            });
            socket.on('close', () => this.shutdown());
        });
    }

    close(): void {
        this.socket?.destroy();
        this.shutdown();
    }

    enableEncryption(writeKey: Buffer, readKey: Buffer): void {
        this.writeKey = writeKey;
        this.readKey = readKey;
        this.writeCounter = 0n;
        this.readCounter = 0n;
    }

    request(method: string, path: string, body?: Buffer, contentType?: string, timeoutMs = 15000): Promise<HttpResponse> {
        if (!this.isOpen) {
            return Promise.reject(new Error('HAP connection is closed'));
        }
        const payload = buildRequest(method, path, `${this.host}:${this.port}`, body, contentType);
        return new Promise((resolve, reject) => {
            this.queue.push({ payload, pending: { resolve, reject }, timeoutMs });
            this.pump();
        });
    }

    async json(method: string, path: string, body?: unknown): Promise<any> {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const response = await this.request(method, path, payload, payload ? 'application/hap+json' : undefined);
        if (response.status >= 400) {
            throw new Error(`HAP ${method} ${path} failed with status ${response.status}: ${response.body.toString()}`);
        }
        return response.body.length ? JSON.parse(response.body.toString('utf8')) : undefined;
    }

    private pump(): void {
        if (this.inFlight || this.queue.length === 0 || !this.socket) return;

        const next = this.queue.shift()!;
        const timer = setTimeout(() => {
            if (this.inFlight?.timer === timer) {
                this.inFlight = undefined;
                next.pending.reject(new Error('HAP request timed out'));
                // A lost response leaves the stream out of sync, so drop the connection.
                this.close();
            }
        }, next.timeoutMs);

        this.inFlight = { ...next.pending, timer };
        this.socket.write(this.writeKey ? this.encrypt(next.payload) : next.payload);
    }

    private onMessage(message: HttpMessage): void {
        if (message.kind === 'event') {
            this.emit('event', message);
            return;
        }

        const pending = this.inFlight;
        this.inFlight = undefined;
        if (pending) {
            clearTimeout(pending.timer);
            pending.resolve({ status: message.status, headers: message.headers, body: message.body });
        }
        this.pump();
    }

    private onData(data: Buffer): void {
        try {
            if (!this.readKey) {
                this.parser.feed(data);
                return;
            }

            this.encryptedBuffer = Buffer.concat([this.encryptedBuffer, data]);
            while (this.encryptedBuffer.length >= 2) {
                const length = this.encryptedBuffer.readUInt16LE(0);
                const frameLength = 2 + length + 16;
                if (this.encryptedBuffer.length < frameLength) break;

                const aad = this.encryptedBuffer.subarray(0, 2);
                const frame = this.encryptedBuffer.subarray(2, frameLength);
                const plain = chachaDecrypt(this.readKey, hapNonce(this.readCounter++), frame, aad);
                this.encryptedBuffer = this.encryptedBuffer.subarray(frameLength);
                this.parser.feed(plain);
            }
        } catch (error) {
            this.socket?.destroy(error as Error);
        }
    }

    private encrypt(data: Buffer): Buffer {
        const frames: Buffer[] = [];
        for (let offset = 0; offset < data.length; offset += MAX_FRAME) {
            const chunk = data.subarray(offset, Math.min(offset + MAX_FRAME, data.length));
            const aad = Buffer.alloc(2);
            aad.writeUInt16LE(chunk.length);
            frames.push(aad, chachaEncrypt(this.writeKey!, hapNonce(this.writeCounter++), chunk, aad));
        }
        return Buffer.concat(frames);
    }

    private shutdown(error?: Error): void {
        if (this.closed) return;
        this.closed = true;

        const failure = error ?? new Error('HAP connection closed');
        if (this.inFlight) {
            clearTimeout(this.inFlight.timer);
            this.inFlight.reject(failure);
            this.inFlight = undefined;
        }
        for (const queued of this.queue.splice(0)) {
            queued.pending.reject(failure);
        }
        this.emit('close', error);
    }
}
