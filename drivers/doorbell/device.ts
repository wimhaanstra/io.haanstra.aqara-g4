import Homey from 'homey';
import DiscoveryResultMDNSSD from 'homey/lib/DiscoveryResultMDNSSD';

import { DOORBELL_SETTINGS, ResolvedSetting, resolveSettings } from '../../lib/doorbellSettings';
import { CharacteristicId, CharacteristicValue, HapClient } from '../../lib/hap/HapClient';
import { PairingData } from '../../lib/hap/pairing';
import { Characteristic, findCharacteristic, findService, HapAccessory, Service } from '../../lib/hap/types';
import { CameraCapabilities, CameraStream, findStreamManagement, readCameraCapabilities, StreamManagement } from '../../lib/stream/CameraStream';
import { RtspServer } from '../../lib/stream/RtspServer';
import { StreamHub } from '../../lib/stream/StreamHub';

interface EventIds {
    ring: CharacteristicId[];
    motion?: CharacteristicId;
    battery?: CharacteristicId;
    lowBattery?: CharacteristicId;
}

const RING_DEBOUNCE_MS = 3000;

/** Resolution cap and bitrate per quality setting. Bitrate sets the packet rate, which is what costs CPU. */
const VIDEO_QUALITY: Record<string, { maxHeight: number; maxBitrate: number }> = {
    high: { maxHeight: 1080, maxBitrate: 1500 },
    normal: { maxHeight: 720, maxBitrate: 800 },
    low: { maxHeight: 360, maxBitrate: 400 },
};
const SNAPSHOT_TIMEOUT_MS = 8000;
const UNAVAILABLE_GRACE_MS = 60000;

const key = (id: { aid: number; iid: number }) => `${id.aid}.${id.iid}`;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

class DoorbellDevice extends Homey.Device {
    private client?: HapClient;
    private events: EventIds = { ring: [] };
    private servicesReady?: Promise<void>;
    private management?: StreamManagement;
    private capabilitiesCache?: CameraCapabilities;
    private hub?: StreamHub;
    private rtsp?: RtspServer;
    private doorbellSettings: ResolvedSetting[] = [];
    private readonly settingListeners = new Set<string>();
    private identifyId?: CharacteristicId;
    private liveImage?: Homey.Image;
    private ringImage?: Homey.Image;
    private ringSnapshot?: Promise<Buffer>;
    private lastRing = 0;
    private unavailableTimer?: NodeJS.Timeout;
    private perfTimer?: NodeJS.Timeout;
    private perfLast?: { cpu: NodeJS.CpuUsage; at: number; received: number; sent: number };

    async onInit() {
        const pairing = this.getStoreValue('pairing') as PairingData;
        const address = this.getStoreValue('address') as string;
        const port = this.getStoreValue('port') as number;

        this.client = new HapClient({ host: address, port }, pairing, (...args) => this.log('[hap]', ...args));
        this.client.on('connected', () => this.onConnected());
        this.client.on('disconnected', (error?: Error) => this.onDisconnected(error));
        this.client.on('characteristic', (event: CharacteristicValue) => this.onCharacteristic(event));

        // Devices added before these settings existed get the current defaults once.
        if ((this.getStoreValue('settingsVersion') ?? 0) < 4) {
            await this.setSettings({ video_quality: 'normal' }).catch(this.error);
            await this.setStoreValue('settingsVersion', 4);
        }

        this.hub = new StreamHub(() => this.createCameraStream(), (...args) => this.log('[stream]', ...args));
        this.rtsp = new RtspServer(this.hub, (...args) => this.log('[rtsp]', ...args));
        this.perfTimer = this.homey.setInterval(() => {
            try {
                this.logPerformance();
            } catch (error) {
                this.error('Performance logging failed:', (error as Error).message);
            }
        }, 10000);

        await this.setupImages();
        await this.setupVideo();

        this.client.start();
        this.removeGo2rtcPairing().catch((error) => this.error('Removing the old go2rtc pairing failed:', error.message));
    }

    /** An earlier experiment added a HomeKit pairing for Homey's go2rtc. Take it off the doorbell again. */
    private async removeGo2rtcPairing() {
        const identity = this.getStoreValue('go2rtcIdentity') as { clientId: string } | undefined;
        if (!identity) return;
        await this.client!.ensureConnected();
        await this.client!.unpair(identity.clientId);
        await this.unsetStoreValue('go2rtcIdentity');
        this.log('Removed the go2rtc test pairing from the doorbell');
    }

