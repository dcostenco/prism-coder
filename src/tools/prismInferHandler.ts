/**
 * prism_infer — local-first inference tool
 * ─────────────────────────────────────────────────────────────
 * Save the caller's cloud tokens by routing to a local prism-coder
 * model via Ollama. Tiers (27B/9B/4B/2B) auto-selected by free
 * RAM, then capped by `model_ceiling` and the set of tags that are
 * actually pulled into Ollama.
 *
 *   1. Probe Ollama, list tags
 *   2. Pick largest viable local tier (pickLocalModel)
 *   3. Call /api/generate locally — return on success
 *   4. On local fail, if cloud_fallback=true:
 *        - exchange synalux_sk_ → JWT (cached)
 *        - POST synalux portal /api/v1/prism-aac/inference
 *        - portal runs its own cascade (9B/27B/Claude by tier)
 *   5. Return { output, backend, model_picked, ram_free_mb, latency_ms, used_cloud }
 *
 * `prism_infer` is a thin client. It never calls Anthropic / OpenRouter
 * directly — all cloud traffic goes via the synalux portal so billing,
 * tier gating, and HIPAA audit are enforced in one place.
 */

import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import { pickLocalModel, fmtGb, MODEL_TIERS, resolveOllamaName } from "../utils/modelPicker.js";
import { getSynaluxJwt, invalidateSynaluxJwt } from "../utils/synaluxJwt.js";
import { getAvailableMemoryBytes } from "../utils/availableMemory.js";
import {
    PRISM_SYNALUX_BASE_URL,
    PRISM_LOCAL_LLM_URL,
    SYNALUX_CONFIGURED,
} from "../config.js";
import { debugLog } from "../utils/logger.js";
// Grounding verification is portal-side. Prism is a thin client.
type EvidenceSnippet = { source: string; content: string };
type GroundingOutcome = { action: string; finalText: string; claims: unknown[]; verifierChain: unknown[]; refusalClaim?: string };
import { getEntitlements, clampCeiling, type PrismEntitlements, FREE_ENTITLEMENTS } from "../utils/entitlements.js";
import { ddLog } from "../utils/ddLogger.js";
import { stripThink } from "../utils/thinkStrip.js";
import { passesQualityGate } from "../utils/qualityGate.js";
import { checkInputSafety, checkOutputSafety } from "../utils/safetyGate.js";
import { callLayer1 as defaultCallLayer1, type Layer1Verdict } from "../utils/layer1.js";
import { recordInference, formatInferenceMetrics } from "../utils/inferenceMetrics.js";

// ─── Tool Definition ────────────────────────────────────────────

