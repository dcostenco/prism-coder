/** Operator-owned text policy; never supplied by a tool request or published here. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export const OMLX_CLASSIFIER_POLICY_MAX_BYTES = 16 * 1024;
const INVALID_POLICY = "omlx_classifier_policy_invalid";
// Like other boot configuration, these remain fixed until the host reloads.
const policyFile = process.env.PRISM_OMLX_CLASSIFIER_POLICY_FILE;
const policyDigest = process.env.PRISM_OMLX_CLASSIFIER_POLICY_SHA256;
const policyAuthority = process.env.PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY;

/** Authority is a separate host opt-in; a prompt override alone keeps legacy guards. */
export function hasOmlxClassifierPolicyAuthority(): boolean {
    if (policyAuthority === undefined || policyAuthority === "legacy") return false;
    if (policyAuthority !== "policy" || readOmlxClassifierPolicy() === undefined) throw new Error(INVALID_POLICY);
    return true;
}

/** Recheck the pinned bytes before each use; a bad configured policy never falls back. */
export function readOmlxClassifierPolicy(): string | undefined {
    if (policyFile === undefined && policyDigest === undefined) return undefined;
    try {
        if (!policyFile || !isAbsolute(policyFile) || !policyDigest || !/^[a-f0-9]{64}$/.test(policyDigest)) throw new Error();
        const entry = lstatSync(policyFile);
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error();
        const fd = openSync(policyFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        let bytes: Buffer;
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size <= 0 || stat.size > OMLX_CLASSIFIER_POLICY_MAX_BYTES) throw new Error();
            const buffer = Buffer.alloc(OMLX_CLASSIFIER_POLICY_MAX_BYTES + 1);
            let length = 0;
            while (length < buffer.length) {
                const count = readSync(fd, buffer, length, buffer.length - length, null);
                if (count === 0) break;
                length += count;
            }
            if (length === 0 || length > OMLX_CLASSIFIER_POLICY_MAX_BYTES) throw new Error();
            bytes = buffer.subarray(0, length);
        } finally { closeSync(fd); }
        if (createHash("sha256").update(bytes).digest("hex") !== policyDigest) throw new Error();
        const policy = bytes.toString("utf8");
        if (!policy.trim() || !Buffer.from(policy, "utf8").equals(bytes) || policy.includes("\0") || policy.includes("{prompt}")) throw new Error();
        return policy;
    } catch { throw new Error(INVALID_POLICY); }
}
