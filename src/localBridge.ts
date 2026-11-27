import type { Readable } from "node:stream";
import { localAiSnapshot } from "./dashboard/localAiActions.js";
import { LOCAL_CODING_SETTING_KEY, LEGACY_LOCAL_CODING_SETTING_KEY } from "./utils/localCodingSettings.js";
import { EXECUTION_ROLES_KEY } from "./utils/executionRoles.js";
import { localCodingPreference, resolveLocalCodingBackend } from "./utils/localCodingPreference.js";
import { getEntitlements } from "./utils/entitlements.js";
import { isPrismInferArgs, prismInferHandler, type InferExecutionContext, type PrismInferArgs } from "./tools/prismInferHandler.js";

const MAX_INPUT_BYTES = 256 * 1024;
const READ_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 900_000;
const REQUEST_FIELDS = ["prompt", "system", "messages", "local_role", "local_model", "max_tokens", "timeout_ms", "think", "temperature"];
interface BridgeDependencies {
    snapshot: typeof localAiSnapshot;
    infer: (args: PrismInferArgs, context: InferExecutionContext) => ReturnType<typeof prismInferHandler>;
    resolve?: () => Promise<{ coder: { runtime: string } }>;
}
const production: BridgeDependencies = {
    snapshot: localAiSnapshot,
    infer: (args, context) => prismInferHandler(args, undefined, context),
    resolve: async () => {
        const preference = await localCodingPreference("coder");
        if (preference.assignment?.runtime === "host" || preference.assignment?.runtime === "synalux")
            return { coder: { runtime: preference.assignment.runtime } };
        const ceiling = preference.effective === "auto" ? (await getEntitlements()).model_ceiling : undefined;
        return { coder: { runtime: resolveLocalCodingBackend({ mode: "code", model_ceiling: ceiling }, preference) } };
    },
};
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bridge_invalid_request");
    return value as Record<string, unknown>;
}

/** Same process owns inference and cancellation. No independent model transport. */
export async function handleLocalBridge(value: unknown, signal: AbortSignal, deps = production): Promise<unknown> {
    if (signal.aborted) throw new Error("bridge_cancelled");
    const input = object(value);
    if (input.action === "preferences" && Object.keys(input).length === 1) {
        const snapshot = await deps.snapshot();
        const resolved = await deps.resolve?.();
        if (signal.aborted) throw new Error("bridge_cancelled");
        return { schema: 1, configured: [LOCAL_CODING_SETTING_KEY, LEGACY_LOCAL_CODING_SETTING_KEY, EXECUTION_ROLES_KEY]
            .some(key => snapshot.expected[key] !== null), settings: snapshot.settings, assignments: snapshot.assignments,
            ...(resolved ? { resolved } : {}) };
    }
    const backend = input.backend === undefined ? "omlx" : input.backend;
    if (input.action !== "infer" || typeof input.follow_dashboard !== "boolean"
        || (backend !== "omlx" && backend !== "ollama")
        || Object.keys(input).some(key => !["action", "follow_dashboard", "request", "backend"].includes(key))) throw new Error("bridge_invalid_request");
    const request = object(input.request);
    if (Object.keys(request).some(key => !REQUEST_FIELDS.includes(key))
        || (input.follow_dashboard && request.local_model !== undefined)) throw new Error("bridge_invalid_request");
    const args = { ...request, local_role: request.local_role ?? "coder", timeout_ms: request.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        mode: "code", cloud_fallback: false, escalation: "report",
        ...(!input.follow_dashboard ? { local_backend: backend } : {}) };
    if (!isPrismInferArgs(args) || !Number.isInteger(args.timeout_ms) || (args.timeout_ms as number) < 1
        || (args.timeout_ms as number) > MAX_TIMEOUT_MS) throw new Error("bridge_invalid_request");
    return deps.infer(args, { signal, requiredLocalBackend: backend });
}

/** One bounded UTF-8 JSON document, completed by closing stdin. */
export function readLocalBridgeInput(input: Readable, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []; let bytes = 0;
        const cleanup = () => {
            clearTimeout(timer); input.off("data", data); input.off("end", end); input.off("error", error);
            signal.removeEventListener("abort", abort);
        };
        const error = (reason: unknown) => { cleanup(); input.pause(); reject(reason); };
        const abort = () => error(new Error("bridge_cancelled"));
        const data = (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > MAX_INPUT_BYTES) { error(new Error("bridge_input_limit")); return; }
            chunks.push(buffer);
        };
        const end = () => {
            cleanup();
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
            catch { reject(new Error("bridge_invalid_json")); }
        };
        const timer = setTimeout(() => error(new Error("bridge_input_timeout")), READ_TIMEOUT_MS);
        input.on("data", data); input.once("end", end); input.once("error", error);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
    });
}

export async function runLocalBridgeCommand(): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on("SIGTERM", abort); process.on("SIGINT", abort);
    // Library diagnostics belong on stderr; stdout carries one protocol result.
    const log = console.log, info = console.info;
    console.log = console.info = (...args: unknown[]) => console.error(...args);
    try {
        const input = await readLocalBridgeInput(process.stdin, controller.signal);
        const result = await handleLocalBridge(input, controller.signal);
        process.stdout.write(JSON.stringify(result) + "\n");
    } catch (error) {
        process.stdout.write(JSON.stringify({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "bridge_failed" }] }) + "\n");
        process.exitCode = 1;
    } finally {
        console.log = log; console.info = info;
        process.off("SIGTERM", abort); process.off("SIGINT", abort);
    }
}