export const PRISM_INFER_TOOL: Tool = {
    name: "prism_infer",
    description:
        "Run an inference on a local prism-coder model (Ollama) to save cloud tokens. " +
        "Picks the largest viable tier — 27B / 9B / 4B / 2B — based on free RAM at call time, " +
        "clamped by `model_ceiling` and what is actually pulled in Ollama. " +
        "Falls through to the synalux portal cloud cascade (9B → 27B → Claude Opus 4.7) " +
        "only when local is unviable AND `cloud_fallback=true`. " +
        "Use this for code generation, summarisation, classification, or any synth task you would " +
        "otherwise hand to the cloud model — it costs $0 when the local hit succeeds.",
    inputSchema: {
        type: "object",
        properties: {
            prompt: {
                type: "string",
                description: "The user prompt. Required.",
            },
            system: {
                type: "string",
                description: "Optional system instruction prepended to the prompt.",
            },
            max_tokens: {
                type: "number",
                description: "Max output tokens (default 1024, hard cap 8192).",
                default: 1024,
            },
            temperature: {
                type: "number",
                description: "Sampling temperature, 0 = deterministic (default 0).",
                default: 0,
            },
            model_ceiling: {
                type: "string",
                enum: ["27b", "9b", "4b", "2b"],
                description: "Cap the largest tier the picker may select. e.g. '9b' forbids 27B even if RAM allows.",
            },
            cloud_fallback: {
                type: "boolean",
                description: "If true, fall through to synalux portal cascade on local fail. Default false — token-saving mode is the point of this tool.",
                default: false,
            },
            timeout_ms: {
                type: "number",
                description: "Override per-call timeout. Default scales with model size: 27B=120s, 9B=60s, 4B=20s, 2B=15s.",
            },
            evidence: {
                type: "array",
                description:
                    "Optional evidence snippets the model output must be grounded in. " +
                    "When supplied with `verify: true`, every assertive claim in the draft " +
                    "(numbers, names, dates, codes, $ amounts) must be ENTAILED by one of " +
                    "these snippets or the draft is refused.",
                items: {
                    type: "object",
                    properties: {
                        source: { type: "string", description: "Label for the snippet (e.g. 'tool:knowledge_search#3')." },
                        content: { type: "string", description: "The evidence text itself." },
                    },
                    required: ["source", "content"],
                },
            },
            verify: {
                type: "boolean",
                description:
                    "Enable the L3 grounding verifier. Default: true when `evidence` is provided, " +
                    "false otherwise. When enabled, the model's draft is checked by a different model " +
                    "(qwen3.5:4b by default) against the supplied `evidence`. Drafts with " +
                    "NEUTRAL or CONTRADICTED claims are refused.",
            },
            verifier_model: {
                type: "string",
                description: "Override the verifier model. Default: qwen3.5:4b.",
            },
            verifier_timeout_ms: {
                type: "number",
                description: "Override the verifier hard timeout. Default 2000 ms.",
                default: 2000,
            },
            mode: {
                type: "string",
                enum: ["route", "chat", "code"],
                description:
                    "Execution mode. 'route' (default) for MCP tool routing — fast, nothink. " +
                    "'chat' for general conversation — uses thinking, escalates to cloud on failure. " +
                    "'code' for code generation — uses thinking, larger context. " +
                    "In chat/code modes, prefers the 27B tier and enables <think> reasoning.",
                default: "route",
            },
            think: {
                type: "boolean",
                description:
                    "Enable thinking mode (<think> blocks). Default: true for chat/code, false for route. " +
                    "Thinking improves quality on complex tasks but adds latency (~2-5s).",
            },
        },
        required: ["prompt"],
    },
};

// ─── Arg validation ────────────────────────────────────────────

export interface PrismInferArgs {
    prompt: string;
    system?: string;
    max_tokens?: number;
    temperature?: number;
    model_ceiling?: "27b" | "9b" | "4b" | "2b";
    cloud_fallback?: boolean;
    timeout_ms?: number;
    /** Evidence snippets the model is expected to be grounded in.
     *  When `verify: true`, every assertive claim in the draft must be
     *  ENTAILED by one of these snippets or the draft is refused. */
    evidence?: EvidenceSnippet[];
    /** Enable the L3 grounding verifier. Default: true when `evidence`
     *  is provided, false otherwise. Pass `verify: false` explicitly
     *  to skip verification even when evidence is supplied. */
    verify?: boolean;
    /** Override verifier model. Default: qwen3.5:4b. */
    verifier_model?: string;
    /** Verifier hard timeout (ms). Default 2000. */
    verifier_timeout_ms?: number;
    /** Execution mode: route (default), chat, code. */
    mode?: "route" | "chat" | "code";
    /** Enable thinking (<think> blocks). Default: true for chat/code, false for route. */
    think?: boolean;
}

