import crypto from 'node:crypto';

/** Crypto primitives HAP needs, built on node:crypto only (no native add-ons). */

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface KeyPair {
    publicKey: Buffer; // 32 raw bytes
    privateKey: Buffer; // 32 raw bytes (seed)
}

function rawFromDer(der: Buffer, prefixLength: number): Buffer {
    return Buffer.from(der.subarray(prefixLength));
}

export function generateEd25519(): KeyPair {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        publicKey: rawFromDer(publicKey.export({ format: 'der', type: 'spki' }), ED25519_SPKI_PREFIX.length),
        privateKey: rawFromDer(privateKey.export({ format: 'der', type: 'pkcs8' }), ED25519_PKCS8_PREFIX.length),
    };
}

export function ed25519Sign(privateKey: Buffer, message: Buffer): Buffer {
    const key = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, privateKey]), format: 'der', type: 'pkcs8' });
    return crypto.sign(null, message, key);
}

export function ed25519Verify(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
    return crypto.verify(null, message, key, signature);
}

export function generateX25519(): KeyPair {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    return {
        publicKey: rawFromDer(publicKey.export({ format: 'der', type: 'spki' }), X25519_SPKI_PREFIX.length),
        privateKey: rawFromDer(privateKey.export({ format: 'der', type: 'pkcs8' }), X25519_PKCS8_PREFIX.length),
    };
}

export function x25519SharedSecret(privateKey: Buffer, peerPublicKey: Buffer): Buffer {
    return crypto.diffieHellman({
        privateKey: crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, privateKey]), format: 'der', type: 'pkcs8' }),
        publicKey: crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, peerPublicKey]), format: 'der', type: 'spki' }),
    });
}

export function hkdfSha512(ikm: Buffer, salt: string, info: string, length = 32): Buffer {
    return Buffer.from(crypto.hkdfSync('sha512', ikm, Buffer.from(salt), Buffer.from(info), length));
}

/** HAP nonces are 12 bytes: 4 zero bytes followed by an 8-byte value. */
export function hapNonce(value: string | bigint): Buffer {
    const nonce = Buffer.alloc(12);
    if (typeof value === 'string') {
        Buffer.from(value).copy(nonce, 4);
    } else {
        nonce.writeBigUInt64LE(value, 4);
    }
    return nonce;
}

export function chachaEncrypt(key: Buffer, nonce: Buffer, plaintext: Buffer, aad?: Buffer): Buffer {
    const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    if (aad) cipher.setAAD(aad, { plaintextLength: plaintext.length });
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([encrypted, cipher.getAuthTag()]);
}

/** Decrypts `ciphertext || tag`. Throws when authentication fails. */
export function chachaDecrypt(key: Buffer, nonce: Buffer, data: Buffer, aad?: Buffer): Buffer {
    const ciphertext = data.subarray(0, data.length - 16);
    const tag = data.subarray(data.length - 16);
    const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    if (aad) decipher.setAAD(aad, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
