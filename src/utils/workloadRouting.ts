/** Deterministic workload policy. Scope hints never grant safety, entitlement,
 * checkpoint qualification or resource admission. */
export const WORKLOAD_POLICY_VERSION = "omlx-workload-v2";
export type WorkloadKind = "generation" | "bugfix" | "extension" | "review" | "extraction";
export type WorkloadRole = "coder" | "reviewer";
export type WorkloadLane = "small" | "ordinary" | "demanding" | "review" | "unknown";
export type LogicalModel = "2b" | "4b" | "9b" | "27b" | "Flash-Next";
export interface WorkloadV1 {
    version: 1; kind: WorkloadKind; files: number; functions: number;
    dependency_edges: number; constraints: number; shared_state: boolean;
    concurrency: "none" | "async" | "concurrent";
    compatibility: "none" | "backward";
    acceptance: "executable" | "host_review" | "none";
}
const KINDS = new Set(["generation", "bugfix", "extension", "review", "extraction"]);
const ROLES = new Set(["coder", "reviewer"]);
const CONCURRENCY = new Set(["none", "async", "concurrent"]);
const COMPATIBILITY = new Set(["none", "backward"]);
const ACCEPTANCE = new Set(["executable", "host_review", "none"]);
const FIELDS = ["version", "kind", "files", "functions", "dependency_edges", "constraints", "shared_state", "concurrency", "compatibility", "acceptance"] as const;
const COUNTS = Object.freeze({ files: 100, functions: 1000, dependency_edges: 1000, constraints: 100 });
const ORDINARY = Object.freeze(["9b", "4b", "2b"] as const);
const CANDIDATES: Readonly<Record<WorkloadLane, readonly LogicalModel[]>> = Object.freeze({
    small: Object.freeze(["2b", "4b", "9b"] as const), ordinary: ORDINARY, unknown: ORDINARY,
    demanding: Object.freeze(["Flash-Next"] as const), review: Object.freeze(["Flash-Next", "9b"] as const),
});
const INVALID = "workload_contract_invalid";

export function parseWorkload(value: unknown, role?: unknown): WorkloadV1 | undefined {
    if (role !== undefined && !ROLES.has(role as string)) throw new Error(INVALID);
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID);
    const v = value as Record<string, unknown>;
    if (Object.keys(v).length !== FIELDS.length || !FIELDS.every(key => Object.hasOwn(v, key))
        || v.version !== 1 || !KINDS.has(v.kind as string) || typeof v.shared_state !== "boolean"
        || !CONCURRENCY.has(v.concurrency as string) || !COMPATIBILITY.has(v.compatibility as string)
        || !ACCEPTANCE.has(v.acceptance as string)
        || !Object.entries(COUNTS).every(([key, max]) => Number.isSafeInteger(v[key]) && (v[key] as number) >= 0 && (v[key] as number) <= max)
        || (role === "reviewer" && v.kind !== "review") || (role === "coder" && v.kind === "review")) throw new Error(INVALID);
    // Enumerate fields: retain no caller-owned extra object state.
    return { version: 1, kind: v.kind as WorkloadKind, files: v.files as number, functions: v.functions as number,
        dependency_edges: v.dependency_edges as number, constraints: v.constraints as number, shared_state: v.shared_state,
        concurrency: v.concurrency as WorkloadV1["concurrency"], compatibility: v.compatibility as WorkloadV1["compatibility"],
        acceptance: v.acceptance as WorkloadV1["acceptance"] };
}

/** `verifiedLogicRetry` is an internal host-receipt decision, never a workload field. */
export function workloadLane(value?: unknown, role?: unknown, verifiedLogicRetry = false): WorkloadLane {
    if (typeof verifiedLogicRetry !== "boolean") throw new Error(INVALID);
    const v = parseWorkload(value, role);
    if (role === "reviewer" || v?.kind === "review") return "review";
    if (verifiedLogicRetry) return "demanding";
    if (!v) return "unknown";
    if (v.files >= 4 || v.functions >= 5 || v.dependency_edges >= 3 || v.constraints >= 4 || v.shared_state
        || v.concurrency === "concurrent" || (v.compatibility === "backward" && v.files >= 2)) return "demanding";
    if (v.files >= 2 || v.functions >= 2 || v.dependency_edges >= 1 || v.constraints >= 2
        || v.concurrency === "async" || (v.compatibility === "backward" && v.files === 1)) return "ordinary";
    return v.acceptance === "none" || v.compatibility !== "none" ? "unknown" : "small";
}
export function workloadRoutePreview(value?: unknown, role?: unknown) {
    const lane = workloadLane(value, role);
    return { policy_version: WORKLOAD_POLICY_VERSION, lane, candidate_order: [...CANDIDATES[lane]],
        qualification_required: true as const, generation_enabled: false as const,
        evidence_scope: "workload_policy_preview" as const };
}

