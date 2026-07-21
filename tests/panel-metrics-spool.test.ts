import { randomUUID } from "node:crypto";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    _resetInferLedgerForTest,
    queryInferMetrics,
} from "../src/storage/inferMetricsLedger.js";
import {
    getPanelMetricsSpoolPath,
    ingestPanelMetrics,
} from "../src/storage/panelMetricsSpool.js";
import { inferenceMetricsHandler } from "../src/utils/inferenceMetrics.js";

const PANEL_PATH_ENV = "PRISM_PANEL_METRICS_PATH";
const LEDGER_PATH_ENV = "PRISM_INFER_LEDGER_DB_PATH";

interface TestPanelEvent {
    v: number;
    event_id: string;
    ts: number;
    event: "panel_served_local" | "panel_escalated";
    backend: "prism" | "local" | "cloud" | "gemini";
    model: string | null;
    used_cloud: boolean;
    mode: "chat" | "code";
    prompt_tokens: number | null;
    completion_tokens: number | null;
    latency_ms: number;
}

let directory: string;
let spoolPath: string;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "panel-spool-"));
    spoolPath = join(directory, "panel-metrics.jsonl");
    process.env[PANEL_PATH_ENV] = spoolPath;
    process.env[LEDGER_PATH_ENV] = join(directory, "metrics.db");
    _resetInferLedgerForTest();
});

afterEach(async () => {
    delete process.env[PANEL_PATH_ENV];
    delete process.env[LEDGER_PATH_ENV];
    delete process.env.PRISM_DATA_DIR;
    _resetInferLedgerForTest();
    await rm(directory, { recursive: true, force: true });
});

describe("panel metrics spool ingestion", () => {
    it("imports local and escalated rows with caller-specific aggregates", async () => {
        const local = event({ event: "panel_served_local", backend: "local", used_cloud: false });
        const cloud = event({ event: "panel_escalated", backend: "cloud", used_cloud: true });
        writeEvents(spoolPath, local, cloud);

        const ingest = await ingestPanelMetrics();
        expect(ingest).toMatchObject({
            claimed_files: 1,
            seen: 2,
            valid: 2,
            inserted: 2,
            duplicates: 0,
            invalid: 0,
            failed_files: 0,
        });
        expect(existsSync(spoolPath)).toBe(false);

        const aggregate = await queryInferMetrics();
        expect(aggregate?.total).toBe(2);
        expect(aggregate?.by_caller.panel).toMatchObject({ total: 2, local: 1, cloud: 1 });
        expect(aggregate?.by_backend.local).toBe(1);
        expect(aggregate?.by_backend.cloud).toBe(1);
    });

    it("deduplicates a claimed-file replay by source event ID", async () => {
        const local = event({ event: "panel_served_local", backend: "prism", used_cloud: false });
        writeEvents(spoolPath, local);
        expect((await ingestPanelMetrics()).inserted).toBe(1);

        writeEvents(spoolPath, local);
        const replay = await ingestPanelMetrics();
        expect(replay.inserted).toBe(0);
        expect(replay.duplicates).toBe(1);
        expect((await queryInferMetrics())?.total).toBe(1);
    });

    it("isolates malformed, oversized, and contradictory rows", async () => {
        const valid = event({ event: "panel_served_local", backend: "local", used_cloud: false });
        const contradictory = { ...valid, event_id: randomUUID(), backend: "cloud" };
        const unknownField = { ...valid, event_id: randomUUID(), prompt: "must not enter metrics" };
        const oversized = JSON.stringify({ ...valid, event_id: randomUUID(), padding: "x".repeat(5_000) });
        writeFileSync(spoolPath, [
            JSON.stringify(valid),
            JSON.stringify(contradictory),
            JSON.stringify(unknownField),
            oversized,
            "{broken-json",
        ].join("\n") + "\n");

        const ingest = await ingestPanelMetrics();
        expect(ingest).toMatchObject({ seen: 5, valid: 1, inserted: 1, invalid: 4, failed_files: 0 });
        expect((await queryInferMetrics())?.total).toBe(1);
        expect(existsSync(spoolPath)).toBe(false);
    });

    it("retains a claimed file when SQLite is unavailable and ingests it on retry", async () => {
        const blockedParent = join(directory, "not-a-directory");
        writeFileSync(blockedParent, "blocks database parent creation");
        process.env[LEDGER_PATH_ENV] = join(blockedParent, "metrics.db");
        _resetInferLedgerForTest();
        writeEvents(spoolPath, event({ event: "panel_served_local", backend: "local", used_cloud: false }));

        const failed = await ingestPanelMetrics();
        expect(failed.failed_files).toBe(1);
        expect(readdirSync(directory).some(name => name.startsWith("panel-metrics.jsonl.pending-"))).toBe(true);

        process.env[LEDGER_PATH_ENV] = join(directory, "recovered.db");
        _resetInferLedgerForTest();
        const retried = await ingestPanelMetrics();
        expect(retried).toMatchObject({ inserted: 1, failed_files: 0 });
        expect((await queryInferMetrics())?.by_caller.panel.total).toBe(1);
    });

    it("recovers a stale processing file left by a crashed ingester", async () => {
        const orphan = `${spoolPath}.processing-999-${Date.now()}-${randomUUID()}`;
        writeEvents(orphan, event({ event: "panel_served_local", backend: "prism", used_cloud: false }));
        const stale = new Date(Date.now() - 10 * 60_000);
        utimesSync(orphan, stale, stale);

        const ingest = await ingestPanelMetrics();
        expect(ingest).toMatchObject({ claimed_files: 1, inserted: 1, failed_files: 0 });
        expect(existsSync(orphan)).toBe(false);
    });

    it("all-time handler ingests the spool and exposes the panel local-serve rate", async () => {
        writeEvents(
            spoolPath,
            event({ event: "panel_served_local", backend: "local", used_cloud: false }),
            event({ event: "panel_served_local", backend: "prism", used_cloud: false }),
            event({ event: "panel_escalated", backend: "gemini", used_cloud: true }),
        );

        const response = await inferenceMetricsHandler({ period: "all" });
        expect(response.content[0].text).toContain("Panel local serve rate: 67% (2/3; cloud 1)");
        expect(response.content[0].text).toContain("Total calls: 3");
        expect(existsSync(spoolPath)).toBe(false);
    });

    it("honors PRISM_DATA_DIR when no explicit spool override is present", () => {
        delete process.env[PANEL_PATH_ENV];
        process.env.PRISM_DATA_DIR = directory;
        expect(getPanelMetricsSpoolPath()).toBe(join(directory, "panel-metrics.jsonl"));
        delete process.env.PRISM_DATA_DIR;
    });
});

function event(overrides: Pick<TestPanelEvent, "event" | "backend" | "used_cloud">): TestPanelEvent {
    return {
        v: 1,
        event_id: randomUUID(),
        ts: Date.now(),
        event: overrides.event,
        backend: overrides.backend,
        model: overrides.used_cloud ? "cloud-fallback" : "prism-coder:test",
        used_cloud: overrides.used_cloud,
        mode: "code",
        prompt_tokens: 20,
        completion_tokens: 10,
        latency_ms: 50,
    };
}

function writeEvents(path: string, ...events: TestPanelEvent[]): void {
    writeFileSync(path, events.map(value => JSON.stringify(value)).join("\n") + "\n");
}
