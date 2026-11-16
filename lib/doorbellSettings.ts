import { Characteristic, findCharacteristic, findService, HapAccessory, Service } from './hap/types';

/**
 * Doorbell settings that HomeKit exposes, mapped to Homey capabilities.
 * Each entry says where the value lives in HomeKit and how to convert it.
 */
export interface SettingDefinition {
    capability: string;
    service: string;
    characteristic: string;
    toHomey: (value: unknown) => boolean | number;
    toHap: (value: unknown) => boolean | number;
}

const inverted = {
    toHomey: (value: unknown) => !value,
    toHap: (value: unknown) => !value,
};

const flag = {
    toHomey: (value: unknown) => !!value,
    toHap: (value: unknown) => (value ? 1 : 0),
};

const bool = {
    toHomey: (value: unknown) => !!value,
    toHap: (value: unknown) => !!value,
};

/** HomeKit volumes are 0-100; Homey shows `%` capabilities as a 0-1 fraction (like dim). */
const percent = {
    toHomey: (value: unknown) => Math.min(1, Math.max(0, (Number(value) || 0) / 100)),
    toHap: (value: unknown) => Math.round(Math.min(1, Math.max(0, Number(value))) * 100),
};

export const DOORBELL_SETTINGS: SettingDefinition[] = [
    // The Doorbell service's own Mute/Volume control the chime.
    { capability: 'chime_enabled', service: Service.Doorbell, characteristic: Characteristic.Mute, ...inverted },
    { capability: 'chime_volume', service: Service.Doorbell, characteristic: Characteristic.Volume, ...percent },
    { capability: 'speaker_volume', service: Service.Speaker, characteristic: Characteristic.Volume, ...percent },
    { capability: 'microphone_enabled', service: Service.Microphone, characteristic: Characteristic.Mute, ...inverted },
    { capability: 'camera_enabled', service: Service.CameraOperatingMode, characteristic: Characteristic.HomeKitCameraActive, ...flag },
    { capability: 'night_vision', service: Service.CameraOperatingMode, characteristic: Characteristic.NightVision, ...bool },
    { capability: 'status_light', service: Service.CameraOperatingMode, characteristic: Characteristic.CameraOperatingModeIndicator, ...flag },
];

export interface ResolvedSetting extends SettingDefinition {
    aid: number;
    iid: number;
    /** Whether the doorbell reports changes made elsewhere (e.g. in Aqara Home). */
    notifies: boolean;
}

/** The settings this particular doorbell offers, with their HomeKit addresses. Only writable ones count. */
export function resolveSettings(accessories: HapAccessory[]): ResolvedSetting[] {
    return DOORBELL_SETTINGS.flatMap((definition) => {
        const c = findCharacteristic(findService(accessories, definition.service), definition.characteristic);
        if (!c || !c.perms.includes('pw')) return [];
        return [{ ...definition, aid: c.aid, iid: c.iid, notifies: c.perms.includes('ev') }];
    });
}
