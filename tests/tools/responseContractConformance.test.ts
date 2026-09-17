/**
 * A field a tool's description promises in its response must actually appear
 * there.
 *
 * `prism_infer`'s description stated that "every entitlement-resolved result
 * reports `multi_turn` ... and `history_turns`". Both were computed, set on the
 * result and written to the metrics ledger — and never rendered. The promise
 * was false for a full release, and 4,792 tests did not notice, because none of
 * them compared a documented claim against a produced response. An external
 * benchmark degraded silently as a result and published the degradation as a
 * model defect.
 *
 * Three directions, so neither the prose nor the registry can drift alone:
 *   A. every declared field appears in a rendered response;
 *   B. every promise detected in a description is declared (anti-vacuity — a
 *      registry nobody updates must fail, not pass silently);
 *   C. every declared field is still mentioned in the description (catches a
 *      stale declaration after a doc rewrite).
 *
 * The detector is heuristic, so it is used ONLY to raise (§B.3: raising costs
 * nothing to be wrong about; a false positive is fixed by rewording the
 * description or declaring the field). It never certifies a tool as clean, and
 * it is itself under test below — an unvalidated instrument is the defect class
 * this whole file exists to catch.
 */
import { describe, it, expect } from "vitest";
import { getAvailableTools } from "../../src/server.js";
import { inferResponseHeader, type PrismInferResult } from "../../src/tools/prismInferHandler.js";
import { computeRoute } from "../../src/tools/taskRouterHandler.js";

/** Reporting verbs, then a `backticked` identifier within REPORT_WINDOW chars. */
const REPORT_VERB =
    /\b(report|reports|reported|return|returns|returned|include|includes|expose|exposes|emit|emits|surface|surfaces|carr(?:y|ies))\b/gi;
const REPORT_WINDOW = 60;

/**
 * Identifiers a description promises to put IN THE RESPONSE.
 *
 * Two exclusions, both derived from data rather than from a suppression list —
 * a suppression list becomes a place to hide real failures:
 *
 *  - the tool's own input properties. `session_route_prompt` says "anything
 *    named in `loaded` is never returned again", which describes its input.
 *  - the name of any advertised tool. `session_task_route` says to "call the
 *    returned `recommended_tool` (`prism_infer`)", where the parenthetical
 *    names a tool, not a field. `recommended_tool` itself IS a promise and is
 *    still caught.
 */
export function detectPromisedResponseFields(
    description: string,
    inputPropertyNames: readonly string[] = [],
    knownToolNames: readonly string[] = [],
): string[] {
    const excluded = new Set([...inputPropertyNames, ...knownToolNames]);
    const found = new Set<string>();
    for (const m of description.matchAll(REPORT_VERB)) {
        const window = description.slice(m.index, m.index + REPORT_WINDOW);
        for (const f of window.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) {
            if (!excluded.has(f[1])) found.add(f[1]);
        }
    }
    return [...found].sort();
}

interface ResponseContract {
    /** Fields the description promises the response carries. */
    fields: string[];
    /** A representative rendered response for those fields. */
    render: () => string;
}

/**
 * Tools whose description promises response fields. Adding a promise to a
 * description without adding it here fails direction B.
 *
 * Every renderer is a PURE exported function, so the contract is proven without
 * standing up Ollama, the portal or the database.
 */
const RESPONSE_CONTRACTS: Record<string, ResponseContract> = {
    prism_infer: {
        fields: ["history_turns", "multi_turn", "clinical_sections"],
        render: () =>
            inferResponseHeader({
                output: "ok",
                backend: "ollama-9b",
                model_picked: "prism-coder:9b",
                ram_free_mb: 14_000,
                latency_ms: 1_234,
                used_cloud: false,
                attempts: [],
                plan: "enterprise",
                history_turns: 0,
                multi_turn: { enabled: true, max_turns: 30, max_chars: 96_000 },
                clinical_sections: { required: 10, present: 9, missing: ["decision_rules"] },
            } as PrismInferResult),
    },
    session_task_route: {
        fields: ["target", "recommended_tool", "recommended_args"],
        render: () =>
            JSON.stringify(
                computeRoute({
                    task_description: "Add a null check to the price formatter and a unit test for it.",
                    estimated_scope: "minor_edit",
                }),
            ),
    },
};