    // ---- connection ----

    private onConnected() {
        clearTimeout(this.unavailableTimer);
        this.unavailableTimer = undefined;
        this.setAvailable().catch(this.error);
        if (!this.servicesReady) {
            this.servicesReady = this.setupServices().catch((error) => {
                this.servicesReady = undefined;
                this.error('Reading the doorbell services failed:', error);
            });
        }
    }

    private onDisconnected(error?: Error) {
        this.log('Disconnected from the doorbell', error?.message ?? '');
        // Short drops (doorbell Wi-Fi power saving, reboots) should not flash the device as unavailable.
        if (!this.unavailableTimer) {
            this.unavailableTimer = setTimeout(() => {
                this.setUnavailable(this.homey.__('device.unreachable')).catch(this.error);
            }, UNAVAILABLE_GRACE_MS);
        }
    }

    private async setupServices() {
        const accessories: HapAccessory[] = await this.client!.getAccessories(true);

        const info = findService(accessories, Service.AccessoryInformation);
        const model = findCharacteristic(info, Characteristic.Model)?.value;
        const firmware = findCharacteristic(info, Characteristic.FirmwareRevision)?.value;
        await this.setSettings({ model: String(model ?? ''), firmware: String(firmware ?? '') }).catch(this.error);

        const id = (service: string, characteristic: string) => {
            const c = findCharacteristic(findService(accessories, service), characteristic);
            return c && c.perms.includes('ev') ? { aid: c.aid, iid: c.iid } : undefined;
        };

        this.events = {
            ring: [id(Service.Doorbell, Characteristic.ProgrammableSwitchEvent), id(Service.StatelessProgrammableSwitch, Characteristic.ProgrammableSwitchEvent)].filter(
                (x): x is CharacteristicId => !!x,
            ),
            motion: id(Service.MotionSensor, Characteristic.MotionDetected),
            battery: id(Service.Battery, Characteristic.BatteryLevel),
            lowBattery: id(Service.Battery, Characteristic.StatusLowBattery),
        };
        this.management = findStreamManagement(accessories)[0];
        this.doorbellSettings = resolveSettings(accessories);
        const identify = findCharacteristic(info, Characteristic.Identify);
        this.identifyId = identify ? { aid: identify.aid, iid: identify.iid } : undefined;

        await this.syncCapability('alarm_motion', !!this.events.motion);
        await this.syncCapability('measure_battery', !!this.events.battery);
        await this.syncCapability('alarm_battery', !!this.events.lowBattery);
        for (const definition of DOORBELL_SETTINGS) {
            const setting = this.doorbellSettings.find((s) => s.capability === definition.capability);
            await this.syncCapability(definition.capability, !!setting);
            if (setting && !this.settingListeners.has(setting.capability)) {
                this.settingListeners.add(setting.capability);
                this.registerCapabilityListener(setting.capability, async (value) => this.writeSetting(setting.capability, value));
            }
        }

        const settingIds = this.doorbellSettings.map((s) => ({ aid: s.aid, iid: s.iid }));
        const watched = [
            ...this.events.ring,
            this.events.motion,
            this.events.battery,
            this.events.lowBattery,
            ...this.doorbellSettings.filter((s) => s.notifies).map((s) => ({ aid: s.aid, iid: s.iid })),
        ].filter((x): x is CharacteristicId => !!x);
        await this.client!.subscribe(watched);

        // Initial values (the press characteristic has none worth reading).
        const toRead = [...watched.filter((w) => !this.events.ring.some((r) => key(r) === key(w))), ...settingIds];
        const unique = [...new Map(toRead.map((id) => [key(id), id])).values()];
        const initial = await this.client!.getCharacteristics(unique);
        for (const value of initial) this.applyState(value);

        this.log(
            `Ready: ${this.events.ring.length} ring source(s), motion ${!!this.events.motion}, battery ${!!this.events.battery}, camera ${!!this.management}, settings: ${
                this.doorbellSettings.map((s) => s.capability).join(', ') || 'none'
            }`,
        );
    }

    private async syncCapability(capability: string, present: boolean) {
        if (present && !this.hasCapability(capability)) await this.addCapability(capability);
        if (!present && this.hasCapability(capability)) await this.removeCapability(capability);
    }

    // ---- events ----

