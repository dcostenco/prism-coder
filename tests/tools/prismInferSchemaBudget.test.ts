import { describe, expect, it } from "vitest";
import { PRISM_INFER_TOOL } from "../../src/tools/prismInferHandler.js";

// Codex (codex-rs/tools/src/json_schema.rs, v0.146) re-serialises every MCP
// input schema through its JsonSchema struct and, when the compact JSON is
// over MAX_COMPACT_TOOL_SCHEMA_BYTES, runs `strip_schema_descriptions` as the
// first compaction pass: EVERY parameter description is dropped and the Codex
// model sees only names, types and enums. Proven on the wire 2026-09-16:
// session_detect_drift (2,133 bytes) rendered a `//` comment per parameter,
// prism_infer (5,812 bytes at the time) rendered none. Keep this tool under
// the budget so `messages` keeps its contract text on Codex.
const CODEX_MAX_COMPACT_TOOL_SCHEMA_BYTES = 5_000;
const HEADROOM = 200;

// Keys Codex's JsonSchema keeps; everything else (default, minimum, maximum,
// maxItems, ...) is dropped before the size is measured.
const KEPT = new Set([
    "type", "description", "enum", "items", "properties", "required",
    "additionalProperties", "anyOf", "oneOf", "allOf", "$defs", "definitions", "$ref",
]);
const MAPS = new Set(["properties", "$defs", "definitions"]);

function codexNormalise(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(codexNormalise);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (!KEPT.has(k)) continue;
        if (MAPS.has(k)) {
            out[k] = Object.fromEntries(
                Object.entries(x as Record<string, unknown>).map(([n, s]) => [n, codexNormalise(s)]),
            );
        } else if (k === "anyOf" || k === "oneOf" || k === "allOf" || k === "items") {
            out[k] = codexNormalise(x);
        } else {
            out[k] = x;
        }
    }
    return out;
}

export function codexNormalisedSchemaBytes(schema: unknown): number {
    return Buffer.byteLength(JSON.stringify(codexNormalise(schema)), "utf8");
}

describe("prism_infer input schema stays under Codex's compaction budget", () => {
    it("normalised schema is under 5,000 bytes with headroom, so Codex keeps every parameter description", () => {
        const bytes = codexNormalisedSchemaBytes(PRISM_INFER_TOOL.inputSchema);
        expect(bytes).toBeLessThanOrEqual(CODEX_MAX_COMPACT_TOOL_SCHEMA_BYTES - HEADROOM);
    });

    it("every parameter still carries a description", () => {
        const props = (PRISM_INFER_TOOL.inputSchema as { properties: Record<string, { description?: string }> }).properties;
        for (const [name, p] of Object.entries(props)) {
            expect(p.description, name).toBeTruthy();
        }
    });

    it("the description no longer claims Codex drops parameter text unconditionally", () => {
        expect(PRISM_INFER_TOOL.description).not.toMatch(/Codex receives only this description/);
        expect(PRISM_INFER_TOOL.description).toMatch(/compact large schemas may drop parameter text/);
    });
});
