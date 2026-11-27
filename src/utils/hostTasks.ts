/** Host-mediated execution. MCP can prepare tasks; only the host CLI enters execution. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, pbkdf2 } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PRISM_LOCAL_LLM_URL, PRISM_USER_ID } from "../config.js";
import { getSetting } from "../storage/configStorage.js";
import { readLocalCodingSettings } from "./localCodingSettings.js";
import { readLocalImageSettings } from "./localImageSettings.js";
import { configuredHostProfiles, readExecutionAssignments } from "./executionRoles.js";
import {
    checkHostTaskCapacity, checkHostTaskPending, createHostTaskId, createHostTaskRecord,
    consumeHostTaskRecord, validateHostTaskRecord,
    type HostTaskKind, type HostTaskRecord,
} from "./hostTaskRecords.js";

export const MAX_HOST_TASK_BYTES = 64 * 1024 * 1024;
const ENVIRONMENT_BINDING_ITERATIONS = 600_000;
const deriveEnvironmentDigest = promisify(pbkdf2);
let preparing = 0;
const mode = process.env.PRISM_HOST_TASKS;
const configPath = resolve(process.env.PRISM_CONFIG_PATH ?? resolve(homedir(), ".prism-mcp", "prism-config.db"));
const directory = resolve(process.env.PRISM_DATA_DIR ?? resolve(homedir(), ".prism-mcp"), "host-tasks");
const bootBinding = Object.fromEntries([
    "OMLX_BASE_URL", "OMLX_API_KEY", "OMLX_MODEL", "PRISM_LOCAL_CODING_BACKEND", "PRISM_OMLX_CLASSIFIER_MODEL",
    "PRISM_OMLX_CLASSIFIER_POLICY_FILE", "PRISM_OMLX_CLASSIFIER_POLICY_SHA256", "PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY",
].map(key => [key, process.env[key] ?? null]));
const extension = fileURLToPath(import.meta.url).endsWith(".ts") ? ".ts" : ".js";
const codeBinding = createHash("sha256");
for (const name of ["./hostTasks", "./hostTaskRecords", "../hostTaskCli", "../cli", "../tools/prismInferHandler",
    "../tools/queryMemoryNaturalHandler", "../tools/pipelineHandlers", "../darkfactory/promptRouting", "../darkfactory/clawInvocation"])
    codeBinding.update(name).update(readFileSync(new URL(name + extension, import.meta.url)));
const codeDigest = codeBinding.digest("hex");

export interface HostTaskPacket {
    record: HostTaskRecord;
    request: Record<string, unknown>;
    execution: Record<string, unknown>;
    metadata: Record<string, unknown>;
}
interface Execution { packet: HostTaskPacket; used: boolean }
const execution = new AsyncLocalStorage<Execution>();
export class HostAuthorizationError extends Error {
    readonly code = "host_authorization_required";
    constructor() { super("host_authorization_required: use prism_infer to prepare a task, then have the host review and execute its packet through the CLI"); this.name = "HostAuthorizationError"; }
}

export function hostTasksRequired(): boolean {
    if (mode === undefined || mode === "legacy") return false;
    if (mode !== "required") throw new Error("host_task_configuration_invalid");
    return true;
}

function canonical(value: unknown, depth = 0): string {
    if (depth > 100) throw new Error("host_task_too_deep");
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(item => canonical(item, depth + 1)).join(",") + "]";
    if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).filter(key => obj[key] !== undefined).sort();
        if (keys.some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("host_task_invalid_key");
        return "{" + keys.map(key => JSON.stringify(key) + ":" + canonical(obj[key], depth + 1)).join(",") + "}";
    }
    throw new Error("host_task_invalid_json");
}
export function snapshotHostTask<T>(value: T): T {
    const text = canonical(value);
    if (Buffer.byteLength(text, "utf8") > MAX_HOST_TASK_BYTES) throw new Error("host_task_too_large");
    return JSON.parse(text) as T;
}
export function hostTaskDigest(value: unknown): string {
    return createHash("sha256").update(canonical(value)).digest("hex");
}
function object(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
async function environmentDigest(id: string): Promise<string> {
    const stored = {
        signedOut: await getSetting("PRISM_SYNALUX_SIGNED_OUT", "", { fresh: true }),
        baseUrl: await getSetting("PRISM_SYNALUX_BASE_URL", "", { fresh: true }),
        legacyUrl: await getSetting("SYNALUX_BASE_URL", "", { fresh: true }),
        apiKey: await getSetting("PRISM_SYNALUX_API_KEY", "", { fresh: true }),
    };
    // Bind identity changes without serializing credentials into the packet.
    // Empty launcher values resolve through the same persisted profile.
    const account = { stored, effectiveKey: process.env.PRISM_SYNALUX_API_KEY?.trim() || stored.apiKey,
        effectiveUrl: process.env.PRISM_SYNALUX_BASE_URL?.trim() || process.env.SYNALUX_BASE_URL?.trim() || stored.baseUrl || stored.legacyUrl };
    const environment = canonical({ codeBinding: codeDigest, configPath, directory, user: PRISM_USER_ID, ollamaUrl: PRISM_LOCAL_LLM_URL,
        account, boot: bootBinding, coding: await readLocalCodingSettings(), images: await readLocalImageSettings(),
        executionRoles: await readExecutionAssignments(), hostProfiles: await configuredHostProfiles() });
    const key = await deriveEnvironmentDigest(environment, Buffer.from(id, "hex"), ENVIRONMENT_BINDING_ITERATIONS, 32, "sha256");
    return key.toString("hex");
}
function payload(packet: HostTaskPacket) {
    return { request: packet.request, execution: packet.execution, metadata: packet.metadata };
}

export async function prepareHostTask(kind: HostTaskKind, request: Record<string, unknown>,
    prepared: Record<string, unknown>, metadata: Record<string, unknown> = {}): Promise<HostTaskPacket> {
    if (!hostTasksRequired()) throw new Error("host_tasks_not_enabled");
    // Snapshot before any await: later caller mutation cannot retarget an approval.
    const task = snapshotHostTask({ request, execution: prepared, metadata });
    checkHostTaskCapacity({ directory }, preparing);
    preparing++;
    try {
        const id = createHostTaskId();
        const environment_sha256 = await environmentDigest(id);
        const record = createHostTaskRecord({ kind, request_sha256: hostTaskDigest(task.request),
            task_sha256: hostTaskDigest(task), environment_sha256 }, { directory, id });
        return { record, ...task };
    } finally { preparing--; }
}

export function hostTaskResponse(packet: HostTaskPacket) {
    const body = { status: "host_authorization_required", host_task: packet,
        message: "The host must review the entire frozen task, including history, system and evidence. Reserved or unresolved work stays with the host.",
        next_step: "Use the host terminal: prism local run --host-task <reviewed-packet.json> --approve. This packet expires and is single-use. Tool arguments cannot approve it." };
    return { content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body };
}

export function approvedHostTask(kind: HostTaskKind, request: unknown): HostTaskPacket | undefined {
    const active = execution.getStore();
    return active && !active.used && active.packet.record.kind === kind
        && active.packet.record.request_sha256 === hostTaskDigest(request) ? active.packet : undefined;
}

/** Only the exact frozen execution may enter a provider path, once. */
export function consumeHostExecution(kind: HostTaskKind, args: unknown): void {
    if (!hostTasksRequired()) return;
    const active = execution.getStore();
    if (!active || active.used || active.packet.record.kind !== kind
        || hostTaskDigest(args) !== hostTaskDigest(active.packet.execution)) throw new HostAuthorizationError();
    active.used = true;
}