    private onCharacteristic(event: CharacteristicValue) {
        if (this.events.ring.some((r) => key(r) === key(event))) {
            // 0 = single press. null shows up when (re)subscribing and is not a press.
            if (event.value === 0 || event.value === 1) this.onRing();
            return;
        }
        this.applyState(event);
    }

    private applyState(event: CharacteristicValue) {
        const k = key(event);
        if (this.events.motion && k === key(this.events.motion)) {
            this.setCapabilityValue('alarm_motion', !!event.value).catch(this.error);
        } else if (this.events.battery && k === key(this.events.battery)) {
            this.setCapabilityValue('measure_battery', Number(event.value)).catch(this.error);
        } else if (this.events.lowBattery && k === key(this.events.lowBattery)) {
            this.setCapabilityValue('alarm_battery', event.value === 1).catch(this.error);
        }
        for (const setting of this.doorbellSettings) {
            if (k === key(setting) && event.value !== null && event.value !== undefined) {
                this.setCapabilityValue(setting.capability, setting.toHomey(event.value)).catch(this.error);
            }
        }
    }

    // ---- doorbell settings ----

    /** Change a doorbell setting (from the capability UI or a Flow card). */
    async writeSetting(capability: string, value: unknown): Promise<void> {
        await this.servicesReady;
        const setting = this.doorbellSettings.find((s) => s.capability === capability);
        if (!setting) throw new Error(this.homey.__('device.setting_unavailable'));
        const hapValue = setting.toHap(value);
        await this.client!.putCharacteristics([{ aid: setting.aid, iid: setting.iid, value: hapValue }]);
        this.log(`Set ${capability} to ${JSON.stringify(value)} (HomeKit value ${JSON.stringify(hapValue)})`);
        if (this.getCapabilityValue(capability) !== value) await this.setCapabilityValue(capability, value).catch(this.error);
    }

    /** HomeKit identify: the doorbell beeps or flashes once. */
    async identify(): Promise<void> {
        await this.servicesReady;
        if (!this.identifyId) throw new Error(this.homey.__('device.setting_unavailable'));
        await this.client!.putCharacteristics([{ ...this.identifyId, value: true }]);
        this.log('Identify sent');
    }

    private onRing() {
        const now = Date.now();
        if (now - this.lastRing < RING_DEBOUNCE_MS) return;
        this.lastRing = now;
        this.log('Doorbell pressed');

        // Grab the snapshot in the background; the Flow token reads it when someone uses it.
        this.ringSnapshot = this.fetchSnapshot();
        this.ringSnapshot.then(() => this.ringImage?.update()).catch((error) => this.error('Ring snapshot failed:', error.message));

        this.homey.flow
            .getDeviceTriggerCard('doorbell_pressed')
            .trigger(this, { snapshot: this.ringImage })
            .catch(this.error);
    }

    // ---- images ----

    private fetchSnapshot(): Promise<Buffer> {
        return withTimeout(this.client!.getSnapshot(1920, 1080), SNAPSHOT_TIMEOUT_MS, 'The doorbell did not send a snapshot in time');
    }

    private async setupImages() {
        this.liveImage = await this.homey.images.createImage();
        this.liveImage.setStream(async (stream: NodeJS.WritableStream) => {
            const jpeg = await this.fetchSnapshot();
            stream.end(jpeg);
        });
        await this.setCameraImage('snapshot', this.homey.__('device.snapshot'), this.liveImage);

        this.ringImage = await this.homey.images.createImage();
        this.ringImage.setStream(async (stream: NodeJS.WritableStream) => {
            const jpeg = await (this.ringSnapshot ?? this.fetchSnapshot());
            stream.end(jpeg);
        });
    }

    /** Used by the "Take a snapshot" Flow card: a fixed image of this moment. */
    async takeSnapshot(): Promise<Homey.Image> {
        const jpeg = await this.fetchSnapshot();
        const image = await this.homey.images.createImage();
        image.setStream(async (stream: NodeJS.WritableStream) => {
            stream.end(jpeg);
        });
        await this.liveImage?.update().catch(() => undefined);
        return image;
    }

    // ---- live video ----

    /**
     * Register the live video with Homey. The app serves the stream once over RTSP; Homey's own
     * streaming service (go2rtc, outside the app) takes it from there and serves every viewer, so
     * the app's CPU use stays flat however many people watch. (Serving each viewer from the app
     * over WebRTC hit Homey's CPU limit with a few viewers.)
     */
    private async setupVideo() {
        await this.rtsp!.start();
        const video = await this.homey.videos.createVideoRTSP({});
        video.registerVideoUrlListener(async () => {
            const host = (await this.homey.cloud.getLocalAddress()).split(':')[0];
            const url = this.rtsp!.url(host);
            this.log(`Live view requested; Homey gets ${url.replace(this.rtsp!.token, '<token>')}`);
            return { url };
        });
        await this.setCameraVideo('live', this.homey.__('device.live'), video);
    }

