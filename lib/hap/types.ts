/** HomeKit service and characteristic types used by the doorbell (short form, uppercase hex). */

export const Service = {
    AccessoryInformation: '3E',
    Doorbell: '121',
    StatelessProgrammableSwitch: '89',
    MotionSensor: '85',
    CameraRTPStreamManagement: '110',
    Microphone: '112',
    Speaker: '113',
    Battery: '96',
    CameraOperatingMode: '21A',
} as const;

export const Characteristic = {
    Name: '23',
    Manufacturer: '20',
    Model: '21',
    SerialNumber: '30',
    FirmwareRevision: '52',
    ProgrammableSwitchEvent: '73',
    MotionDetected: '22',
    BatteryLevel: '68',
    StatusLowBattery: '79',
    ChargingState: '8F',
    StreamingStatus: '120',
    SupportedVideoStreamConfiguration: '114',
    SupportedAudioStreamConfiguration: '115',
    SupportedRTPConfiguration: '116',
    SelectedRTPStreamConfiguration: '117',
    SetupEndpoints: '118',
    Active: 'B0',
    Mute: '11A',
    Volume: '119',
    Identify: '14',
    HomeKitCameraActive: '21B',
    NightVision: '11B',
    CameraOperatingModeIndicator: '21D',
} as const;

const APPLE_SUFFIX = '-0000-1000-8000-0026BB765291';

/** Convert a full Apple UUID (`00000121-0000-1000-8000-0026BB765291`) or short type to the short form. */
export function shortType(type: string): string {
    const upper = type.toUpperCase();
    if (upper.endsWith(APPLE_SUFFIX)) {
        return upper.slice(0, 8).replace(/^0+/, '') || '0';
    }
    return upper.replace(/^0+/, '') || '0';
}

export interface HapCharacteristic {
    aid: number;
    iid: number;
    type: string; // short form
    perms: string[];
    format?: string;
    value?: unknown;
    description?: string;
    minValue?: number;
    maxValue?: number;
}

export interface HapService {
    aid: number;
    iid: number;
    type: string; // short form
    characteristics: HapCharacteristic[];
}

export interface HapAccessory {
    aid: number;
    services: HapService[];
}

export function normalizeAccessories(raw: any): HapAccessory[] {
    return (raw?.accessories ?? []).map((accessory: any) => ({
        aid: accessory.aid,
        services: (accessory.services ?? []).map((service: any) => ({
            aid: accessory.aid,
            iid: service.iid,
            type: shortType(service.type),
            characteristics: (service.characteristics ?? []).map((c: any) => ({
                aid: accessory.aid,
                iid: c.iid,
                type: shortType(c.type),
                perms: c.perms ?? [],
                format: c.format,
                value: c.value,
                description: c.description,
                minValue: c.minValue,
                maxValue: c.maxValue,
            })),
        })),
    }));
}

export function findService(accessories: HapAccessory[], type: string): HapService | undefined {
    for (const accessory of accessories) {
        const service = accessory.services.find((s) => s.type === type);
        if (service) return service;
    }
    return undefined;
}

export function findServices(accessories: HapAccessory[], type: string): HapService[] {
    return accessories.flatMap((a) => a.services.filter((s) => s.type === type));
}

export function findCharacteristic(service: HapService | undefined, type: string): HapCharacteristic | undefined {
    return service?.characteristics.find((c) => c.type === type);
}
