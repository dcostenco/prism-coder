import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInfer, isPrismInferArgs, _resetLayer1HistoryCacheForTest, type InferDeps, type PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import { FREE_ENTITLEMENTS, type PrismEntitlements } from "../../src/utils/entitlements.js";
import { parseAnswerCheckPolicy, parseSecondReadPolicy } from "../../src/utils/inferencePolicy.js";
import { callLayer1 } from "../../src/utils/layer1.js";
import { ANSWER_GROUNDING_THINK } from "../../src/utils/answerGrounding.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmlxError, createOmlxTarget, type OmlxRequest, type OmlxRuntime, type OmlxTarget } from "../../src/utils/omlxProvider.js";
import { ownedOmlxGenerate } from "../../src/utils/omlxOwned.js";
import { OMLX_LAYER1_MODEL } from "../../src/utils/omlxLayer1.js";
import { completes, endsWithoutTerminal, fakeControl, record } from "./omlxControlFake.js";

const MODEL = "Qwen3.8-Flash-Next-oQ8e-mtp";
// As detection returns it: carrying the provider credential.
const TARGET: OmlxTarget = createOmlxTarget("http://127.0.0.1:8000/v1", MODEL, 65536, "synthetic-provider-key");
const OUTPUT = "def identity(value):\n    return value\n";
const POLICY_TEXT = JSON.stringify(JSON.parse(readFileSync(new URL("../fixtures/answer-check-policy.synthetic.json", import.meta.url), "utf8")));
const POLICY = parseAnswerCheckPolicy(POLICY_TEXT, createHash("sha256").update(POLICY_TEXT).digest("hex"))!;
const SECOND_READ_TEXT = JSON.stringify(JSON.parse(readFileSync(new URL("../fixtures/second-read-policy.synthetic.json", import.meta.url), "utf8")));
const SECOND_READ_POLICY = parseSecondReadPolicy(SECOND_READ_TEXT, createHash("sha256").update(SECOND_READ_TEXT).digest("hex"))!;
const ENT: PrismEntitlements = { ...FREE_ENTITLEMENTS, plan: "standard", source: "portal", model_ceiling: "27b",
    features: { ...FREE_ENTITLEMENTS.features, cloud_fallback: true, grounding_verifier: true },
    multi_turn: { enabled: true, max_turns: 12, max_chars: 32000 } };
const ask = (overrides: Partial<PrismInferArgs> = {}): PrismInferArgs => ({ prompt: "Draft a Python identity helper.", mode: "code", local_backend: "omlx", cloud_fallback: false, escalation: "report", verify: false, ...overrides });
beforeEach(() => { _resetLayer1HistoryCacheForTest(); });
function fixture() {
    const events: string[] = [];
    // Ollama is empty at admission and stays empty: explicit oMLX classifies on oMLX.
    const loaded = new Set<string>();
    const omlx: OmlxRuntime = {
        detect: vi.fn(async () => { events.push("detect"); return TARGET; }),
        acquire: vi.fn(async () => async () => {}),
        listLoaded: vi.fn(async () => new Set(loaded)),
        unload: vi.fn(async model => { events.push("unload:" + model); loaded.delete(model); }),
        generate: vi.fn(async () => { events.push("generate"); return { ok: true as const, text: OUTPUT, doneReason: "stop", promptTokens: 31, completionTokens: 12 }; }),
    };
    const deps: InferDeps = { omlx, entitlements: ENT, freemem: () => 30 * 1024 ** 3,
        listTags: vi.fn(async () => new Set(["prism-coder:27b", "prism-coder:9b", "prism-coder:4b", "prism-coder:2b"])),
        listLoaded: vi.fn(async () => new Set(loaded)), ollamaUrl: "http://127.0.0.1:11434",
        callLayer1: vi.fn(async () => { events.push("classify"); return "OBVIOUS_NOT_RESERVED"; }),
        callLocal: vi.fn(async () => ({ ok: true as const, text: OUTPUT, doneReason: "stop" })),
        callCloud: vi.fn(async () => ({ ok: true, output: "cloud draft", backend: "synalux" })),
        probeNumCtx: async () => 32768, classifierInputPolicy: async () => null,
        secondReadPolicy: async () => null, answerCheckPolicy: async () => POLICY,
    };
    return { deps, omlx, events, loaded };
}