export function isPrismInferArgs(args: unknown): args is PrismInferArgs {
    if (typeof args !== "object" || args === null) return false;
    const a = args as Record<string, unknown>;
    if (typeof a.prompt !== "string" || !a.prompt.trim()) return false;
    if (a.system !== undefined && typeof a.system !== "string") return false;
    if (a.max_tokens !== undefined && typeof a.max_tokens !== "number") return false;
    if (a.temperature !== undefined && typeof a.temperature !== "number") return false;
    if (a.cloud_fallback !== undefined && typeof a.cloud_fallback !== "boolean") return false;
    if (a.timeout_ms !== undefined && typeof a.timeout_ms !== "number") return false;
    if (a.model_ceiling !== undefined &&
        !["27b", "9b", "4b", "2b"].includes(a.model_ceiling as string)) return false;
    if (a.mode !== undefined &&
        !["route", "chat", "code"].includes(a.mode as string)) return false;
    if (a.think !== undefined && typeof a.think !== "boolean") return false;
    if (a.verify !== undefined && typeof a.verify !== "boolean") return false;
    if (a.verifier_model !== undefined && typeof a.verifier_model !== "string") return false;
    if (a.verifier_timeout_ms !== undefined && typeof a.verifier_timeout_ms !== "number") return false;
    if (a.evidence !== undefined) {
        if (!Array.isArray(a.evidence)) return false;
        for (const e of a.evidence) {
            if (!e || typeof e !== "object") return false;
            const es = e as Record<string, unknown>;
            if (typeof es.source !== "string" || typeof es.content !== "string") return false;
        }
    }
    return true;
}

// ─── Ollama helpers ────────────────────────────────────────────

const DEFAULT_TIMEOUTS: Record<string, number> = {
    "prism-coder:27b": 120_000,
    "prism-coder:9b":   60_000,
    "prism-coder:4b":   20_000,
    "prism-coder:2b":  15_000,
};

