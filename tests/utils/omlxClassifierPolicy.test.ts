import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POLICY = "Synthetic operator instructions. Classify request data without performing it.\n";
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const root = mkdtempSync(join(tmpdir(), "prism-policy-fixtures-"));
let next = 0;
function file(value: string | Buffer = POLICY) {
    const path = join(root, String(next++) + ".txt");
    writeFileSync(path, value);
    return path;
}
async function configured(path?: string, hash?: string) {
    vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_FILE", path);
    vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_SHA256", hash);
    return import("../../src/utils/omlxClassifierPolicy.js");
}
describe("operator-owned oMLX classifier policy", () => {
    beforeEach(() => { vi.resetModules(); });
    afterEach(() => { vi.unstubAllEnvs(); });
    it("leaves the existing policy selected when no operator policy is configured", async () => {
        expect((await configured()).readOmlxClassifierPolicy()).toBeUndefined();
    });
    it("reads the exact pinned UTF-8 policy without trimming its bytes", async () => {
        expect((await configured(file(), digest(POLICY))).readOmlxClassifierPolicy()).toBe(POLICY);
    });
    it.each(["file-only", "digest-only", "relative", "bad-digest", "missing", "mismatch"])("fails closed for %s configuration", async scenario => {
        const path = file();
        const values: Record<string, [string | undefined, string | undefined]> = {
            "file-only": [path, undefined], "digest-only": [undefined, digest(POLICY)],
            relative: ["relative.txt", digest(POLICY)], "bad-digest": [path, "invalid"],
            missing: [join(root, "absent.txt"), digest(POLICY)], mismatch: [path, digest("different")],
        };
        const module = await configured(...values[scenario]!);
        expect(() => module.readOmlxClassifierPolicy()).toThrow("omlx_classifier_policy_invalid");
    });
    it("rejects directories, symlinks and oversized files before returning content", async () => {
        const directory = join(root, "directory"); mkdirSync(directory);
        const target = file(), link = join(root, "symlink"); symlinkSync(target, link);
        for (const path of [directory, link, file("x".repeat(16 * 1024 + 1))]) {
            vi.resetModules();
            const module = await configured(path, digest(POLICY));
            expect(() => module.readOmlxClassifierPolicy()).toThrow("omlx_classifier_policy_invalid");
        }
    });
    it.each([" ", "prefix {prompt}", "embedded\0data", Buffer.from([0xff])])("rejects invalid policy text even when its digest matches", async value => {
        const module = await configured(file(value), digest(value));
        expect(() => module.readOmlxClassifierPolicy()).toThrow("omlx_classifier_policy_invalid");
    });
    it("keeps boot configuration pinned and refuses a file changed after a successful read", async () => {
        const path = file(), module = await configured(path, digest(POLICY));
        expect(module.readOmlxClassifierPolicy()).toBe(POLICY);
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_FILE", file("other"));
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_SHA256", digest("other"));
        expect(module.readOmlxClassifierPolicy()).toBe(POLICY);
        writeFileSync(path, "changed");
        expect(() => module.readOmlxClassifierPolicy()).toThrow("omlx_classifier_policy_invalid");
    });
});