const tools = getAvailableTools();
const toolNames = tools.map(t => t.name);

describe("the promise detector is itself trustworthy", () => {
    it("catches a reporting claim about a response field", () => {
        expect(
            detectPromisedResponseFields("Every result reports `history_turns` (what was sent)."),
        ).toEqual(["history_turns"]);
    });

    it("ignores an identifier that names one of the tool's own inputs", () => {
        expect(
            detectPromisedResponseFields("anything named in `loaded` is never returned again", ["loaded"]),
        ).toEqual([]);
    });

    it("ignores a parenthetical naming another tool, but still catches the field beside it", () => {
        // `recommended_args` sits past REPORT_WINDOW from "returned" and is NOT
        // detected — the window is a floor, not a census. Direction B only needs
        // the detector to raise SOMETHING for this tool; the contract below
        // declares all three fields, which is stronger than what it caught.
        expect(
            detectPromisedResponseFields(
                "call the returned `recommended_tool` (`prism_infer`) with `recommended_args`",
                [],
                ["prism_infer"],
            ),
        ).toEqual(["recommended_tool"]);
    });

    it("ignores a backticked identifier with no reporting verb near it", () => {
        expect(
            detectPromisedResponseFields("pass the accepted prior turns as `messages`"),
        ).toEqual([]);
    });

    it("does not reach across unrelated prose far from the verb", () => {
        const far = `returns a single line. ${"x".repeat(REPORT_WINDOW)} \`unrelated\``;
        expect(detectPromisedResponseFields(far)).toEqual([]);
    });
});

describe("A. every declared response field appears in a rendered response", () => {
    for (const [name, contract] of Object.entries(RESPONSE_CONTRACTS)) {
        it(`${name} renders every field its description promises`, () => {
            const rendered = contract.render();
            for (const field of contract.fields) {
                expect(
                    rendered,
                    `${name} promises \`${field}\` but the rendered response does not contain it`,
                ).toContain(field);
            }
        });
    }
});

describe("B. a promise in a description must be declared (anti-vacuity)", () => {
    it("every advertised tool's promised fields are covered by a contract", () => {
        const undeclared: string[] = [];
        for (const tool of tools) {
            const props = Object.keys(
                (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {},
            );
            const promised = detectPromisedResponseFields(tool.description ?? "", props, toolNames);
            const declared = new Set(RESPONSE_CONTRACTS[tool.name]?.fields ?? []);
            for (const field of promised) {
                if (!declared.has(field)) undeclared.push(`${tool.name}: \`${field}\``);
            }
        }
        expect(
            undeclared,
            "these descriptions promise a response field with no contract proving it is rendered — " +
                "add it to RESPONSE_CONTRACTS, or reword the description if it is not a response field",
        ).toEqual([]);
    });

    it("scans a non-trivial number of tools, so a passing result is not vacuous", () => {
        expect(tools.length).toBeGreaterThan(20);
    });
});

describe("C. a declared field must still be promised in the description", () => {
    for (const [name, contract] of Object.entries(RESPONSE_CONTRACTS)) {
        it(`${name}'s declared fields are all still mentioned in its description`, () => {
            const tool = tools.find(t => t.name === name);
            expect(tool, `${name} is declared in RESPONSE_CONTRACTS but is not advertised`).toBeDefined();
            for (const field of contract.fields) {
                // Match the BACKTICKED token, not the bare substring: a plain
                // `toContain("multi_turn")` also matches the refusal reason
                // `multi_turn_not_in_plan`, so deleting the real promise from
                // the description still passed. Found by mutation, not review.
                expect(
                    tool!.description ?? "",
                    `${name} declares \`${field}\` but its description no longer names it`,
                ).toContain(`\`${field}\``);
            }
        });
    }
});
