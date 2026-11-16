import { CameraStream } from './CameraStream';
import { startsKeyframe } from './h264';

export interface Viewer {
    readonly id: string;
    /** Called with every decrypted H.264 RTP packet once the viewer has seen a keyframe. */
    send(packet: Buffer): void;
    /** False while the viewer cannot receive yet (e.g. WebRTC still connecting). */
    isReady?(): boolean;
}

interface ViewerState {
    viewer: Viewer;
    waitingForKeyframe: boolean;
}

const IDLE_STOP_MS = 10000;
const KEYFRAME_RETRY_MS = 1000;
const KEYFRAME_RETRIES = 5;

/**
 * Shares one camera stream between any number of viewers.
 *
 * - The camera stream starts with the first viewer and stops a little after the last one leaves,
 *   which saves the doorbell's battery and Wi-Fi.
 * - New viewers only get packets from the next keyframe onward; the hub asks the camera for one.
 */
export class StreamHub {
    private readonly viewers = new Map<string, ViewerState>();
    private stream?: CameraStream;
    private starting?: Promise<CameraStream>;
    private idleTimer?: NodeJS.Timeout;
    private keyframeTimer?: NodeJS.Timeout;
    private restartAttempted = false;
    /** Packets received from the camera since the hub was created. */
    packetsReceived = 0;

    constructor(
        private readonly createStream: () => Promise<CameraStream>,
        private readonly log: (...args: unknown[]) => void = () => undefined,
    ) {}

    get viewerCount(): number {
        return this.viewers.size;
    }

    get active(): boolean {
        return !!this.stream;
    }

    async addViewer(viewer: Viewer): Promise<void> {
        clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
        this.viewers.set(viewer.id, { viewer, waitingForKeyframe: true });
        await this.ensureStream();
        this.requestKeyframe();
    }

    removeViewer(id: string): void {
        if (!this.viewers.delete(id)) return;
        if (this.viewers.size === 0 && !this.idleTimer) {
            this.idleTimer = setTimeout(() => {
                this.idleTimer = undefined;
                if (this.viewers.size === 0) this.stopStream().catch(() => undefined);
            }, IDLE_STOP_MS);
        }
    }

    /** Ask for a keyframe now, and again every second while a viewer is still waiting for one. */
    requestKeyframe(): void {
        if (this.keyframeTimer) return;
        let attempts = 0;
        const ask = () => {
            const waiting = [...this.viewers.values()].some((v) => v.waitingForKeyframe);
            if (!waiting || !this.stream || attempts >= KEYFRAME_RETRIES) {
                clearInterval(this.keyframeTimer);
                this.keyframeTimer = undefined;
                return;
            }
            attempts++;
            this.stream.requestKeyframe();
        };
        ask();
        this.keyframeTimer = setInterval(ask, KEYFRAME_RETRY_MS);
    }

    async stop(): Promise<void> {
        this.viewers.clear();
        clearTimeout(this.idleTimer);
        await this.stopStream();
    }

    private async ensureStream(): Promise<CameraStream> {
        if (this.stream) return this.stream;
        if (!this.starting) {
            this.starting = this.startStream().finally(() => {
                this.starting = undefined;
            });
        }
        return this.starting;
    }

    private async startStream(): Promise<CameraStream> {
        const stream = await this.createStream();
        stream.on('rtp', (packet: Buffer) => this.onPacket(packet));
        stream.once('ended', (error?: Error) => this.onEnded(stream, error));
        await stream.start();
        this.stream = stream;
        this.restartAttempted = false;
        return stream;
    }

    private async stopStream(): Promise<void> {
        clearInterval(this.keyframeTimer);
        this.keyframeTimer = undefined;
        const { stream } = this;
        this.stream = undefined;
        if (stream) {
            this.log('Stopping camera stream (no viewers)');
            await stream.stop();
        }
    }

    private onPacket(packet: Buffer): void {
        this.packetsReceived++;
        const keyframe = startsKeyframe(packet);
        for (const state of this.viewers.values()) {
            if (state.viewer.isReady && !state.viewer.isReady()) {
                state.waitingForKeyframe = true;
                continue;
            }
            if (state.waitingForKeyframe) {
                if (!keyframe) continue;
                state.waitingForKeyframe = false;
            }
            try {
                state.viewer.send(packet);
            } catch (error) {
                this.log(`Sending to viewer ${state.viewer.id} failed:`, (error as Error).message);
            }
        }
    }

    private onEnded(stream: CameraStream, error?: Error): void {
        if (this.stream !== stream) return;
        this.stream = undefined;
        if (error) this.log('Camera stream ended:', error.message);

        // Restart once when people are still watching.
        if (this.viewers.size > 0 && !this.restartAttempted) {
            this.restartAttempted = true;
            for (const state of this.viewers.values()) state.waitingForKeyframe = true;
            setTimeout(() => {
                this.ensureStream()
                    .then(() => this.requestKeyframe())
                    .catch((e) => this.log('Restarting the camera stream failed:', e.message));
            }, 2000);
        }
    }
}
