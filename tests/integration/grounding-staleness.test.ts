/**
 * Grounding staleness — the external-review probe, as a runnable test.
 *
 * Posed by a public reviewer on 2026-08-02: "feed one deliberately outdated
 * note and verify the agent rejects or corrects it using visible grounding
 * evidence", under the rule "keep local memory only when privacy and grounding
 * are both visible". The risk named — "the data stays local, but bad grounding
 * becomes permanent" — is the correct failure mode for local-first memory,
 * because locality removes the external correction pressure.
 *
 * This asserts the half that is implemented: a stale memory reaches the model
 * VISIBLY dated, and a contradicting fresh one is distinguishable by age. It
 * deliberately does NOT assert that the model resolves the contradiction —
 * retrieval does not rank on age and nothing detects contradiction. That gap
 * is TECH_DEBT #4 and must not be smuggled into a green test.
 *
 * Isolation is a constructor argument, never an env var: PRISM_DB_PATH does not
 * exist, and an earlier hand-run of this probe wrote two rows into the real
 * store because it assumed otherwise. sqlite.ts documents why (env vars race
 * under parallel suites).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/storage/sqlite.js";
import {
    buildGroundedEvidenceContext,
    type QuerySource,
} from "../../src/tools/queryMemoryNaturalHandler.js";

const STALE_DAYS = 431;
const KEYWORDS = ["production", "database", "region"];

describe("grounding staleness probe", () => {
    let dir: string;
    let storage: SqliteStorage;
    let evidence: string;

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), "prism-grounding-"));
        storage = new SqliteStorage();
        await storage.initialize(true, join(dir, "isolated.db"));

        const save = async (conversation_id: string, summary: string): Promise<string> => {
            // saveLedger returns an ARRAY of inserted rows, not the row.
            const rows = await storage.saveLedger({
                project: "probe", conversation_id, user_id: "default",
                role: "global", summary, keywords: KEYWORDS,
            } as never) as Array<{ id: string }>;
            return rows[0].id;
        };

        const staleId = await save("c1", "Production database region is us-west-1. Deploy with legacy CLI v1.");
        await save("c2", "Production database region is eu-central-1. Deploy via git integration only.");

        // No supported API can backdate a memory: saveLedger binds BOTH
        // created_at and session_date to now and discards the caller's values,
        // and patchLedger rejects every date column. A migration writes SQL
        // directly — which is the only way this scenario can exist at all, and
        // is worth knowing: content can never be older than its row.
        const old = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();
        await (storage as unknown as { db: { execute: (q: unknown) => Promise<unknown> } }).db.execute({
            sql: "UPDATE session_ledger SET session_date=?, created_at=? WHERE id=?",
            args: [old, old, staleId],
        });

        const found = await storage.searchKnowledge({
            project: "probe", keywords: KEYWORDS,
            queryText: "production database region", limit: 10, userId: "default",
        });
        const sources = ((found?.results ?? []) as Array<Record<string, string>>).map((r) => ({
            type: "memory" as const,
            source: `ledger:${String(r.id).slice(0, 8)}`,
            recorded: r.session_date ?? r.created_at,
            content: r.summary ?? "",
        }));
        expect(sources.length, "both seeded notes must be retrievable").toBe(2);
        evidence = buildGroundedEvidenceContext(sources as QuerySource[]);
    });

    afterAll(async () => {
        // Close the DB before unlinking its directory. POSIX allows removing a
        // file that still has an open descriptor, so a leaked handle is
        // invisible on macOS/Linux; Windows refuses with
        //   EBUSY: resource busy or locked, unlink '...\isolated.db'
        // which is why this suite failed only on the windows CI legs.
        // finally: a close() failure must not skip cleanup, or this trades a
        // Windows unlink error for a leaked temp directory on every platform.
        try {
            await storage?.close();
        } finally {
            // close() alone was NOT enough (verified on CI): Windows releases
            // file handles asynchronously, so the unlink races the release and
            // still hits EBUSY. maxRetries/retryDelay is Node's documented
            // mechanism for precisely this — it retries EBUSY/EPERM/ENOTEMPTY
            // on Windows rather than failing the suite in teardown.
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });

    it("marks the outdated note with its age in the evidence the model reads", () => {
        expect(evidence).toMatch(
            new RegExp(`\\(recorded \\d{4}-\\d{2}-\\d{2}, (${STALE_DAYS}|${STALE_DAYS - 1}) days ago\\)`),
        );
    });

    it("shows the fresh note as current, so the two are distinguishable", () => {
        expect(evidence).toMatch(/\(recorded \d{4}-\d{2}-\d{2}, today\)/);
    });

    it("keeps each date attached to its own claim", () => {
        // An age label on the wrong source is worse than none — it would argue
        // for discarding the current note.
        // Split into per-source blocks rather than slicing a fixed window —
        // a fixed offset silently produced an empty string when the label sat
        // closer than expected, which read as "no date" instead of "bad slice".
        const blocks = evidence.split("[SOURCE ").filter((b) => b.includes("region is"));
        const stale = blocks.find((b) => b.includes("us-west-1")) ?? "";
        const fresh = blocks.find((b) => b.includes("eu-central-1")) ?? "";
        expect(stale, "the outdated claim carries the old date").toMatch(/days ago\)/);
        expect(fresh, "the current claim is not labelled stale").toMatch(/today\)/);
    });

    it("still delivers both claims — age annotates, it does not filter", () => {
        // Retrieval does not rank on age (TECH_DEBT #4). Pinning this keeps a
        // later recency change from silently dropping evidence instead of
        // reordering it.
        expect(evidence).toContain("us-west-1");
        expect(evidence).toContain("eu-central-1");
    });
});
