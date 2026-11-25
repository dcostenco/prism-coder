import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getSetting } from "../storage/configStorage.js";
import { isLocalCodingModelId, type LocalCodingRole } from "./localCodingSettings.js";

// Separate from the strict v2 local settings and the v1 recommendation API.
// Old clients keep their contract and cannot interpret a cloud/host as local.
export const EXECUTION_ROLES_KEY = "execution_roles_v1";
export type ExecutionAssignment = { runtime: "auto" } | { runtime: "omlx" | "ollama"; model: string }
    | { runtime: "synalux" } | { runtime: "host"; profile: string };
export type ExecutionAssignments = Partial<Record<LocalCodingRole, ExecutionAssignment>>;
export interface HostProfile { id: string; provider: string; model: string; effort: string | null; status: "configured" }
const PROFILE_ID = /^[a-f0-9]{64}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HOST_PATH = /^(?:[a-z]:[\/]|(?:file|https?):)/i;
const safeModel = (v: unknown): v is string => isLocalCodingModelId(v)
    && !HOST_PATH.test(v) && !/^sk-/i.test(v);
export function parseExecutionAssignments(value: unknown): ExecutionAssignments {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("execution_assignment_invalid");
    const result: ExecutionAssignments = {};
    for (const [role, raw] of Object.entries(value)) {
        if ((role !== "coder" && role !== "reviewer") || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("execution_assignment_invalid");
        const v = raw as Record<string, unknown>;
        if (v.runtime === "auto" || v.runtime === "synalux") {
            if (Object.keys(v).length !== 1) throw new Error("execution_assignment_invalid");
            result[role] = { runtime: v.runtime };
        } else if ((v.runtime === "omlx" || v.runtime === "ollama") && Object.keys(v).length === 2 && isLocalCodingModelId(v.model)) {
            result[role] = { runtime: v.runtime, model: v.model };
        } else if (v.runtime === "host" && Object.keys(v).length === 2 && typeof v.profile === "string" && PROFILE_ID.test(v.profile)) {
            result[role] = { runtime: "host", profile: v.profile };
        } else throw new Error("execution_assignment_invalid");
    }
    return result;
}
export async function readExecutionAssignments(): Promise<ExecutionAssignments> {
    const raw = await getSetting(EXECUTION_ROLES_KEY, "", { fresh: true });
    return raw ? parseExecutionAssignments(JSON.parse(raw)) : {};
}
/** Trusted operator profiles only. Discovery never starts a CLI or reads credentials. */
export async function configuredHostProfiles(path = join(homedir(), ".prism-mcp", "local-code", "reviewers.json")): Promise<HostProfile[]> {
    let file;
    try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 65536 || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error("host_profiles_untrusted");
        const text = await file.readFile("utf8");
        if (Buffer.byteLength(text) > 65536) throw new Error("host_profiles_untrusted");
        const data = JSON.parse(text);
        if (data?.version !== 1 || !data.reviewers || typeof data.reviewers !== "object" || Array.isArray(data.reviewers)) throw new Error("host_profiles_invalid");
        const profiles: HostProfile[] = [];
        for (const v of Object.values(data.reviewers) as Record<string, unknown>[]) {
            if (!v || v.kind !== "host" || typeof v.provider !== "string" || !PROVIDER_ID.test(v.provider) || !safeModel(v.model)
                || (v.reasoning_effort !== undefined && (typeof v.reasoning_effort !== "string" || !PROVIDER_ID.test(v.reasoning_effort)))) continue;
            const identity = { provider: v.provider, model: v.model, effort: typeof v.reasoning_effort === "string" ? v.reasoning_effort : null };
            const id = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
            if (!profiles.some(p => p.id === id)) profiles.push({ id, ...identity, status: "configured" });
        }
        return profiles;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new Error("host_profiles_unavailable");
    } finally { await file?.close(); }
}