/** Operator-verified records and current provider observations are INTERNAL
 * dependencies. No field below is accepted as a caller qualification claim. */
export type LocalBackend = "omlx" | "ollama";
export type FleetProfile = "native" | "fast" | "quality";
export interface FleetCondition {
    checkpoint_sha256: string; profile_sha256: string; settings_sha256: string;
    provider_version: string; hardware_sha256: string; context_bin_tokens: number;
    output_cap: number; residency: "cold" | "warm";
}
export interface FleetQualification {
    kind: WorkloadKind | "bounded"; lane: WorkloadLane; cases: number; passed: number;
    evidence_sha256: string;
    review?: { true_positive: number; false_positive: number; false_negative: number;
        critical_total: number; critical_found: number };
}
export interface FleetCandidate {
    logical_model: LogicalModel; backend: LocalBackend; model_id: string;
    physical_parameters: number; context_tokens: number; profile_id: FleetProfile;
    condition: FleetCondition; qualification: FleetQualification;
    calibration: { measured_at_ms: number; durations_ms: number[]; peak_extra_bytes: number; evidence_sha256: string };
}
export interface FleetObservation {
    logical_model: LogicalModel; backend: LocalBackend; model_id: string; verified_checkpoint_sha256: string;
    profile_sha256: string; settings_sha256: string; residency: "cold" | "warm";
}
export interface FleetSnapshot {
    version: 1; candidates: FleetCandidate[]; observed: FleetObservation[];
    provider_versions: { omlx: string | null; ollama: string | null }; hardware_sha256: string;
    now_ms: number; available_bytes: number; remaining_ms: number;
    input_tokens: number; output_cap: number; entitlement_ceiling: "2b" | "4b" | "9b" | "27b";
    provider_qualified: { omlx: boolean; ollama: boolean }; quarantined: { omlx: boolean; ollama: boolean };
    ollama_loaded_models: string[];
}
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const BACKENDS = ["omlx", "ollama"] as const;
const PROFILES = ["native", "fast", "quality"] as const;
const MODELS: readonly LogicalModel[] = ["2b", "4b", "9b", "27b", "Flash-Next"];
const RANK: Readonly<Record<LogicalModel, number>> = Object.freeze({ "2b": 0, "4b": 1, "9b": 2, "27b": 3, "Flash-Next": 3 });
const ADMISSION_HEADROOM_BYTES = 2 * 1024 ** 3;
const MAX_CALIBRATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FIRST_ATTEMPT_MS: Readonly<Record<WorkloadLane, number>> = Object.freeze({ small: 30_000, ordinary: 120_000, unknown: 120_000, demanding: 900_000, review: 900_000 });
const objectFields = (value: unknown, fields: readonly string[], optional: readonly string[] = []): value is Record<string, any> =>
    !!value && typeof value === "object" && !Array.isArray(value)
    && fields.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => fields.includes(key) || optional.includes(key));
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;