    async onSettings({ changedKeys }: { oldSettings: any; newSettings: any; changedKeys: string[] }) {
        if (changedKeys.includes('video_quality')) this.rtsp?.resetParameterSets();
    }

    /** While video is streaming, log what it costs: CPU of this app process, viewers and packet rates. */
    private logPerformance() {
        const now = Date.now();
        const cpu = process.cpuUsage();
        const rtsp = this.rtsp!.stats();
        const stats = { viewers: rtsp.clients, packetsSent: rtsp.packetsSent };
        const received = this.hub!.packetsReceived;
        const last = this.perfLast;
        this.perfLast = { cpu, at: now, received, sent: stats.packetsSent };
        if (!last || (!this.hub!.active && stats.viewers === 0)) return;

        const seconds = (now - last.at) / 1000;
        const cpuPercent = ((cpu.user - last.cpu.user + cpu.system - last.cpu.system) / 1e6 / seconds) * 100;
        const inRate = (received - last.received) / seconds;
        const outRate = Math.max(0, stats.packetsSent - last.sent) / seconds;
        // Homey's app sandbox has no /proc, so memory figures are not always available.
        let memory = '';
        try {
            memory = `, heap ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`;
        } catch {
            memory = '';
        }
        this.log(
            `[perf] cpu ${cpuPercent.toFixed(1)}% of one core, ${stats.viewers} viewer(s), in ${inRate.toFixed(0)} pkt/s, out ${outRate.toFixed(0)} pkt/s${memory}`,
        );
    }

    private async createCameraStream(): Promise<CameraStream> {
        await this.client!.ensureConnected();
        await this.servicesReady;
        if (!this.management) throw new Error(this.homey.__('device.no_camera'));

        this.capabilitiesCache ??= await readCameraCapabilities(this.client!, this.management);
        const localAddress = (await this.homey.cloud.getLocalAddress()).split(':')[0];
        const quality = VIDEO_QUALITY[this.getSetting('video_quality')] ?? VIDEO_QUALITY.normal;

        return new CameraStream(this.client!, this.management, this.capabilitiesCache, {
            localAddress,
            maxHeight: quality.maxHeight,
            maxBitrate: quality.maxBitrate,
            log: (...args) => this.log('[camera]', ...args),
        });
    }

    // ---- discovery ----

    onDiscoveryResult(result: DiscoveryResultMDNSSD): boolean {
        return (result.txt?.id ?? result.id).toUpperCase() === String(this.getData().id).toUpperCase();
    }

    async onDiscoveryAvailable(result: DiscoveryResultMDNSSD) {
        await this.updateEndpoint(result);
    }

    async onDiscoveryAddressChanged(result: DiscoveryResultMDNSSD) {
        await this.updateEndpoint(result);
    }

    async onDiscoveryLastSeenChanged() {
        if (!this.client?.connected) this.client?.ensureConnected().catch(() => undefined);
    }

    private async updateEndpoint(result: DiscoveryResultMDNSSD) {
        if (!result.address || !result.port) return;
        this.client?.updateEndpoint({ host: result.address, port: result.port });
        if (result.address !== this.getStoreValue('address') || result.port !== this.getStoreValue('port')) {
            await this.setStoreValue('address', result.address);
            await this.setStoreValue('port', result.port);
            await this.setSettings({ address: `${result.address}:${result.port}` }).catch(this.error);
        }
    }

    // ---- lifecycle ----

    async onDeleted() {
        // Free the doorbell so it can be paired again (with Homey or Apple Home).
        await withTimeout(this.client!.unpair(), 5000, 'unpair timed out').catch((error) =>
            this.error('Could not remove the HomeKit pairing; reset it in the Aqara Home app:', error.message),
        );
        await this.shutdown();
    }

    async onUninit() {
        await this.shutdown();
    }

    private async shutdown() {
        clearTimeout(this.unavailableTimer);
        if (this.perfTimer) this.homey.clearInterval(this.perfTimer);
        await this.rtsp?.stop();
        await this.hub?.stop();
        this.client?.stop();
    }
}

module.exports = DoorbellDevice;