/** Privileged host-side entrypoint. Never register this as an MCP or dashboard tool. */
export async function executeApprovedHostTask<T>(input: unknown,
    execute: (kind: HostTaskKind, request: Record<string, unknown>) => Promise<T>): Promise<T> {
    if (!hostTasksRequired()) throw new Error("host_tasks_not_enabled");
    const raw = snapshotHostTask(input);
    const packet = (object(raw) && Object.hasOwn(raw, "host_task") ? raw.host_task : raw) as HostTaskPacket;
    if (!object(packet) || Object.keys(packet).sort().join(",") !== "execution,metadata,record,request"
        || !object(packet.record) || !object(packet.request) || !object(packet.execution) || !object(packet.metadata)) throw new Error("host_task_invalid_packet");
    validateHostTaskRecord(packet.record);
    if (packet.record.request_sha256 !== hostTaskDigest(packet.request)
        || packet.record.task_sha256 !== hostTaskDigest(payload(packet))) throw new Error("host_task_binding_changed");
    try { checkHostTaskPending(packet.record, { directory }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("host_task_binding_changed");
        throw error;
    }
    if (packet.record.environment_sha256 !== await environmentDigest(packet.record.id)) throw new Error("host_task_binding_changed");
    // The OS-owned record, not a caller flag, establishes the prepared binding.
    // Claim before invoking any callback; a refused/failed task is still spent.
    consumeHostTaskRecord(packet.record, { directory });
    return execution.run({ packet, used: false }, () => execute(packet.record.kind, snapshotHostTask(packet.request)));
}