function validateSnapshot(value: unknown): asserts value is FleetSnapshot {
    const fail = () => { throw new Error("fleet_admission_snapshot_invalid"); };
    if (!objectFields(value, ["version", "candidates", "observed", "provider_versions", "hardware_sha256", "now_ms", "available_bytes", "remaining_ms",
        "input_tokens", "output_cap", "entitlement_ceiling", "provider_qualified", "quarantined", "ollama_loaded_models"])) fail();
    const v = value as FleetSnapshot;
    if (v.version !== 1 || !Array.isArray(v.candidates) || v.candidates.length > 128 || !Array.isArray(v.observed) || v.observed.length > 128
        || typeof v.hardware_sha256 !== "string" || !SHA256.test(v.hardware_sha256) || !count(v.now_ms) || !count(v.available_bytes) || !count(v.remaining_ms, 900_000)
        || !count(v.input_tokens, 1_048_576) || !count(v.output_cap, 8192) || v.output_cap < 1
        || !["2b", "4b", "9b", "27b"].includes(v.entitlement_ceiling)
        || !Array.isArray(v.ollama_loaded_models) || v.ollama_loaded_models.length > 1024 || !v.ollama_loaded_models.every(id => typeof id === "string" && IDENTIFIER.test(id))) fail();
    for (const pair of [v.provider_qualified, v.quarantined]) if (!objectFields(pair, BACKENDS) || !BACKENDS.every(backend => typeof pair[backend] === "boolean")) fail();
    if (!objectFields(v.provider_versions, BACKENDS) || !BACKENDS.every(backend => {
        const version = v.provider_versions[backend];
        return version === null ? !v.provider_qualified[backend] : typeof version === "string" && version.length <= 32 && VERSION.test(version);
    })) fail();
    const observedKeys = new Set<string>(), candidateKeys = new Set<string>();
    const currentIdentities = new Map<string, string>();
    for (const o of v.observed) {
        if (!objectFields(o, ["logical_model", "backend", "model_id", "verified_checkpoint_sha256", "profile_sha256", "settings_sha256", "residency"])
            || !MODELS.includes(o.logical_model) || !BACKENDS.includes(o.backend) || typeof o.model_id !== "string" || !IDENTIFIER.test(o.model_id)
            || ![o.verified_checkpoint_sha256, o.profile_sha256, o.settings_sha256].every(s => typeof s === "string" && SHA256.test(s))
            || !["cold", "warm"].includes(o.residency)) fail();
        const key = JSON.stringify([o.backend, o.model_id, o.profile_sha256]);
        if (observedKeys.has(key)) fail(); observedKeys.add(key);
        const physical = JSON.stringify([o.backend, o.model_id]);
        const identity = JSON.stringify([o.logical_model, o.verified_checkpoint_sha256]);
        if (currentIdentities.has(physical) && currentIdentities.get(physical) !== identity) fail();
        currentIdentities.set(physical, identity);
    }
    for (const c of v.candidates) {
        if (!objectFields(c, ["logical_model", "backend", "model_id", "physical_parameters", "context_tokens", "profile_id", "condition", "qualification", "calibration"])
            || !MODELS.includes(c.logical_model) || !BACKENDS.includes(c.backend) || typeof c.model_id !== "string" || !IDENTIFIER.test(c.model_id)
            || !count(c.physical_parameters) || c.physical_parameters < 1 || !count(c.context_tokens, 1_048_576) || c.context_tokens < 1 || !PROFILES.includes(c.profile_id)) fail();
        const key = JSON.stringify([c.logical_model, c.backend, c.model_id, c.profile_id]);
        if (candidateKeys.has(key)) fail(); candidateKeys.add(key);
        const p = c.condition, q = c.qualification, t = c.calibration;
        if (!objectFields(p, ["checkpoint_sha256", "profile_sha256", "settings_sha256", "provider_version", "hardware_sha256", "context_bin_tokens", "output_cap", "residency"])
            || ![p.checkpoint_sha256, p.profile_sha256, p.settings_sha256, p.hardware_sha256].every(s => typeof s === "string" && SHA256.test(s))
            || typeof p.provider_version !== "string" || p.provider_version.length > 32 || !VERSION.test(p.provider_version)
            || !count(p.context_bin_tokens, 1_048_576) || p.context_bin_tokens < 4096 || p.context_bin_tokens % 4096 !== 0
            || !count(p.output_cap, 8192) || p.output_cap < 1 || !["cold", "warm"].includes(p.residency)) fail();
        if (!objectFields(q, ["kind", "lane", "cases", "passed", "evidence_sha256"], ["review"])
            || ![...KINDS, "bounded"].includes(q.kind) || typeof q.lane !== "string" || !Object.hasOwn(CANDIDATES, q.lane)
            || !count(q.cases, 10000) || !count(q.passed, q.cases) || typeof q.evidence_sha256 !== "string" || !SHA256.test(q.evidence_sha256)) fail();
        if (q.review !== undefined && (!objectFields(q.review, ["true_positive", "false_positive", "false_negative", "critical_total", "critical_found"])
            || !Object.values(q.review).every(n => count(n, 10000)) || q.review.critical_found > q.review.critical_total
            || q.review.critical_found > q.review.true_positive || q.review.critical_total > q.review.true_positive + q.review.false_negative)) fail();
        if (!objectFields(t, ["measured_at_ms", "durations_ms", "peak_extra_bytes", "evidence_sha256"])
            || !count(t.measured_at_ms) || !count(t.peak_extra_bytes) || typeof t.evidence_sha256 !== "string" || !SHA256.test(t.evidence_sha256)
            || !Array.isArray(t.durations_ms) || t.durations_ms.length > 1024 || !t.durations_ms.every(n => positive(n) && n <= 900_000)) fail();
    }
}

/** Select only measured, exactly observed candidates. This is a pure internal
 * policy decision; the ownership/safety/identity adapters still enforce it. */