/** List Ollama-installed tags. Returns null if Ollama unreachable. */
export async function listOllamaTags(url: string = PRISM_LOCAL_LLM_URL): Promise<Set<string> | null> {
    try {
        const res = await fetch(`${url}/api/tags`, {
            signal: AbortSignal.timeout(3_000),
            redirect: "error",
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        const names = new Set<string>();
        for (const m of data.models ?? []) {
            if (m?.name) names.add(m.name);
        }
        return names;
    } catch {
        return null;
    }
}

/** List Ollama-currently-loaded models (warm in memory). */
export async function listOllamaLoaded(url: string = PRISM_LOCAL_LLM_URL): Promise<Set<string>> {
    try {
        const res = await fetch(`${url}/api/ps`, {
            signal: AbortSignal.timeout(3_000),
            redirect: "error",
        });
        if (!res.ok) return new Set();
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        const names = new Set<string>();
        for (const m of data.models ?? []) {
            if (m?.name) names.add(m.name);
        }
        return names;
    } catch {
        return new Set();
    }
}

interface OllamaChatResp {
    message?: { content?: string };
    error?: string;
    done?: boolean;
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
}

async function callOllamaGenerate(
    url: string,
    model: string,
    prompt: string,
    system: string | undefined,
    maxTokens: number,
    temperature: number,
    timeoutMs: number,
    think?: boolean,
): Promise<{ ok: true; text: string; doneReason?: string; promptTokens?: number; completionTokens?: number } | { ok: false; reason: string }> {
    try {
        const messages: Array<{ role: string; content: string }> = [];
        if (system) messages.push({ role: "system", content: system });
        messages.push({ role: "user", content: prompt });
        const body = {
            model,
            messages,
            stream: false,
            ...(think !== undefined ? { think } : {}),
            options: { num_predict: maxTokens, temperature },
        };
        const res = await fetch(`${url}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
            redirect: "error",
        });
        if (!res.ok) return { ok: false, reason: `ollama_http_${res.status}` };
        const data = (await res.json()) as OllamaChatResp;
        if (data.error) return { ok: false, reason: `ollama_err:${data.error}` };
        const text = (data.message?.content ?? "").trim();
        if (!text) return { ok: false, reason: "empty_response" };
        return { ok: true, text, doneReason: data.done_reason, promptTokens: data.prompt_eval_count, completionTokens: data.eval_count };
    } catch (err) {
        const name = err instanceof Error ? err.name : "Unknown";
        return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
    }
}

// ─── Cloud fallback via synalux portal ─────────────────────────

interface CloudResult {
    ok: boolean;
    output?: string;
    backend?: string;
    reason?: string;
}

async function callSynaluxInference(
    prompt: string,
    maxTokens: number,
    timeoutMs: number,
): Promise<CloudResult> {
    if (!PRISM_SYNALUX_BASE_URL) return { ok: false, reason: "no_synalux_base_url" };

    const jwt = await getSynaluxJwt();
    if (!jwt) return { ok: false, reason: "jwt_exchange_failed" };

    const url = `${PRISM_SYNALUX_BASE_URL}/api/v1/prism-aac/inference`;
    try {
        let res = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${jwt}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ prompt, max_tokens: maxTokens }),
            signal: AbortSignal.timeout(timeoutMs),
            redirect: "error",
        });

        // One-shot retry on 401 — JWT may have expired between cache check and call.
        if (res.status === 401) {
            invalidateSynaluxJwt();
            const fresh = await getSynaluxJwt();
            if (!fresh) return { ok: false, reason: "jwt_refresh_failed" };
            res = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${fresh}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ prompt, max_tokens: maxTokens }),
                signal: AbortSignal.timeout(timeoutMs),
                redirect: "error",
            });
        }

        if (!res.ok) return { ok: false, reason: `synalux_http_${res.status}` };

        const backend = res.headers.get("X-Prism-Backend") ?? "synalux-unknown";
        const data = (await res.json()) as { output?: string; error?: string };
        if (data.error || !data.output) return { ok: false, reason: `synalux_err:${data.error ?? "no_output"}` };
        return { ok: true, output: data.output, backend };
    } catch (err) {
        const name = err instanceof Error ? err.name : "Unknown";
        return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "synalux_timeout" : "synalux_network" };
    }
}

// ─── Portal verifier (thin-client HTTP call) ──────────────────

async function callSynaluxVerifier(opts: {
    draft: string;
    evidence: EvidenceSnippet[];
    verifierModel?: string;
    timeoutMs?: number;
    ollamaUrl?: string;
}): Promise<GroundingOutcome> {
    if (!PRISM_SYNALUX_BASE_URL) throw new Error("no_synalux_base_url");

    const jwt = await getSynaluxJwt();
    if (!jwt) throw new Error("jwt_exchange_failed");

    const url = `${PRISM_SYNALUX_BASE_URL}/api/v1/prism/verify-grounding`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${jwt}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            draft: opts.draft,
            evidence: opts.evidence,
            verifierModel: opts.verifierModel,
            // Give portal 500ms headroom before our own AbortSignal fires.
            timeoutMs: Math.max(500, (opts.timeoutMs ?? 5_000) - 500),
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
        redirect: "error",
    });

    if (!res.ok) throw new Error(`synalux_verifier_http_${res.status}`);
    return res.json() as Promise<GroundingOutcome>;
}

// ─── Main handler ──────────────────────────────────────────────

export interface PrismInferResult {
    output: string;
    backend: string;
    model_picked: string | null;
    ram_free_mb: number;
    latency_ms: number;
    used_cloud: boolean;
    attempts: Array<{ tier: string; reason: string }>;
    plan?: string;
    /** Actual token counts from Ollama, or char/4 estimates for cloud. */
    prompt_tokens?: number;
    completion_tokens?: number;
    /** Populated when `verify: true` was supplied. */
    verification?: {
        action: GroundingOutcome["action"];
        verifierChain: GroundingOutcome["verifierChain"];
        refusalClaim?: string;
    };
    /** True when local output was served despite quality gate failure (cloud unavailable/failed). */
    quality_gate_failed?: boolean;
}

/**
 * Pure implementation, exported for unit tests.
 * Accepts injected dependencies so tests can mock Ollama / synalux.
 */
export interface InferDeps {
    freemem: () => number;
    listTags: () => Promise<Set<string> | null>;
    listLoaded: () => Promise<Set<string>>;
    callLocal: (url: string, model: string, prompt: string, system: string | undefined, maxTokens: number, temperature: number, timeoutMs: number, think?: boolean) => ReturnType<typeof callOllamaGenerate>;
    callCloud: typeof callSynaluxInference;
    ollamaUrl: string;
    /** Injectable verifier for testing. When omitted, verification is skipped (portal-side). */
    callVerifier?: (opts: { draft: string; evidence: EvidenceSnippet[]; verifierModel?: string; timeoutMs?: number; ollamaUrl?: string }) => Promise<GroundingOutcome>;
    /** Injectable entitlements for testing. When omitted, fetched live. */
    entitlements?: PrismEntitlements;
    /** Injectable Layer 1 classifier for testing. Defaults to callLayer1 from layer1.ts. */
    callLayer1?: (userPrompt: string, ollamaUrl: string, model: string) => Promise<Layer1Verdict>;
}

export async function runInfer(args: PrismInferArgs, deps: InferDeps): Promise<PrismInferResult> {
    const t0 = Date.now();
    const temperature = args.temperature ?? 0;

    // ── L1 Safety — deterministic input interception ────────────
    const safetyIntercept = checkInputSafety(args.prompt);
    if (safetyIntercept) {
        return {
            output: safetyIntercept,
            backend: "safety_gate",
            model_picked: null,
            ram_free_mb: Math.round(deps.freemem() / (1024 * 1024)),
            latency_ms: Date.now() - t0,
            used_cloud: false,
            attempts: [{ tier: "l1_safety", reason: "crisis_or_medical_intercept" }],
        };
    }

    // ── Entitlement enforcement ──────────────────────────────────
    // Fetch user's plan limits (cached 1hr). Free users without auth
    // get 4b ceiling, 50 calls/day, 512 max tokens.
    const ent = deps.entitlements ?? await getEntitlements();

    // MF2: In chat/code modes, request the 27B tier (subject to plan ceiling + RAM).
    // mode:"code" implies quality → start higher in the cascade.
    const mode = args.mode ?? "route";
    const modeCeiling = (mode === "chat" || mode === "code") ? (args.model_ceiling ?? "27b") : args.model_ceiling;
    const effectiveCeiling = clampCeiling(modeCeiling, ent.model_ceiling);

    // Clamp max_tokens to plan limit
    const maxTokens = Math.min(args.max_tokens ?? 1024, ent.max_tokens, 8192);

    // Cloud fallback only for paid plans
    const allowCloud = args.cloud_fallback === true && ent.features.cloud_fallback;

    // Verification only for paid plans (free users skip L3 grounding)
    const canVerify = ent.features.grounding_verifier;

    const freeBytes = deps.freemem();
    const ramFreeMb = Math.round(freeBytes / (1024 * 1024));
    const attempts: Array<{ tier: string; reason: string }> = [];

    // Strip verification args if plan lacks grounding_verifier
    const gatedArgs = canVerify ? args : { ...args, verify: false, evidence: undefined };

    debugLog(`[prism_infer] plan=${ent.plan} ceiling=${effectiveCeiling} max_tokens=${maxTokens} cloud=${allowCloud} verify=${canVerify}`);

    // Log tier enforcement to Datadog for monetization visibility
    const ceilingClamped = effectiveCeiling !== (args.model_ceiling ?? ent.model_ceiling);
    const tokensClamped = maxTokens < (args.max_tokens ?? 1024);
    const cloudBlocked = args.cloud_fallback === true && !allowCloud;
    const verifierBlocked = (args.verify === true || (args.evidence?.length ?? 0) > 0) && !canVerify;

    if (ceilingClamped || tokensClamped || cloudBlocked || verifierBlocked) {
        ddLog("info", "prism_infer.tier_enforcement", {
            plan: ent.plan,
            requested_ceiling: args.model_ceiling,
            effective_ceiling: effectiveCeiling,
            ceiling_clamped: ceilingClamped,
            requested_tokens: args.max_tokens,
            effective_tokens: maxTokens,
            tokens_clamped: tokensClamped,
            cloud_requested: args.cloud_fallback,
            cloud_allowed: allowCloud,
            cloud_blocked: cloudBlocked,
            verify_requested: args.verify,
            verify_allowed: canVerify,
            verify_blocked: verifierBlocked,
        });
    }

    // Discover which tags Ollama actually has + which are already warm.
    // Already-loaded models don't need RAM headroom — they're reusing
    // memory Ollama allocated previously.
    const installed = await deps.listTags();
    const loaded = await deps.listLoaded();
    if (installed === null) {
        attempts.push({ tier: "ollama_probe", reason: "unreachable" });
    }

    // ── §E Layer 1 semantic pre-classifier ──────────────────────────────────
    // Catches adversarial paraphrases the keyword stub misses.
    // Runs only when cloud escalation is possible — without cloud, there is
    // nowhere to route a RESERVED verdict.
    // Recursion guard: skip when this call IS the Layer 1 classification
    // (mode="route" + max_tokens<=16 is the Layer 1 call signature).
    const layer1RecursionGuard = mode === "route" && maxTokens <= 16;
    if (allowCloud && !layer1RecursionGuard) {
        const l1fn = deps.callLayer1 ?? defaultCallLayer1;
        const l1Model = resolveOllamaName("prism-coder:4b", installed ?? new Set());
        const l1 = await l1fn(args.prompt, deps.ollamaUrl, l1Model);
        if (l1 !== "OBVIOUS_NOT_RESERVED") {
            debugLog(`[prism_infer] Layer 1 verdict=${l1} — escalating to cloud`);
            attempts.push({ tier: "layer1", reason: `layer1_${l1.toLowerCase()}` });
            const cloudTimeout = args.timeout_ms ?? 90_000;
            const cloud = await deps.callCloud(args.prompt, maxTokens, cloudTimeout);
            if (cloud.ok && cloud.output) {
                return await applyVerification(cloud.output, gatedArgs, deps, {
                    backend: cloud.backend ?? "synalux",
                    model_picked: null,
                    ram_free_mb: ramFreeMb,
                    latency_ms: Date.now() - t0,
                    used_cloud: true,
                    attempts,
                    plan: ent.plan,
                    completion_tokens: Math.ceil(cloud.output.length / 4),
                });
            }
            attempts.push({ tier: "synalux", reason: cloud.reason ?? "unknown" });
            // Layer 1 flagged RESERVED but cloud unavailable — fail closed, never fall through to local.
            throw new Error(
                `prism_infer: Layer 1 verdict=${l1} but cloud unavailable. attempts=${JSON.stringify(attempts)}`
            );
        }
        debugLog(`[prism_infer] Layer 1 verdict=OBVIOUS_NOT_RESERVED — proceeding local`);
    }
    // ── end Layer 1 ─────────────────────────────────────────────────────────

    // Walk the tier table top → bottom, capped by model_ceiling. Each tier
    // logs its skip reason ("not_pulled" / "ram_insufficient" / fail reason)
    // so the caller can see exactly why each tier was bypassed.
    let localDraft: { output: string; tier: string; promptTokens?: number; completionTokens?: number } | null = null;

    if (installed) {
        const ceilStart = effectiveCeiling
            ? Math.max(0, MODEL_TIERS.findIndex(t => t.tag.endsWith(`:${effectiveCeiling}`)))
            : 0;
        let anyViable = false;

        for (let i = ceilStart; i < MODEL_TIERS.length; i++) {
            const tier = MODEL_TIERS[i];
            // Accept the tier whether Ollama reports it as bare (`prism-coder:27b`)
            // or namespaced (`dcostenco/prism-coder:27b`, the form `ollama pull`
            // produces from a HF repo). resolveOllamaName returns the actual
            // name Ollama knows so /api/generate finds the model.
            const ollamaName = resolveOllamaName(tier.tag, installed);
            if (!installed.has(ollamaName)) {
                attempts.push({ tier: tier.tag, reason: "not_pulled" });
                continue;
            }
            // RAM gate — but skip the check if the tier is already warm in
            // Ollama. Reused models don't reallocate weight buffers.
            const isWarm = loaded.has(ollamaName);
            if (!isWarm && freeBytes < tier.minFreeGb * (1024 ** 3)) {
                attempts.push({ tier: tier.tag, reason: "ram_insufficient" });
                continue;
            }
            anyViable = true;
            const timeout = args.timeout_ms ?? DEFAULT_TIMEOUTS[tier.tag] ?? 60_000;
            const enableThink = args.think ?? (mode !== "route");
            const result = await deps.callLocal(
                deps.ollamaUrl, ollamaName, args.prompt, args.system, maxTokens, temperature, timeout, enableThink,
            );
            if (result.ok) {
                const { stripped, thinkOnly } = stripThink(result.text);
                const output = stripped;

                // Quality gate — all modes. Route uses mode-aware empty floor (length===0).
                const gate = passesQualityGate(output, thinkOnly, result.doneReason, mode);
                if (!gate.pass && allowCloud) {
                    debugLog(`[prism_infer] quality gate FAIL (${gate.reason}) — escalating to cloud`);
                    attempts.push({ tier: tier.tag, reason: `quality_gate:${gate.reason}` });
                    if (gate.reason === "hard_truncation" || gate.reason === "loop_detected") {
                        localDraft = { output, tier: tier.tag, promptTokens: result.promptTokens, completionTokens: result.completionTokens };
                    }
                    break;
                }
                if (!gate.pass) {
                    debugLog(`[prism_infer] quality gate FAIL (${gate.reason}) — no cloud, serving local`);
                }

                return await applyVerification(output, gatedArgs, deps, {
                    backend: `ollama-${tier.tag.replace("prism-coder:", "")}`,
                    model_picked: tier.tag,
                    ram_free_mb: ramFreeMb,
                    latency_ms: Date.now() - t0,
                    used_cloud: false,
                    attempts,
                    plan: ent.plan,
                    prompt_tokens: result.promptTokens,
                    completion_tokens: result.completionTokens,
                });
            }
            attempts.push({ tier: tier.tag, reason: result.reason });
        }
        if (!anyViable) {
            attempts.push({ tier: "picker", reason: `no_viable_local_at_${fmtGb(freeBytes)}_free` });
        }
        // Reference picker so the import is used + so tests can verify it's exported.
        void pickLocalModel;
    }

    // ── Local exhausted. Optional synalux fallback. ──
    if (allowCloud) {
        const cloudTimeout = args.timeout_ms ?? 90_000;
        const cloud = await deps.callCloud(args.prompt, maxTokens, cloudTimeout);
        if (cloud.ok && cloud.output) {
            return await applyVerification(cloud.output, gatedArgs, deps, {
                backend: cloud.backend ?? "synalux",
                model_picked: null,
                ram_free_mb: ramFreeMb,
                latency_ms: Date.now() - t0,
                used_cloud: true,
                attempts,
                plan: ent.plan,
                // T4: omit prompt_tokens — cloud doesn't return Ollama actual eval count.
                // recordInference receives prompt_text and computes submittedEst via
                // estimateTokens(), keeping promptTokensEvaluated=0 (correct for cloud).
                completion_tokens: Math.ceil(cloud.output.length / 4),
            });
        }
        attempts.push({ tier: "synalux", reason: cloud.reason ?? "unknown" });
    } else {
        attempts.push({ tier: "synalux", reason: "cloud_fallback_disabled" });
    }

    // Cloud also failed — serve the local draft if we have one
    if (localDraft) {
        debugLog(`[prism_infer] cloud failed, serving gate-failed local draft from ${localDraft.tier}`);
        return await applyVerification(localDraft.output, gatedArgs, deps, {
            backend: `ollama-${localDraft.tier.replace("prism-coder:", "")}`,
            model_picked: localDraft.tier,
            ram_free_mb: ramFreeMb,
            latency_ms: Date.now() - t0,
            used_cloud: false,
            attempts,
            plan: ent.plan,
            prompt_tokens: localDraft.promptTokens,
            completion_tokens: localDraft.completionTokens,
            quality_gate_failed: true,
        });
    }

    const err = new Error(
        `prism_infer: no backend produced output. attempts=${JSON.stringify(attempts)}, free=${fmtGb(freeBytes)}`
    );
    (err as unknown as { attempts: typeof attempts }).attempts = attempts;
    throw err;
}

/**
 * Wraps a successful inference result with the L3 grounding verifier
 * when the caller opted in via `verify: true`. The verifier substitutes
 * the model's draft with a refusal string if any claim is not entailed
 * by the supplied evidence; we surface that as a non-null `verification`
 * field so callers can route refusals separately from successes.
 */
async function applyVerification(
    draft: string,
    args: PrismInferArgs,
    deps: InferDeps,
    partial: Omit<PrismInferResult, "output" | "verification">,
): Promise<PrismInferResult> {
    // L1 output safety — intercept dangerous model-generated content
    const safeDraft = checkOutputSafety(draft);

    const shouldVerify = args.verify ?? (args.evidence !== undefined && args.evidence.length > 0);
    if (!shouldVerify || !deps.callVerifier) {
        return { ...partial, output: safeDraft };
    }
    const verifier = deps.callVerifier;
    const outcome = await verifier({
        draft,
        evidence: args.evidence ?? [],
        verifierModel: args.verifier_model,
        timeoutMs: args.verifier_timeout_ms,
        ollamaUrl: deps.ollamaUrl,
    });
    return {
        ...partial,
        output: checkOutputSafety(outcome.finalText),
        verification: {
            action: outcome.action,
            verifierChain: outcome.verifierChain,
            refusalClaim: outcome.refusalClaim,
        },
    };
}

/**
 * MCP-shaped handler. Wraps runInfer with real deps + MCP envelope.
 */
export async function prismInferHandler(args: unknown): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}> {
    if (!isPrismInferArgs(args)) {
        throw new Error("Invalid arguments for prism_infer (need {prompt: string})");
    }
    try {
        const result = await runInfer(args, {
            freemem: () => getAvailableMemoryBytes(),
            listTags: () => listOllamaTags(PRISM_LOCAL_LLM_URL),
            listLoaded: () => listOllamaLoaded(PRISM_LOCAL_LLM_URL),
            callLocal: callOllamaGenerate,
            callCloud: callSynaluxInference,
            ollamaUrl: PRISM_LOCAL_LLM_URL,
            callVerifier: SYNALUX_CONFIGURED ? callSynaluxVerifier : undefined,
        });

        debugLog(`[prism_infer] backend=${result.backend} model=${result.model_picked} latency=${result.latency_ms}ms free=${result.ram_free_mb}MB`);

        // Local accumulator — sole source of the user-facing metrics block.
        // T4: pass prompt_text so recordInference computes submittedEst via
        // estimateTokens() — critical for cloud path where prompt_tokens is unset.
        recordInference({ ...result, prompt_text: args.prompt });

        // Best-effort portal forwarding (independent analytics stream).
        // safety_gate excluded — logging crisis filter triggers is a HIPAA concern.
        if (result.backend !== "safety_gate") {
            ddLog("info", "prism_infer.usage", {
                backend: result.backend,
                model: result.model_picked ?? result.backend,
                used_cloud: result.used_cloud,
                prompt_tokens: result.prompt_tokens ?? 0,
                completion_tokens: result.completion_tokens ?? 0,
                latency_ms: result.latency_ms,
            });
        }

        const tokenStr = result.prompt_tokens != null || result.completion_tokens != null
            ? ` tokens=${result.prompt_tokens ?? "?"}in/${result.completion_tokens ?? "?"}out`
            : "";
        const headerBase =
            `[prism_infer] backend=${result.backend}` +
            ` model=${result.model_picked ?? "n/a"}` +
            ` plan=${result.plan ?? "unknown"}` +
            ` free_ram=${result.ram_free_mb}MB` +
            ` latency=${result.latency_ms}ms` +
            ` used_cloud=${result.used_cloud}` +
            tokenStr +
            (result.quality_gate_failed ? ` quality_gate_failed=true` : "") +
            (result.verification ? ` verify=${result.verification.action}` : "") +
            (result.attempts.length ? ` attempts=${JSON.stringify(result.attempts)}` : "");

        // Append periodic session-level stats to the header line.
        // compact=true is threshold-gated (PRISM_METRICS_EVERY, default every 5 calls)
        // so it doesn't appear on every response — only as a rolling summary.
        const metricsLine = formatInferenceMetrics(true);
        const header = metricsLine ? `${headerBase}\n${metricsLine}` : headerBase;

        return {
            content: [
                { type: "text", text: header },
                { type: "text", text: result.output },
            ],
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: "text", text: msg }],
            isError: true,
        };
    }
}