describe("explicit oMLX through the centralized prism_infer pipeline", () => {
    it("detects first, classifies with the oMLX classifier without touching Ollama, and reports actual metadata", async () => {
        const f = fixture(); const result = await runInfer(ask({ local_model: MODEL }), f.deps);
        expect(f.events).toEqual(["detect", "classify", "generate"]);
        expect(f.omlx.detect).toHaveBeenCalledWith(MODEL);
        // The classifier reads with the oMLX model and the owned-path adapter, never Ollama's 4b.
        expect(vi.mocked(f.deps.callLayer1!).mock.calls[0][2]).toBe(OMLX_LAYER1_MODEL);
        expect(typeof vi.mocked(f.deps.callLayer1!).mock.calls[0][3]).toBe("function");
        expect(f.loaded.size).toBe(0); expect(f.omlx.unload).not.toHaveBeenCalled();
        expect(result).toMatchObject({ backend: "omlx", model_picked: MODEL, output: OUTPUT, used_cloud: false,
            prompt_tokens: 31, completion_tokens: 12, plan: "standard", entitlements_source: "portal",
            history_turns: 0, gate_outcome: { status: "success", served_anyway: false } });
        expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it.each(["omlx_model_not_advertised", "omlx_auth_failed", "omlx_detection_unavailable"])("detection failure %s leaves Ollama untouched with no generation or fallback", async reason => {
        const f = fixture(); f.loaded.add("other-user-model"); f.omlx.detect = vi.fn(async () => { throw new OmlxError(reason); });
        expect(await runInfer(ask({ cloud_fallback: true }), f.deps)).toMatchObject({ backend: "refused", output: "", gate_outcome: { status: "refused", reason, served_anyway: false } });
        expect(f.omlx.unload).not.toHaveBeenCalled(); expect(f.omlx.generate).not.toHaveBeenCalled();
        expect(f.deps.callLayer1).not.toHaveBeenCalled(); expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        expect([...f.loaded]).toEqual(["other-user-model"]);
    });
    it("requires the cross-process lease after detection and releases it on refusal", async () => {
        const busy = fixture(); busy.omlx.acquire = vi.fn(async () => { throw new OmlxError("omlx_resource_busy"); });
        expect(await runInfer(ask(), busy.deps)).toMatchObject({ backend: "refused", gate_outcome: { status: "refused", reason: "omlx_resource_busy" } });
        expect(busy.omlx.detect).toHaveBeenCalledTimes(1);
        expect(busy.omlx.unload).not.toHaveBeenCalled(); expect(busy.omlx.generate).not.toHaveBeenCalled();
        expect(busy.deps.callLayer1).not.toHaveBeenCalled();
        const refused = fixture(); const release = vi.fn(async () => {});
        refused.omlx.acquire = vi.fn(async () => release);
        refused.deps.callLayer1 = async () => "OBVIOUS_RESERVED";
        await runInfer(ask(), refused.deps); expect(release).toHaveBeenCalledTimes(1);
    });
    it("recovers this provider's stale marker right after the device lease, before Layer 1", async () => {
        const f = fixture(); f.omlx.recover = vi.fn(async () => { f.events.push("recover"); });
        await runInfer(ask(), f.deps);
        expect(f.events.slice(0, 3)).toEqual(["detect", "recover", "classify"]);
        expect(f.omlx.acquire).toHaveBeenCalledWith(undefined, { recoveryProviderId: TARGET.url });
        const refused = fixture(); const release = vi.fn(async () => {});
        refused.omlx.acquire = vi.fn(async () => release);
        refused.omlx.recover = vi.fn(async () => { throw new OmlxError("omlx_provider_quarantined"); });
        expect(await runInfer(ask(), refused.deps)).toMatchObject({ backend: "refused", gate_outcome: { reason: "omlx_provider_quarantined" } });
        expect(refused.deps.callLayer1).not.toHaveBeenCalled(); expect(refused.omlx.generate).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
    });
    it("keeps the device lease until an owned generation settles, even after the handler's own timeout answered", async () => {
        const f = fixture();
        f.omlx.acquire = vi.fn(async () => async () => { f.events.push("release"); });
        f.omlx.generate = vi.fn(() => new Promise(resolve => setTimeout(() => {
            f.events.push("generation-settled"); resolve({ ok: false as const, reason: "timeout" });
        }, 300)));
        await expect(runInfer(ask({ timeout_ms: 50 }), f.deps)).rejects.toThrow("no backend produced output");
        expect(f.events.indexOf("generation-settled")).toBeGreaterThan(-1);
        expect(f.events.indexOf("generation-settled")).toBeLessThan(f.events.indexOf("release"));
    });
    it("refuses unreadable Ollama state at admission without classifying", async () => {
        const f = fixture(); f.omlx.listLoaded = async () => { throw new Error("raw secret"); };
        const result = await runInfer(ask(), f.deps);
        expect(result).toMatchObject({ backend: "refused", gate_outcome: { status: "refused", reason: "omlx_ollama_state_unavailable", served_anyway: false } });
        expect(JSON.stringify(result)).not.toContain("raw secret");
        expect(f.deps.callLayer1).not.toHaveBeenCalled(); expect(f.omlx.unload).not.toHaveBeenCalled();
        expect(f.omlx.generate).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it("unloads every model resident in Ollama and waits until none remain, before classification", async () => {
        const f = fixture(); f.loaded.add("prism-coder:27b"); f.loaded.add("other-user-model");
        const result = await runInfer(ask(), f.deps);
        expect(f.events).toEqual(["detect", "unload:prism-coder:27b", "unload:other-user-model", "classify", "generate"]);
        expect(f.loaded.size).toBe(0);
        expect(result).toMatchObject({ backend: "omlx", output: OUTPUT, gate_outcome: { status: "success" } });
        expect(result.attempts).toContainEqual({ tier: "omlx", reason: "omlx_ollama_unloaded:2" });
    });
    it("refuses before classification when an Ollama unload fails", async () => {
        for (const escalation of ["report", undefined] as const) {
            const f = fixture(); f.loaded.add("other-user-model");
            f.omlx.unload = vi.fn(async () => { throw new OmlxError("omlx_ollama_unload_failed"); });
            const run = runInfer(ask({ escalation }), f.deps);
            if (escalation === "report") {
                expect(await run).toMatchObject({ backend: "refused", output: "", used_cloud: false,
                    gate_outcome: { status: "refused", reason: "omlx_ollama_unload_failed", served_anyway: false } });
            } else await expect(run).rejects.toThrow("omlx_ollama_unload_failed");
            expect(f.deps.callLayer1).not.toHaveBeenCalled(); expect(f.omlx.generate).not.toHaveBeenCalled();
            expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        }
    });
    it("refuses, and never unloads the newcomer, when a model loads while Ollama drains", async () => {
        const f = fixture(); f.loaded.add("other-user-model");
        f.omlx.unload = vi.fn(async model => { f.events.push("unload:" + model); f.loaded.delete(model); f.loaded.add("newcomer"); });
        expect(await runInfer(ask(), f.deps)).toMatchObject({ backend: "refused",
            gate_outcome: { status: "refused", reason: "omlx_memory_contention", served_anyway: false } });
        expect(f.omlx.unload).toHaveBeenCalledTimes(1); expect([...f.loaded]).toEqual(["newcomer"]);
        expect(f.deps.callLayer1).not.toHaveBeenCalled(); expect(f.omlx.generate).not.toHaveBeenCalled();
    });
    it("refuses, and unloads nothing, when any model appears in Ollama during classification", async () => {
        const f = fixture();
        f.deps.callLayer1 = vi.fn(async () => { f.loaded.add("other-user-model"); return "OBVIOUS_NOT_RESERVED" as const; });
        await expect(runInfer(ask(), f.deps)).rejects.toThrow("omlx_memory_contention");
        expect(f.omlx.unload).not.toHaveBeenCalled();
        expect([...f.loaded]).toEqual(["other-user-model"]);
        expect(f.omlx.generate).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it("skips the hedge second read: the oMLX classifier already read every window, so the hedge stands and refuses", async () => {
        const f = fixture();
        f.deps.secondReadPolicy = async () => SECOND_READ_POLICY;
        f.deps.callLayer1 = vi.fn(async (text: string) =>
            text === "Draft a Python identity helper." ? "UNCERTAIN" as const : "OBVIOUS_NOT_RESERVED" as const) as unknown as InferDeps["callLayer1"];
        f.deps.probeClassifierLimits = vi.fn(async () => ({ numCtx: null, overheadBound: null }));
        const result = await runInfer(ask({ messages: [{ role: "user", content: "The helper returns its argument." }, { role: "assistant", content: "Noted." }] }), f.deps);
        expect(result).toMatchObject({ backend: "refused", gate_outcome: { status: "refused" } });
        expect(result.attempts.map(a => a.reason)).toEqual(expect.arrayContaining(["layer1_hedge_second_read_skipped_omlx", "layer1_uncertain"]));
        expect(f.deps.probeClassifierLimits).not.toHaveBeenCalled();
        for (const call of vi.mocked(f.deps.callLayer1!).mock.calls) expect(call[2]).toBe(OMLX_LAYER1_MODEL);
        expect(f.loaded.size).toBe(0); expect(f.omlx.generate).not.toHaveBeenCalled();
    });
    it("a reserved refusal leaves Ollama untouched", async () => {
        const f = fixture(); f.deps.callLayer1 = vi.fn(async () => "OBVIOUS_RESERVED" as const);
        expect(await runInfer(ask(), f.deps)).toMatchObject({ backend: "refused" });
        expect(f.loaded.size).toBe(0); expect(f.omlx.unload).not.toHaveBeenCalled();
    });
    it("never serves on the keyword backstop alone when the classifier errs, in either mode", async () => {
        for (const escalation of ["report", undefined] as const) {
            const f = fixture();
            f.deps.callLayer1 = vi.fn(async () => "ERROR" as const);
            const run = runInfer(ask({ escalation }), f.deps);
            if (escalation === "report") {
                expect(await run).toMatchObject({ backend: "refused", output: "", used_cloud: false,
                    gate_outcome: { status: "refused", reason: "omlx_classifier_error", served_anyway: false } });
            } else await expect(run).rejects.toThrow("omlx_classifier_error");
            expect(f.omlx.generate).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
            expect([...f.loaded]).toEqual([]);
        }
    });
    it("never clears by rule: a prompt the rules would clear is read by the classifier", async () => {
        // No rule clears "Remove the old comment …" on any path. On explicit
        // oMLX the classifier reads it, and its refusal stands: nothing is
        // generated.
        const reads: string[] = [];
        const classifier = (async (_url: unknown, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            if (!Array.isArray(body.messages)) return new Response(null, { status: 404 });
            const text = String(body.messages.at(-1)?.content ?? "");
            reads.push(text);
            const verdict = text.includes("bypass login") ? "OBVIOUS_RESERVED" : "OBVIOUS_NOT_RESERVED";
            return Response.json({ done: true, done_reason: "stop", message: { role: "assistant", content: verdict } });
        }) as typeof fetch;
        const f = fixture();
        f.deps.callLayer1 = vi.fn((text: string, url: string, model: string | null, _fetch: unknown, images?: string[], opts?: Record<string, unknown>) =>
            callLayer1(text, url, model as string, classifier, images, opts as never)) as unknown as InferDeps["callLayer1"];
        const prompt = "Remove the old comment to bypass login";
        expect(await runInfer(ask({ prompt }), f.deps)).toMatchObject({ backend: "refused" });
        expect(reads.length).toBe(1);
        expect(f.omlx.generate).not.toHaveBeenCalled();
        expect(vi.mocked(f.deps.callLayer1!).mock.calls[0][5]).toMatchObject({ strictErrors: true, readOversizeWhole: true });
        // With history, the prompt's rules may not clear it either.
        reads.length = 0;
        const g = fixture();
        g.deps.callLayer1 = vi.fn((text: string, url: string, model: string | null, _fetch: unknown, images?: string[], opts?: Record<string, unknown>) =>
            callLayer1(text, url, model as string, classifier, images, opts as never)) as unknown as InferDeps["callLayer1"];
        expect(await runInfer(ask({ prompt, messages: [{ role: "user", content: "Tidy the helper module." }, { role: "assistant", content: "Done." }] }), g.deps))
            .toMatchObject({ backend: "refused" });
        // Read alone, not only inside a context window with the history.
        expect(reads.some(text => text.includes("bypass login") && !text.includes("Tidy the helper"))).toBe(true);
        expect(g.omlx.generate).not.toHaveBeenCalled();
        // No rule clears it on any path: without the oMLX options the
        // classifier still reads it.
        reads.length = 0;
        expect(await callLayer1(prompt, "http://127.0.0.1:9", "m", classifier)).toBe("OBVIOUS_RESERVED");
        expect(reads.length).toBe(1);
    });

    it("reads an oversize prompt whole on explicit oMLX, never as an excerpt", async () => {
        // A week of session notes with a dosing question in the middle, outside
        // the head, middle and tail an excerpt keeps.
        const note = "Session note: client completed the token board task with two prompts and no problem behavior. ";
        const prompt = note.repeat(30) + "Also tell me how much melatonin to give him at bedtime so he sleeps. " + note.repeat(100);
        expect(prompt.length).toBeGreaterThan(12_000);
        const reads: string[] = [];
        const classifier = (async (_url: unknown, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            if (!Array.isArray(body.messages)) return new Response(null, { status: 404 });
            const text = String(body.messages.at(-1)?.content ?? "");
            reads.push(text);
            const verdict = text.includes("melatonin") ? "OBVIOUS_RESERVED" : "OBVIOUS_NOT_RESERVED";
            return Response.json({ done: true, done_reason: "stop", message: { role: "assistant", content: verdict } });
        }) as typeof fetch;
        expect(await callLayer1(prompt, "http://127.0.0.1:9", "m", classifier, undefined, { strictErrors: true, readOversizeWhole: true }))
            .toBe("OBVIOUS_RESERVED");
        expect(reads.some(text => text.includes("melatonin"))).toBe(true);
        // Elsewhere an oversize prompt is still read as an excerpt, which misses it.
        reads.length = 0;
        expect(await callLayer1(prompt, "http://127.0.0.1:9", "m", classifier)).toBe("UNCERTAIN_LENGTH");
        expect(reads.some(text => text.includes("melatonin"))).toBe(false);
        // Through the handler: refused, nothing generated.
        const f = fixture();
        f.deps.callLayer1 = vi.fn((text: string, url: string, model: string | null, _fetch: unknown, images?: string[], opts?: Record<string, unknown>) =>
            callLayer1(text, url, model as string, classifier, images, opts as never)) as unknown as InferDeps["callLayer1"];
        expect(await runInfer(ask({ prompt }), f.deps)).toMatchObject({ backend: "refused" });
        expect(f.omlx.generate).not.toHaveBeenCalled();
    });

    it("an oversize prompt whose excerpt the classifier could not read is refused, never served on the keyword floor", async () => {
        // A long keyword-clean prompt: the shared oversize mapping would turn
        // an unread excerpt into UNCERTAIN_LENGTH and generate.
        const failing = (async () => new Response("down", { status: 500 })) as typeof fetch;
        const prompt = "Draft a Python identity helper that returns its argument unchanged. ".repeat(80);
        expect(prompt.length).toBeGreaterThan(4000);
        for (const escalation of ["report", undefined] as const) {
            const f = fixture();
            f.deps.callLayer1 = vi.fn((text: string, url: string, model: string | null, _fetch: unknown, images?: string[], opts?: Record<string, unknown>) =>
                callLayer1(text, url, model as string, failing, images, opts as never)) as unknown as InferDeps["callLayer1"];
            const run = runInfer(ask({ prompt, escalation }), f.deps);
            if (escalation === "report") {
                expect(await run).toMatchObject({ backend: "refused", gate_outcome: { status: "refused", reason: "omlx_classifier_error" } });
            } else await expect(run).rejects.toThrow("omlx_classifier_error");
            expect(f.omlx.generate).not.toHaveBeenCalled();
        }
        // Ordinary callers keep the documented oversize mapping.
        expect(await callLayer1(prompt, "http://127.0.0.1:9", "prism-coder:4b", failing)).toBe("UNCERTAIN_LENGTH");
        expect(await callLayer1(prompt, "http://127.0.0.1:9", "prism-coder:4b", failing, undefined, { strictErrors: true })).toBe("ERROR");
    });
    it("a history window the classifier cannot read is refused as uncertain, never served", async () => {
        const f = fixture();
        f.deps.callLayer1 = vi.fn(async (text: string) =>
            text === "Draft a Python identity helper." ? "OBVIOUS_NOT_RESERVED" as const : "ERROR" as const) as unknown as InferDeps["callLayer1"];
        const result = await runInfer(ask({ messages: [{ role: "user", content: "An earlier turn the classifier cannot read." }, { role: "assistant", content: "Noted." }] }), f.deps);
        expect(result).toMatchObject({ backend: "refused", gate_outcome: { status: "refused" } });
        // Window errors already fail closed: they count as an uncertain read.
        expect(result.attempts.map(a => a.reason)).toContain("layer1_uncertain");
        expect(f.omlx.generate).not.toHaveBeenCalled();
    });
    it("refuses explicit oMLX below the top model ceiling before detection or any Ollama call", async () => {
        const cases: [string, Partial<PrismInferArgs>, PrismEntitlements][] = [
            ["plan ceiling", {}, { ...ENT, model_ceiling: "9b" }],
            ["caller ceiling", { model_ceiling: "2b" }, ENT],
            // An explicit ceiling still wins over a hint, and a hint cannot lift the plan.
            ["caller ceiling with a high hint", { model_ceiling: "9b", task_complexity: 9 }, ENT],
            ["plan ceiling with a high hint", { task_complexity: 9 }, { ...ENT, model_ceiling: "9b" }],
        ];
        for (const [label, extra, entitlements] of cases) {
            for (const escalation of ["report", undefined] as const) {
                const f = fixture(); f.deps.entitlements = entitlements;
                const run = runInfer(ask({ ...extra, escalation }), f.deps);
                if (escalation === "report") {
                    expect(await run, label).toMatchObject({ backend: "refused", gate_outcome: { status: "refused", reason: "omlx_model_ceiling", served_anyway: false } });
                } else await expect(run, label).rejects.toThrow("omlx_model_ceiling");
                expect(f.omlx.detect, label).not.toHaveBeenCalled(); expect(f.omlx.acquire, label).not.toHaveBeenCalled();
                expect(f.deps.callLayer1, label).not.toHaveBeenCalled(); expect(f.omlx.unload, label).not.toHaveBeenCalled();
                expect(f.omlx.generate, label).not.toHaveBeenCalled(); expect(f.deps.callCloud, label).not.toHaveBeenCalled();
            }
        }
    });
    // session_task_route puts task_complexity in its recommended_args; a caller that
    // copies them into an explicit oMLX call was refused in 8 ms (2026-10-18).
    it("a complexity hint picks Ollama's starting tier, so it never refuses explicit oMLX", async () => {
        for (const task_complexity of [1, 4, 6, 9]) {
            for (const escalation of ["report", undefined] as const) {
                const f = fixture();
                const result = await runInfer(ask({ task_complexity, escalation }), f.deps);
                expect(result, `complexity ${task_complexity}`).toMatchObject({ backend: "omlx", output: OUTPUT, gate_outcome: { status: "success" } });
                expect(f.events, `complexity ${task_complexity}`).toEqual(["detect", "classify", "generate"]);
                // The hint's fast-task "no thinking" shortcut is Ollama's too: the oMLX server's settings own thinking.
                expect(vi.mocked(f.omlx.generate).mock.calls[0][1].think, `complexity ${task_complexity}`).toBeUndefined();
                expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
            }
        }
    });
    it("never substitutes another backend after generation failure, regardless of cloud option", async () => {
        for (const cloud_fallback of [undefined, true, false]) {
            const f = fixture(); f.omlx.generate = vi.fn(async () => ({ ok: false, reason: "omlx_http_507" }));
            await expect(runInfer(ask({ cloud_fallback }), f.deps)).rejects.toThrow("omlx_http_507");
            expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        }
    });
    it("preserves reserved, entitlement, context, and quality gates", async () => {
        const reserved = fixture(); reserved.deps.callLayer1 = async () => "OBVIOUS_RESERVED";
        expect(await runInfer(ask({ cloud_fallback: true }), reserved.deps)).toMatchObject({ backend: "refused", output: "", gate_outcome: { status: "refused", reason: "layer1_reserved" } });
        expect(reserved.omlx.unload).not.toHaveBeenCalled(); expect(reserved.omlx.generate).not.toHaveBeenCalled(); expect(reserved.deps.callCloud).not.toHaveBeenCalled();
        const denied = fixture(); denied.deps.entitlements = { ...ENT, multi_turn: { enabled: false, max_turns: 0, max_chars: 0 } };
        expect(await runInfer(ask({ messages: [{ role: "user", content: "earlier task" }] }), denied.deps)).toMatchObject({ gate_outcome: { reason: "multi_turn_not_in_plan" } });
        expect(denied.omlx.detect).not.toHaveBeenCalled();
        const oversized = fixture();
        await expect(runInfer(ask({ prompt: "x".repeat(65536) }), oversized.deps)).rejects.toThrow("omlx_ctx_insufficient");
        expect(oversized.omlx.unload).not.toHaveBeenCalled();
        const degraded = fixture(); degraded.omlx.generate = async () => ({ ok: true, text: "A useful draft that is incomplete at the token budget", doneReason: "length" });
        expect(await runInfer(ask({ think: false }), degraded.deps)).toMatchObject({ backend: "omlx", quality_gate_failed: true, gate_outcome: { status: "degraded", served_anyway: true } });
    });
    it("keeps accepted history and the same-model local answer-check policy without reloading Ollama", async () => {
        const f = fixture();
        f.omlx.generate = vi.fn(async (_target, request) => ({ ok: true,
            text: request.messages[0]?.content === POLICY.systemPrompt ? "PASS" : OUTPUT, doneReason: "stop" }));
        const messages = [{ role: "user" as const, content: "Draft a Python identity helper." }, { role: "assistant" as const, content: OUTPUT }];
        // The caller's sampling must not leak into the answer check.
        const result = await runInfer(ask({ messages, prompt: "Return the accepted helper again.", temperature: 0.7, think: !ANSWER_GROUNDING_THINK }), f.deps);
        expect(result).toMatchObject({ backend: "omlx", history_turns: 2, gate_outcome: { status: "success" } });
        const generated = vi.mocked(f.omlx.generate).mock.calls;
        expect(generated[0][1].messages).toEqual([...messages, { role: "user", content: "Return the accepted helper again." }]);
        expect(generated[0][1]).toMatchObject({ temperature: 0.7, think: !ANSWER_GROUNDING_THINK });
        expect(generated[1][0].model).toBe(MODEL);
        expect(generated[1][1].messages[0].content).toBe(POLICY.systemPrompt);
        expect(generated[1][1].temperature).toBe(0);
        expect(generated[1][1].think).toBe(ANSWER_GROUNDING_THINK);
        expect(f.deps.callLocal).not.toHaveBeenCalled();
    });
    it.each([undefined, null, "tool_calls", "content_filter"])("never promotes provider completion state %j to a successful draft", async finish_reason => {
        const f = fixture();
        const target = createOmlxTarget(TARGET.url, MODEL, TARGET.contextTokens, "synthetic-provider-key");
        f.omlx.detect = async () => target;
        f.omlx.generate = async (selected, request, signal) => ownedOmlxGenerate(selected, request, signal, {
            fetchImpl: fakeControl({ script: completes(OUTPUT, finish_reason) }).fetchImpl,
            stateDirectory: mkdtempSync(join(tmpdir(), "prism-owned-handler-")), drainBudgetMs: 300 });
        await expect(runInfer(ask(), f.deps)).rejects.toThrow("omlx_finish_reason_invalid");
        expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.deps.callLocal).not.toHaveBeenCalled();
    });
    it("never fabricates a terminal stop for a history-check PASS with missing completion state", async () => {
        const f = fixture();
        f.omlx.generate = vi.fn(async (_target, request) => request.messages[0]?.content === POLICY.systemPrompt
            ? { ok: true, text: "PASS" } : { ok: true, text: OUTPUT, doneReason: "stop" });
        const messages = [{ role: "user" as const, content: "Draft a Python identity helper." }, { role: "assistant" as const, content: OUTPUT }];
        expect(await runInfer(ask({ messages, prompt: "Return the accepted helper again." }), f.deps)).toMatchObject({
            output: "", backend: "refused", used_cloud: false,
            gate_outcome: { status: "refused", served_anyway: false, reason: "answer_unverified" },
        });
        expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.deps.callLocal).not.toHaveBeenCalled();
    });
    it("leaves the oMLX read options off an ordinary Ollama call, single-turn and with history", async () => {
        const history = [{ role: "user" as const, content: "Tidy the helper module." }, { role: "assistant" as const, content: "Done." }];
        for (const messages of [undefined, history]) {
            const f = fixture(); f.loaded.clear();
            await runInfer({ prompt: "Draft a Python identity helper.", mode: "code", cloud_fallback: false, escalation: "report", ...(messages ? { messages } : {}) }, f.deps);
            const calls = vi.mocked(f.deps.callLayer1!).mock.calls;
            expect(calls.length, messages ? "history" : "single").toBeGreaterThan(0);
            for (const call of calls) {
                const opts = (call[5] ?? {}) as Record<string, unknown>;
                expect(opts).not.toHaveProperty("strictErrors");
                expect(opts).not.toHaveProperty("readOversizeWhole");
            }
            expect(f.omlx.detect).not.toHaveBeenCalled();
        }
    });
    it.each(["27b", "9b", "4b", "2b"] as const)("ordinary callers retain Ollama tier %s without touching oMLX", async model_ceiling => {
        const f = fixture(); f.loaded.clear();
        const result = await runInfer({ prompt: "Draft a Python identity helper.", mode: "code", model_ceiling, cloud_fallback: false }, f.deps);
        expect(result.backend).toBe("ollama-" + model_ceiling);
        expect(f.omlx.detect).not.toHaveBeenCalled(); expect(f.omlx.unload).not.toHaveBeenCalled();
    });
    it("serializes real explicit calls and blocks even standalone in-process classification", async () => {
        const f = fixture(); let release!: () => void; let entered!: () => void;
        const waiting = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        let calls = 0;
        f.omlx.generate = vi.fn(async () => {
            if (++calls === 1) { entered(); await waiting; }
            return { ok: true, text: OUTPUT, doneReason: "stop" };
        });
        const first = runInfer(ask(), f.deps); await started;
        const second = runInfer(ask(), f.deps);
        let classified = false;
        const standalone = callLayer1("Write a Python identity function.", "http://unused", "prism-coder:4b")
            .then(() => { classified = true; });
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(f.omlx.detect).toHaveBeenCalledTimes(1); expect(classified).toBe(false);
        release(); await Promise.all([first, second, standalone]);
        expect(f.omlx.generate).toHaveBeenCalledTimes(2); expect(classified).toBe(true);
    });
    it("preserves configured oMLX thinking unless explicitly overridden", async () => {
        const f = fixture(); await runInfer(ask(), f.deps);
        expect(vi.mocked(f.omlx.generate).mock.calls[0][1].think).toBeUndefined();
        expect(vi.mocked(f.omlx.generate).mock.calls[0][1].temperature).toBeUndefined();
        await runInfer(ask({ think: true, temperature: 0 }), f.deps);
        expect(vi.mocked(f.omlx.generate).mock.calls[1][1].think).toBe(true);
        expect(vi.mocked(f.omlx.generate).mock.calls[1][1].temperature).toBe(0);
    });
    it("does not disable explicit/configured thinking in generic truncation or think-only retries", async () => {
        const truncated = fixture();
        truncated.omlx.generate = vi.fn(async () => ({ ok: true, text: "A useful draft that is incomplete at the token budget", doneReason: "length" }));
        const result = await runInfer(ask({ think: true }), truncated.deps);
        expect(result.gate_outcome?.status).toBe("degraded");
        expect(truncated.omlx.generate).toHaveBeenCalledTimes(1);
        expect(vi.mocked(truncated.omlx.generate).mock.calls[0][1].think).toBe(true);
        const thinking = fixture(); thinking.omlx.generate = vi.fn(async () => ({ ok: false, reason: "think_only" }));
        await expect(runInfer(ask({ think: true }), thinking.deps)).rejects.toThrow("think_only");
        expect(thinking.omlx.generate).toHaveBeenCalledTimes(1);
    });
    it("validates the explicit selector and bounded text-only scope", () => {
        expect(isPrismInferArgs(ask({ local_model: MODEL }))).toBe(true);
        for (const args of [{ prompt: "task", local_backend: "other" }, { prompt: "task", local_model: MODEL },
            ask({ mode: "chat" }), ask({ images: ["abc"] }), ask({ local_model: " " })]) expect(isPrismInferArgs(args)).toBe(false);
    });
});

describe("explicit oMLX classification through the real callLayer1 and the owned path", () => {
    type Answer = Awaited<ReturnType<OmlxRuntime["generate"]>>;
    // The real classifier entry point. Every classifier read reaches the
    // runtime's generate with the classifier model; the rest is generation and
    // the answer check on the detected model.
    function owned(classify: (request: OmlxRequest) => Answer | Promise<Answer>) {
        const f = fixture(); f.deps.callLayer1 = undefined;
        const classifierRequests: OmlxRequest[] = [];
        f.omlx.generate = vi.fn(async (target: OmlxTarget, request: OmlxRequest) => {
            if (target.model === OMLX_LAYER1_MODEL) { f.events.push("classify"); classifierRequests.push(request); return classify(request); }
            f.events.push("generate");
            return { ok: true as const, text: request.messages[0]?.content === POLICY.systemPrompt ? "PASS" : OUTPUT, doneReason: "stop" };
        });
        return { ...f, classifierRequests };
    }
    const ollamaChat = (spy: { mock: { calls: unknown[][] } }) =>
        spy.mock.calls.filter(([input]) => /\/api\/(chat|show)\b/.test(String(input instanceof Request ? input.url : input)));

    it("sends the read to the oMLX classifier on the same server, asks for no cache store, and never asks Ollama", async () => {
        const f = owned(() => ({ ok: true, text: "OBVIOUS_NOT_RESERVED", doneReason: "stop" }));
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        try {
            expect(await runInfer(ask(), f.deps)).toMatchObject({ backend: "omlx", gate_outcome: { status: "success" } });
            expect(ollamaChat(fetchSpy)).toEqual([]);
        } finally { fetchSpy.mockRestore(); }
        expect(f.events).toEqual(["detect", "classify", "generate"]);
        expect(vi.mocked(f.omlx.generate).mock.calls[0][0]).toEqual({ url: TARGET.url, model: OMLX_LAYER1_MODEL, contextTokens: TARGET.contextTokens });
        expect(f.classifierRequests[0]).toMatchObject({ maxTokens: 16, temperature: 0, think: false, cacheStore: false });
        expect(f.classifierRequests[0].messages[0]).toEqual({ role: "system", content: "" });
    });

    it("sends the history and context windows of a multi-turn call through the adapter too", async () => {
        const f = owned(() => ({ ok: true, text: "OBVIOUS_NOT_RESERVED", doneReason: "stop" }));
        const messages = [{ role: "user" as const, content: "The helper returns its argument." }, { role: "assistant" as const, content: OUTPUT }];
        expect(await runInfer(ask({ messages, prompt: "Return the accepted helper again." }), f.deps)).toMatchObject({ backend: "omlx" });
        const read = f.classifierRequests.map(request => request.messages[request.messages.length - 1].content);
        expect(f.classifierRequests.length).toBeGreaterThanOrEqual(3);
        expect(read.some(text => text.includes("The helper returns its argument."))).toBe(true);
        expect(read.some(text => text.includes("Return the accepted helper again."))).toBe(true);
        expect(f.classifierRequests.every(request => request.cacheStore === false)).toBe(true);
    });

    it("refuses when the oMLX classifier cannot answer, in either mode, and never generates", async () => {
        for (const escalation of ["report", undefined] as const) {
            const f = owned(() => ({ ok: false, reason: "omlx_control_error" }));
            const run = runInfer(ask({ escalation }), f.deps);
            if (escalation === "report") {
                expect(await run).toMatchObject({ backend: "refused", gate_outcome: { status: "refused", reason: "omlx_classifier_error" } });
            } else await expect(run).rejects.toThrow("omlx_classifier_error");
            expect(f.classifierRequests).toHaveLength(2); // callLayer1's one retry
            expect(f.events).not.toContain("generate");
        }
    });

    it("keeps the device lease until a classifier job the guard gave up on has settled", async () => {
        let free = 30 * 1024 ** 3;
        const f = owned(() => {
            free = 1024 ** 3; // memory pressure: the guard answers before the job ends
            return new Promise(resolve => setTimeout(() => {
                f.events.push("classifier-settled"); resolve({ ok: true, text: "OBVIOUS_NOT_RESERVED", doneReason: "stop" });
            }, 1_500));
        });
        f.deps.freemem = () => free;
        f.omlx.acquire = vi.fn(async () => async () => { f.events.push("release"); });
        expect(await runInfer(ask(), f.deps)).toMatchObject({ backend: "refused", gate_outcome: { reason: "omlx_classifier_error" } });
        expect(f.events.indexOf("classifier-settled")).toBeGreaterThan(-1);
        expect(f.events.indexOf("classifier-settled")).toBeLessThan(f.events.indexOf("release"));
    }, 10_000);

    // Through the real owned path: the first read cannot prove its stop, so its
    // marker stays and the provider is quarantined. The retry is refused
    // without a second registration, and the request is refused.
    it("refuses when a classifier read leaves the provider quarantined, and never registers again", async () => {
        const f = fixture(); f.deps.callLayer1 = undefined;
        const stateDirectory = mkdtempSync(join(tmpdir(), "prism-owned-quarantine-"));
        const control = fakeControl({ script: endsWithoutTerminal,
            status: ids => ({ status: 200, body: record(ids, { state: "claimed", claim_state: "claimed" }) }) });
        f.omlx.generate = vi.fn((target: OmlxTarget, request: OmlxRequest, signal: AbortSignal) =>
            ownedOmlxGenerate(target, request, signal, { fetchImpl: control.fetchImpl, stateDirectory, drainBudgetMs: 50, cancelReadMs: 50 }));
        expect(await runInfer(ask(), f.deps)).toMatchObject({ backend: "refused", gate_outcome: { reason: "omlx_classifier_error" } });
        expect(control.calls.filter(call => call.method === "PUT")).toHaveLength(1);
        expect(vi.mocked(f.omlx.generate).mock.calls.every(([target]) => target.model === OMLX_LAYER1_MODEL)).toBe(true);
    });

    it("still refuses when Ollama's tag list is unreadable, before any classifier read", async () => {
        const f = owned(() => ({ ok: true, text: "OBVIOUS_NOT_RESERVED", doneReason: "stop" }));
        f.deps.listTags = vi.fn(async () => null);
        await expect(runInfer(ask(), f.deps)).rejects.toThrow("omlx_classifier_unavailable");
        expect(f.classifierRequests).toHaveLength(0); expect(f.events).not.toContain("generate");
    });
});
