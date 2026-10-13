/**
 * Device identity for E2E sync — one X25519 keypair per machine.
 *
 * The private key is generated here, written with 0600 permissions, and NEVER
 * leaves this machine — not to the portal, not into a blob, not into logs.
 * Only the PUBLIC key is published (at device registration) so other devices
 * can seal envelopes to it. Losing the file means this device can no longer
 * open blobs sealed to it; that is the designed failure mode, strictly better
 * than any recovery path that would require the key to exist somewhere else.
 *
 * Storage: <dataDir>/sync-device-key.pem (PKCS8 PEM), alongside the config DB.
 * Resolution mirrors the ledger's: PRISM_DATA_DIR (test sandbox / relocation)
 * else ~/.prism-mcp. Tests must never touch a real device key.
 */

import {
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    randomBytes,
    type KeyObject,
} from "node:crypto";
import {
    closeSync,
    fchmodSync,
    fsyncSync,
    linkSync,
    mkdirSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { keyIdOf, rawFromPublicKey, EnvelopeError } from "./syncEnvelope.js";

const KEY_FILENAME = "sync-device-key.pem";

function keyPath(): string {
    const dir = process.env.PRISM_DATA_DIR
        ? resolve(process.env.PRISM_DATA_DIR)
        : resolve(homedir(), ".prism-mcp");
    return resolve(dir, KEY_FILENAME);
}

export interface DeviceIdentity {
    privateKey: KeyObject;
    publicKey: KeyObject;
    /** Raw 32-byte public key — the shape published at registration. */
    rawPublicKey: Buffer;
    /** Stable id other parties derive from the public key. */
    keyId: string;
    /** True when this call created the key (first run on this machine). */
    created: boolean;
}

/** The existing key file's text, or null when there is none yet. */
function readExistingKey(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw new EnvelopeError(
            `device key at ${path} exists but cannot be read — refusing to rotate an established ` +
            `identity automatically (${e instanceof Error ? e.message : e})`);
    }
}

function identityFromPem(path: string, pem: string): DeviceIdentity {
    let privateKey: KeyObject;
    try {
        privateKey = createPrivateKey(pem);
    } catch (e) {
        throw new EnvelopeError(
            `device key at ${path} exists but cannot be parsed — refusing to rotate an established ` +
            `identity automatically (${e instanceof Error ? e.message : e})`);
    }
    if (privateKey.asymmetricKeyType !== "x25519") {
        throw new EnvelopeError(`device key at ${path} is ${privateKey.asymmetricKeyType}, expected x25519`);
    }
    const publicKey = createPublicKey(privateKey);
    const rawPublicKey = rawFromPublicKey(publicKey);
    return { privateKey, publicKey, rawPublicKey, keyId: keyIdOf(rawPublicKey), created: false };
}

/** Write the whole PEM through a descriptor that only this call created. */
function writePrivateFile(fd: number, pem: string): void {
    try {
        // The open() mode is masked by umask, and a device key readable by
        // group/other for even a moment is a defect, so set it on the
        // descriptor before any key byte is written. (On Windows, POSIX modes
        // are advisory — the profile directory ACL is the boundary.)
        fchmodSync(fd, 0o600);
        writeFileSync(fd, pem);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

/** Errors meaning this filesystem cannot hard-link, not that the key exists. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

/**
 * Publish the key at `path` without replacing one and without ever exposing a
 * partial file. The PEM is written and fsynced to a private temp file in the
 * same directory, then hard-linked into place: link() is atomic and fails with
 * EEXIST instead of overwriting, so a concurrent first run sees either no key
 * or the complete key. Returns false when another writer published first.
 */
function publishKey(dir: string, path: string, pem: string): boolean {
    const temp = resolve(dir, `.${KEY_FILENAME}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    // 'wx' = exclusive create; a file or symlink already at the temp name fails
    // with EEXIST instead of being followed.
    writePrivateFile(openSync(temp, "wx", 0o600), pem);
    try {
        linkSync(temp, path);
        return true;
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST") return false;
        if (code !== undefined && NO_HARD_LINKS.has(code)) return createInPlace(path, pem);
        throw e;
    } finally {
        try {
            unlinkSync(temp);
        } catch {
            // Already removed; nothing else refers to the temp name.
        }
    }
}

/** Fallback without hard links: exclusive create at the final path. */
function createInPlace(path: string, pem: string): boolean {
    let fd: number;
    try {
        fd = openSync(path, "wx", 0o600);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e;
    }
    writePrivateFile(fd, pem);
    return true;
}

/**
 * Load this machine's device key, creating it on first use.
 *
 * Never overwrites: an existing file is authoritative even if unreadable as a
 * key — failing loudly beats silently rotating an identity that other devices
 * have already sealed blobs to. The file is read directly rather than checked
 * first, so there is no window between a check and its use.
 */
export function loadOrCreateDeviceIdentity(): DeviceIdentity {
    const path = keyPath();
    const existing = readExistingKey(path);
    if (existing !== null) return identityFromPem(path, existing);

    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    const dir = resolve(path, "..");
    // A recursive mkdir succeeds when the directory already exists.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!publishKey(dir, path, pem)) {
        // Lost the creation race — the other writer's complete identity wins.
        return loadOrCreateDeviceIdentity();
    }
    const rawPublicKey = rawFromPublicKey(publicKey);
    return { privateKey, publicKey, rawPublicKey, keyId: keyIdOf(rawPublicKey), created: true };
}
