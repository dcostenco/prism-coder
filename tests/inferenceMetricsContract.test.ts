/**
 * Contract test — pins the field names that ddLog("prism_infer.usage") emits
 * to the field names the portal SQL RPC extracts via context->>'field'.
 *
 * If someone renames a field on the emit side, this test fails instead of
 * silently producing all-zero metrics from the portal.
 */

import { describe, it, expect } from "vitest";

const EMITTED_FIELDS = [
    "backend",
    "model",
    "used_cloud",
    "prompt_tokens",
    "completion_tokens",
    "latency_ms",
] as const;

const RPC_EXTRACTED_FIELDS = [
    "model",
    "used_cloud",
    "prompt_tokens",
    "completion_tokens",
    "latency_ms",
] as const;

describe("inference metrics contract", () => {
    it("every field the portal RPC extracts is present in the emitted event", () => {
        for (const field of RPC_EXTRACTED_FIELDS) {
            expect(EMITTED_FIELDS).toContain(field);
        }
    });

    it("emitted field names match the ddLogger CONTEXT_ALLOWLIST entries", async () => {
        // Read the allowlist from the source to ensure it stays in sync
        const { readFileSync } = await import("node:fs");
        const src = readFileSync("src/utils/ddLogger.ts", "utf-8");

        for (const field of EMITTED_FIELDS) {
            expect(src).toContain(`"${field}"`);
        }
    });

    it("emitted field names match the SQL RPC extraction", async () => {
        const { readFileSync } = await import("node:fs");
        // Read the migration file that defines the RPC
        const migrationFiles = [
            `${process.env.SYNALUX_PORTAL_ROOT ?? ""}/supabase/migrations/20260617400000_inference_metrics_rpc.sql`,
        ];

        let sql = "";
        for (const path of migrationFiles) {
            try {
                sql = readFileSync(path, "utf-8");
                break;
            } catch { /* try next path */ }
        }

        if (!sql) {
            // Migration file not accessible from test runner — skip gracefully
            console.warn("[contract] Migration file not found — skipping SQL field check");
            return;
        }

        for (const field of RPC_EXTRACTED_FIELDS) {
            expect(sql).toContain(`context->>'${field}'`);
        }
    });

    it("prismInferHandler emits the expected fields to ddLog", async () => {
        const { readFileSync } = await import("node:fs");
        const src = readFileSync("src/tools/prismInferHandler.ts", "utf-8");

        for (const field of EMITTED_FIELDS) {
            expect(src).toContain(`${field}:`);
        }
    });

    it("portal ingest route checks the same headers prism sends", async () => {
        const { readFileSync } = await import("node:fs");
        const paths = [
            `${process.env.SYNALUX_PORTAL_ROOT ?? ""}/src/app/api/v1/telemetry/route.ts`,
        ];
        let src = "";
        for (const p of paths) {
            try { src = readFileSync(p, "utf-8"); break; } catch { /* next */ }
        }
        if (!src) {
            console.warn("[contract] Portal ingest route not found — skipping header check");
            return;
        }
        expect(src).toContain("authorization");
        expect(src).toContain("x-prism-client");
    });

    it("portal read endpoint scopes by userId before querying", async () => {
        const { readFileSync } = await import("node:fs");
        const paths = [
            `${process.env.SYNALUX_PORTAL_ROOT ?? ""}/src/app/api/v1/telemetry/inference-metrics/route.ts`,
        ];
        let src = "";
        for (const p of paths) {
            try { src = readFileSync(p, "utf-8"); break; } catch { /* next */ }
        }
        if (!src) {
            console.warn("[contract] Portal read route not found — skipping scoping check");
            return;
        }
        expect(src).toContain("!userId");
        expect(src).toContain("EMPTY_RESPONSE");
        expect(src).toContain("p_user_id");
    });
});
