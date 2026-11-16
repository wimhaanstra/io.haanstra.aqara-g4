import crypto from 'node:crypto';

import { SRP, SrpClient } from 'fast-srp-hap';

import {
    chachaDecrypt,
    chachaEncrypt,
    ed25519Sign,
    ed25519Verify,
    generateEd25519,
    generateX25519,
    hapNonce,
    hkdfSha512,
    x25519SharedSecret,
} from './crypto';
import { HapConnection } from './HapConnection';
import { decodeTlv, encodeTlv, tlvGet, TlvItem } from './tlv8';

/** Pairing TLV types (HAP spec, table 5-6). */
export const PairTlv = {
    Method: 0x00,
    Identifier: 0x01,
    Salt: 0x02,
    PublicKey: 0x03,
    Proof: 0x04,
    EncryptedData: 0x05,
    State: 0x06,
    Error: 0x07,
    RetryDelay: 0x08,
    Certificate: 0x09,
    Signature: 0x0a,
    Permissions: 0x0b,
    Flags: 0x13,
    Separator: 0xff,
} as const;

export const PairMethod = {
    PairSetup: 0,
    PairSetupWithAuth: 1,
    PairVerify: 2,
    AddPairing: 3,
    RemovePairing: 4,
    ListPairings: 5,
} as const;

const PAIR_ERRORS: Record<number, string> = {
    1: 'Unknown error from the accessory',
    2: 'Wrong setup code',
    3: 'The accessory has too many pairings',
    4: 'The accessory refused the pairing (retry later)',
    5: 'Maximum pairing attempts reached; reset the HomeKit pairing on the doorbell',
    6: 'The accessory is already paired with another controller (remove it there first, or reset its HomeKit pairing)',
    7: 'The accessory is busy pairing with another controller',
};

export class PairingError extends Error {
    constructor(
        readonly code: number,
        stage: string,
    ) {
        super(`${PAIR_ERRORS[code] ?? `Pairing error ${code}`} (${stage})`);
    }
}

/** Long-term pairing data, stored on the Homey device. */
export interface PairingData {
    /** Our controller pairing identifier (a UUID string). */
    controllerId: string;
    /** Our Ed25519 long-term keys, hex encoded. */
    controllerLtsk: string;
    controllerLtpk: string;
    /** The accessory's pairing identifier (its `id` TXT record, e.g. AA:BB:CC:DD:EE:FF). */
    accessoryId: string;
    /** The accessory's Ed25519 long-term public key, hex encoded. */
    accessoryLtpk: string;
}

export interface SessionKeys {
    writeKey: Buffer; // controller -> accessory
    readKey: Buffer; // accessory -> controller
    sharedSecret: Buffer;
}

const PAIRING_CONTENT_TYPE = 'application/pairing+tlv8';

async function postTlv(connection: HapConnection, path: string, items: Array<[number, Buffer | number | string]>, stage: string): Promise<TlvItem[]> {
    const response = await connection.request('POST', path, encodeTlv(items), PAIRING_CONTENT_TYPE);
    if (response.status >= 400 && response.body.length === 0) {
        throw new Error(`${stage}: HTTP ${response.status}`);
    }
    const tlv = decodeTlv(response.body);
    const error = tlvGet(tlv, PairTlv.Error);
    if (error && error.length) {
        throw new PairingError(error[0], stage);
    }
    return tlv;
}

function required(tlv: TlvItem[], type: number, stage: string): Buffer {
    const value = tlvGet(tlv, type);
    if (!value) throw new Error(`${stage}: accessory response is missing TLV type ${type}`);
    return value;
}

/**
 * Pair-setup (HAP 5.6): exchange long-term keys with an unpaired accessory using its setup code.
 * `method` is 1 (with auth) when the accessory has an Apple auth coprocessor (TXT `ff` bit 0), else 0.
 */
