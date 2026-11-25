import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostTaskRecord, consumeHostTaskRecord, HOST_TASK_TTL_MS } from "../../src/utils/hostTaskRecords.js";

const binding = { kind: "prism_infer" as const, request_sha256: "a".repeat(64), task_sha256: "b".repeat(64), environment_sha256: "c".repeat(64) };
let temp: string, directory: string;
beforeEach(() => { temp = mkdtempSync(join(tmpdir(), "prism-host-records-")); directory = join(temp, "records"); });
afterEach(() => rmSync(temp, { recursive: true, force: true }));
const options = () => ({ directory, now: () => 1000 });

describe("host task records", () => {
    it("stores hashes only and accepts canonical JSON key order once", () => {
        const record = createHostTaskRecord(binding, options());
        const sorted = JSON.parse(JSON.stringify(record, Object.keys(record).sort()));
        expect(record.id).toMatch(/^[a-f0-9]{48}$/);
        expect(readFileSync(join(directory, record.id + ".json"), "utf8")).not.toContain("prompt");
        consumeHostTaskRecord(sorted, options());
        expect(() => consumeHostTaskRecord(record, options())).toThrow("already_used");
    });
    it("rejects modified request, task, environment, unknown fields and persisted bytes", () => {
        for (const key of ["request_sha256", "task_sha256", "environment_sha256"]) {
            const record = createHostTaskRecord(binding, options());
            expect(() => consumeHostTaskRecord({ ...record, [key]: "d".repeat(64) }, options())).toThrow();
        }
        const record = createHostTaskRecord(binding, options());
        expect(() => consumeHostTaskRecord({ ...record, approved: true } as typeof record, options())).toThrow();
        writeFileSync(join(directory, record.id + ".json"), JSON.stringify({ ...record, kind: "query_memory_natural" }));
        expect(() => consumeHostTaskRecord(record, options())).toThrow();
    });
    it("refuses expired and future approvals before publishing a use marker", () => {
        const record = createHostTaskRecord(binding, options());
        expect(() => consumeHostTaskRecord(record, { directory, now: () => 999 })).toThrow("expired");
        expect(() => consumeHostTaskRecord(record, { directory, now: () => 1000 + HOST_TASK_TTL_MS })).toThrow("expired");
        expect(readdirSync(directory)).toEqual([record.id + ".json"]);
    });
    it("refuses a claim whose deadline elapsed while its marker was being written", () => {
        const record = createHostTaskRecord(binding, options());
        let reads = 0;
        const now = () => reads++ === 0 ? record.expires_at - 1 : record.expires_at;
        expect(() => consumeHostTaskRecord(record, { directory, now })).toThrow("host_task_expired");
        expect(readdirSync(directory)).toContain(record.id + ".used");
    });
    it("clears the orphan marker when the pending record was retired during the claim", () => {
        const record = createHostTaskRecord(binding, options());
        let retired = false;
        const now = () => {
            if (!retired) {
                retired = true;
                unlinkSync(join(directory, record.id + ".json"));
            }
            return 1000;
        };
        expect(() => consumeHostTaskRecord(record, { directory, now })).toThrow("ENOENT");
        expect(readdirSync(directory)).toEqual([]);
    });
    it("refuses symlink records and unsafe record permissions", () => {
        const record = createHostTaskRecord(binding, options());
        const path = join(directory, record.id + ".json");
        chmodSync(path, 0o644); expect(() => consumeHostTaskRecord(record, options())).toThrow();
        chmodSync(path, 0o600); rmSync(path); symlinkSync(join(temp, "other.json"), path);
        writeFileSync(join(temp, "other.json"), JSON.stringify(record), { mode: 0o600 });
        expect(() => consumeHostTaskRecord(record, options())).toThrow();
    });
    it("refuses symlink directories and writable data parents", () => {
        const other = join(temp, "other");
        symlinkSync(temp, directory); expect(() => createHostTaskRecord(binding, options())).toThrow();
        unlinkSync(directory); chmodSync(temp, 0o777);
        expect(() => createHostTaskRecord(binding, { directory: other, now: () => 1000 })).toThrow();
        chmodSync(temp, 0o700);
    });
    it("durably admits one consumer and retires only expired protocol records", async () => {
        const record = createHostTaskRecord(binding, options());
        const outcomes = await Promise.allSettled([1, 2].map(async () => consumeHostTaskRecord(record, options())));
        expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1);
        expect(readdirSync(directory)).toContain(record.id + ".used");
        writeFileSync(join(directory, "operator-note.txt"), "retain", { mode: 0o600 });
        createHostTaskRecord(binding, { directory, now: () => 1000 + HOST_TASK_TTL_MS });
        expect(readdirSync(directory)).not.toContain(record.id + ".used");
        expect(readFileSync(join(directory, "operator-note.txt"), "utf8")).toBe("retain");
        expect(() => consumeHostTaskRecord(record, { directory, now: () => 1000 + HOST_TASK_TTL_MS })).toThrow();
    });
});