export function qualifiedAdmissionPreview(workload: unknown, role: unknown, snapshot: unknown, ceiling?: LogicalModel, verifiedLogicRetry = false) {
    const lane = workloadLane(workload, role, verifiedLogicRetry);
    const kind = parseWorkload(workload, role)?.kind ?? (role === "reviewer" ? "review" : "bounded");
    validateSnapshot(snapshot);
    const v = snapshot;
    if (ceiling !== undefined && (!MODELS.includes(ceiling) || ceiling === "Flash-Next")) throw new Error("fleet_admission_ceiling_invalid");
    const limit = Math.min(RANK[v.entitlement_ceiling], ceiling === undefined ? 3 : RANK[ceiling]);
    const attemptBudget = Math.min(v.remaining_ms, FIRST_ATTEMPT_MS[lane]);
    const rejections: { logical_model: LogicalModel; backend: LocalBackend; reason: string }[] = [];
    const sameIdentity = (c: FleetCandidate, o: FleetObservation) => o.logical_model === c.logical_model && o.backend === c.backend && o.model_id === c.model_id
        && o.verified_checkpoint_sha256 === c.condition.checkpoint_sha256;
    for (const logical of CANDIDATES[lane]) {
        if (RANK[logical] > limit) continue;
        const choices = v.candidates.filter(c => c.logical_model === logical).sort((a, b) => BACKENDS.indexOf(a.backend) - BACKENDS.indexOf(b.backend));
        const compatibleOmlx = v.observed.some(o => o.backend === "omlx" && o.logical_model === logical);
        for (const c of choices) {
            const p = c.condition, q = c.qualification, t = c.calibration;
            const o = v.observed.find(o => sameIdentity(c, o) && o.profile_sha256 === p.profile_sha256 && o.settings_sha256 === p.settings_sha256 && o.residency === p.residency);
            let reason: string | undefined;
            if (c.backend === "ollama" && compatibleOmlx) reason = "compatible_omlx_only";
            else if (!v.provider_qualified[c.backend] || v.quarantined[c.backend]) reason = "provider_unqualified_or_quarantined";
            else if (!o || p.hardware_sha256 !== v.hardware_sha256 || p.provider_version !== v.provider_versions[c.backend]) reason = "identity_or_condition_mismatch";
            else if (c.backend === "ollama" && (p.residency !== "warm" || !v.ollama_loaded_models.includes(c.model_id))) reason = "ollama_not_resident";
            else if (logical === "Flash-Next" && (c.backend !== "omlx" || c.profile_id !== "quality" || v.ollama_loaded_models.length > 0)) reason = "flash_quality_or_residency_conflict";
            else if (q.kind !== kind || q.lane !== lane || q.cases < 10 || q.passed / q.cases < 0.8) reason = "role_lane_unqualified";
            else if (kind === "review" && (!q.review || q.review.true_positive + q.review.false_positive === 0
                || q.review.true_positive + q.review.false_negative === 0 || q.review.true_positive / (q.review.true_positive + q.review.false_positive) < 0.9
                || q.review.true_positive / (q.review.true_positive + q.review.false_negative) < 0.9 || q.review.critical_total < 1
                || q.review.critical_found !== q.review.critical_total)) reason = "review_quality_unqualified";
            else if (p.context_bin_tokens !== Math.max(4096, Math.ceil(v.input_tokens / 4096) * 4096) || p.output_cap !== v.output_cap
                || v.input_tokens + v.output_cap + 1300 > c.context_tokens) reason = "context_or_output_mismatch";
            else if (t.durations_ms.length < 10 || t.measured_at_ms > v.now_ms || v.now_ms - t.measured_at_ms > MAX_CALIBRATION_AGE_MS) reason = "calibration_missing_or_stale";
            else if (t.peak_extra_bytes + ADMISSION_HEADROOM_BYTES > v.available_bytes) reason = "memory_insufficient";
            const sorted = [...t.durations_ms].sort((a, b) => a - b);
            const projected = sorted.length ? Math.ceil(sorted[Math.ceil(sorted.length * 0.95) - 1] * 1.2) : 0;
            if (!reason && projected > attemptBudget) reason = "budget_insufficient";
            if (reason) { rejections.push({ logical_model: logical, backend: c.backend, reason }); continue; }
            return { policy_version: WORKLOAD_POLICY_VERSION, lane, status: "eligible" as const, generation_enabled: false as const,
                selected: { logical_model: logical, backend: c.backend, model_id: c.model_id, physical_parameters: c.physical_parameters,
                    checkpoint_sha256: p.checkpoint_sha256, profile_id: c.profile_id, projected_execution_ms: projected, attempt_budget_ms: attemptBudget }, rejections };
        }
    }
    return { policy_version: WORKLOAD_POLICY_VERSION, lane, status: "unavailable" as const, generation_enabled: false as const,
        reason: rejections.some(r => r.reason === "budget_insufficient") ? "budget_insufficient" : "model_unavailable", rejections };
}