export async function pairSetup(connection: HapConnection, setupCode: string, method: number = PairMethod.PairSetup): Promise<PairingData> {
    // M1 -> M2: start, get salt and SRP public key B
    const m2 = await postTlv(
        connection,
        '/pair-setup',
        [
            [PairTlv.State, 1],
            [PairTlv.Method, method],
        ],
        'M2',
    );
    const salt = required(m2, PairTlv.Salt, 'M2');
    const serverPublicKey = required(m2, PairTlv.PublicKey, 'M2');

    // M3 -> M4: SRP proof
    const srpKey = await SRP.genKey(32);
    const srp = new SrpClient(SRP.params.hap, salt, Buffer.from('Pair-Setup'), Buffer.from(setupCode), srpKey, true);
    srp.setB(serverPublicKey);

    const m4 = await postTlv(
        connection,
        '/pair-setup',
        [
            [PairTlv.State, 3],
            [PairTlv.PublicKey, srp.computeA()],
            [PairTlv.Proof, srp.computeM1()],
        ],
        'M4',
    );
    srp.checkM2(required(m4, PairTlv.Proof, 'M4'));
    const srpSharedKey = srp.computeK();

    // M5 -> M6: exchange long-term public keys
    const controllerId = crypto.randomUUID().toUpperCase();
    const longTerm = generateEd25519();
    const encryptKey = hkdfSha512(srpSharedKey, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info');
    const controllerX = hkdfSha512(srpSharedKey, 'Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info');
    const controllerInfo = Buffer.concat([controllerX, Buffer.from(controllerId), longTerm.publicKey]);

    const subTlv = encodeTlv([
        [PairTlv.Identifier, controllerId],
        [PairTlv.PublicKey, longTerm.publicKey],
        [PairTlv.Signature, ed25519Sign(longTerm.privateKey, controllerInfo)],
    ]);

    const m6 = await postTlv(
        connection,
        '/pair-setup',
        [
            [PairTlv.State, 5],
            [PairTlv.EncryptedData, chachaEncrypt(encryptKey, hapNonce('PS-Msg05'), subTlv)],
        ],
        'M6',
    );

    const accessoryTlv = decodeTlv(chachaDecrypt(encryptKey, hapNonce('PS-Msg06'), required(m6, PairTlv.EncryptedData, 'M6')));
    const accessoryId = required(accessoryTlv, PairTlv.Identifier, 'M6');
    const accessoryLtpk = required(accessoryTlv, PairTlv.PublicKey, 'M6');
    const accessorySignature = required(accessoryTlv, PairTlv.Signature, 'M6');

    const accessoryX = hkdfSha512(srpSharedKey, 'Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info');
    const accessoryInfo = Buffer.concat([accessoryX, accessoryId, accessoryLtpk]);
    if (!ed25519Verify(accessoryLtpk, accessoryInfo, accessorySignature)) {
        throw new Error('M6: the accessory signature is invalid');
    }

    return {
        controllerId,
        controllerLtsk: longTerm.privateKey.toString('hex'),
        controllerLtpk: longTerm.publicKey.toString('hex'),
        accessoryId: accessoryId.toString('utf8'),
        accessoryLtpk: accessoryLtpk.toString('hex'),
    };
}

/** Pair-verify (HAP 5.7): set up session keys on an existing connection using the stored pairing. */
export async function pairVerify(connection: HapConnection, pairing: PairingData): Promise<SessionKeys> {
    const ephemeral = generateX25519();

    const m2 = await postTlv(
        connection,
        '/pair-verify',
        [
            [PairTlv.State, 1],
            [PairTlv.PublicKey, ephemeral.publicKey],
        ],
        'Verify M2',
    );

    const accessoryPublicKey = required(m2, PairTlv.PublicKey, 'Verify M2');
    const sharedSecret = x25519SharedSecret(ephemeral.privateKey, accessoryPublicKey);
    const sessionKey = hkdfSha512(sharedSecret, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info');

    const accessoryTlv = decodeTlv(chachaDecrypt(sessionKey, hapNonce('PV-Msg02'), required(m2, PairTlv.EncryptedData, 'Verify M2')));
    const accessoryId = required(accessoryTlv, PairTlv.Identifier, 'Verify M2');
    const signature = required(accessoryTlv, PairTlv.Signature, 'Verify M2');

    if (accessoryId.toString('utf8') !== pairing.accessoryId) {
        throw new Error(`Verify M2: unexpected accessory ${accessoryId.toString('utf8')}`);
    }
    const accessoryInfo = Buffer.concat([accessoryPublicKey, accessoryId, ephemeral.publicKey]);
    if (!ed25519Verify(Buffer.from(pairing.accessoryLtpk, 'hex'), accessoryInfo, signature)) {
        throw new Error('Verify M2: the accessory signature is invalid');
    }

    const controllerInfo = Buffer.concat([ephemeral.publicKey, Buffer.from(pairing.controllerId), accessoryPublicKey]);
    const subTlv = encodeTlv([
        [PairTlv.Identifier, pairing.controllerId],
        [PairTlv.Signature, ed25519Sign(Buffer.from(pairing.controllerLtsk, 'hex'), controllerInfo)],
    ]);

    await postTlv(
        connection,
        '/pair-verify',
        [
            [PairTlv.State, 3],
            [PairTlv.EncryptedData, chachaEncrypt(sessionKey, hapNonce('PV-Msg03'), subTlv)],
        ],
        'Verify M4',
    );

    return {
        writeKey: hkdfSha512(sharedSecret, 'Control-Salt', 'Control-Write-Encryption-Key'),
        readKey: hkdfSha512(sharedSecret, 'Control-Salt', 'Control-Read-Encryption-Key'),
        sharedSecret,
    };
}

/** Remove a pairing (our own by default). Must run on a verified, encrypted connection. */
export async function removePairing(connection: HapConnection, controllerId: string): Promise<void> {
    await postTlv(
        connection,
        '/pairings',
        [
            [PairTlv.State, 1],
            [PairTlv.Method, PairMethod.RemovePairing],
            [PairTlv.Identifier, controllerId],
        ],
        'Remove pairing',
    );
}

/**
 * Add another controller to the accessory (HAP 5.10). Must run on a verified, encrypted connection
 * of an admin controller. Adding an id that already exists updates its permissions.
 */
export async function addPairing(connection: HapConnection, controllerId: string, controllerLtpk: Buffer, admin = false): Promise<void> {
    await postTlv(
        connection,
        '/pairings',
        [
            [PairTlv.State, 1],
            [PairTlv.Method, PairMethod.AddPairing],
            [PairTlv.Identifier, controllerId],
            [PairTlv.PublicKey, controllerLtpk],
            [PairTlv.Permissions, admin ? 1 : 0],
        ],
        'Add pairing',
    );
}

export interface PairingEntry {
    id: string;
    admin: boolean;
}

/** List the controllers paired with the accessory (HAP 5.12). Admin only. */
export async function listPairings(connection: HapConnection): Promise<PairingEntry[]> {
    const tlv = await postTlv(
        connection,
        '/pairings',
        [
            [PairTlv.State, 1],
            [PairTlv.Method, PairMethod.ListPairings],
        ],
        'List pairings',
    );
    const entries: PairingEntry[] = [];
    let current: Partial<PairingEntry> = {};
    for (const item of tlv) {
        if (item.type === PairTlv.Separator) {
            if (current.id) entries.push(current as PairingEntry);
            current = {};
        } else if (item.type === PairTlv.Identifier) {
            current.id = item.value.toString('utf8');
        } else if (item.type === PairTlv.Permissions) {
            current.admin = (item.value[0] & 1) === 1;
        }
    }
    if (current.id) entries.push({ admin: false, ...current } as PairingEntry);
    return entries;
}
