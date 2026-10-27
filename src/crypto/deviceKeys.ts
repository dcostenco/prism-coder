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
    closeSync, fchmodSync, fsyncSync, linkSync, mkdirSync, openSync,
    readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { keyIdOf, rawFromPublicKey, EnvelopeError } from "./syncEnvelope.js";

const KEY_FILENAME = "sync-device-key.pem";
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);
// libuv maps Windows ERROR_INVALID_FUNCTION to EISDIR.
const WINDOWS_NO_HARD_LINKS = new Set(["EISDIR"]);
const KEY_PERMISSION_ERROR = "Cannot protect the device key. Choose a PRISM_DATA_DIR on a filesystem that supports private key permissions";
const KEY_CLEANUP_ERROR = "Device key operation and staging cleanup failed";

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

/** Read directly; an existing but unreadable key must never be rotated. */
function readExistingKey(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new EnvelopeError(
            `device key at ${path} cannot be read — refusing to rotate an established ` +
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

/** Permissions and writes operate only on the descriptor this call created. */
function writePrivateFile(fd: number, pem: string): void {
    try {
        // Also handles a restrictive umask. Windows relies on the profile ACL.
        try {
            fchmodSync(fd, 0o600);
        } catch (e) {
            throw new EnvelopeError(`${KEY_PERMISSION_ERROR} (${e instanceof Error ? e.message : e})`);
        }
        writeFileSync(fd, pem);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

/** Exclusive creation when private permissions work but hard links do not. */
function createInPlace(path: string, pem: string): boolean {
    let fd: number;
    try {
        fd = openSync(path, "wx", 0o600);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e;
    }
    // This compatibility fallback prevents replacement, but a concurrent
    // reader can still fail closed on an incomplete file, as before.
    writePrivateFile(fd, pem);
    return true;
}

/** Publish a complete staged PEM without replacing an established identity. */
function publishKey(dir: string, path: string, pem: string): boolean {
    const temp = resolve(dir, `.${KEY_FILENAME}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    const fd = openSync(temp, "wx", 0o600);
    let operationFailed = false;
    let operationError: unknown;
    try {
        writePrivateFile(fd, pem);
        try {
            linkSync(temp, path);
            return true;
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === "EEXIST") return false;
            if (code !== undefined && (NO_HARD_LINKS.has(code)
                || (process.platform === "win32" && WINDOWS_NO_HARD_LINKS.has(code)))) return createInPlace(path, pem);
            throw e;
        }
    } catch (e) {
        operationFailed = true;
        operationError = e;
        throw e;
    } finally {
        try {
            unlinkSync(temp);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
                // Fail loudly on cleanup errors. A published key stays
                // authoritative, and the original failure must not be lost.
                if (operationFailed) throw new AggregateError([operationError, e],
                    operationError instanceof Error ? operationError.message : KEY_CLEANUP_ERROR,
                    { cause: operationError });
                throw e;
            }
        }
    }
}

/**
 * Load this machine's device key, creating it on first use.
 * Existing files are authoritative, even if unreadable. Where hard links are
 * supported, publish only after the private staged PEM is written and synced.
 */
export function loadOrCreateDeviceIdentity(): DeviceIdentity {
    const path = keyPath();
    const existing = readExistingKey(path);
    if (existing !== null) return identityFromPem(path, existing);

    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    const dir = resolve(path, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!publishKey(dir, path, pem)) {
        const winner = readExistingKey(path);
        if (winner === null) {
            // A dangling link or a disappearing competitor must not recurse.
            throw new EnvelopeError(`device key at ${path} is unavailable after a creation race — refusing to rotate`);
        }
        return identityFromPem(path, winner);
    }
    const rawPublicKey = rawFromPublicKey(publicKey);
    return { privateKey, publicKey, rawPublicKey, keyId: keyIdOf(rawPublicKey), created: true };
}
