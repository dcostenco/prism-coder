import { getSynaluxJwt } from "./synaluxJwt.js";
import { resolvePortalBaseUrl, usablePortalKey } from "./synaluxSearch.js";
import { isLocalCodingModelId, type LocalCodingRole } from "./localCodingSettings.js";

type Backend = "omlx" | "ollama";
const LOOKUP_MS = 750;
const MAX_RESPONSE_BYTES = 4096;
interface RecommendationOptions {
    baseUrl?: string;
    configured?: boolean;
    token?: () => Promise<string | null>;
    fetchImpl?: typeof fetch;
    deadlineMs?: number;
    signal?: AbortSignal;
}

/** Optional metadata-only hint. No prompt, history or device inventory is accepted. */
export async function localCodingRecommendation(backend: Backend, role: LocalCodingRole,
    options: RecommendationOptions = {}): Promise<string | undefined> {
    if ((backend !== "omlx" && backend !== "ollama") || (role !== "coder" && role !== "reviewer")) return undefined;
    const base = options.baseUrl ?? resolvePortalBaseUrl();
    if (!(options.configured ?? Boolean(usablePortalKey())) || !base || options.signal?.aborted) return undefined;
    let url: URL;
    try {
        const origin = new URL(base);
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
        if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && local)) || origin.username || origin.password
            || origin.search || origin.hash || !["", "/"].includes(origin.pathname)) return undefined;
        url = new URL("/api/v1/prism/local-model-recommendation", origin);
        url.searchParams.set("backend", backend);
        url.searchParams.set("role", role);
    } catch { return undefined; }
    const deadline = Math.min(Date.now() + LOOKUP_MS, options.deadlineMs ?? Infinity);
    if (deadline <= Date.now()) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finish!: (value: undefined) => void;
    const expired = new Promise<undefined>(resolve => { finish = resolve; });
    const abort = () => { controller.abort(); finish(undefined); };
    options.signal?.addEventListener("abort", abort, { once: true });
    const active = () => !controller.signal.aborted && Date.now() < deadline;
    const work = async (): Promise<string | undefined> => {
        if (!active()) return undefined;
        const jwt = await (options.token ?? getSynaluxJwt)();
        // The existing shared JWT exchange is not owned by this lookup.
        if (!active() || !jwt) return undefined;
        const response = await (options.fetchImpl ?? fetch)(url, { method: "GET", redirect: "error",
            headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" }, signal: controller.signal });
        if (!active() || !response.ok || !response.body) return undefined;
        const declared = response.headers.get("content-length");
        if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) return undefined;
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        try {
            for (;;) {
                if (!active()) return undefined;
                const part = await reader.read();
                if (!active()) return undefined;
                if (part.done) break;
                size += part.value.byteLength;
                if (size > MAX_RESPONSE_BYTES) return undefined;
                chunks.push(part.value);
            }
        } finally { void reader.cancel().catch(() => {}); }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!active() || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
        const data = value as Record<string, unknown>;
        if (Object.keys(data).length !== 4 || !["schema", "backend", "role", "model"].every(key => Object.hasOwn(data, key))
            || data.schema !== 1 || data.backend !== backend || data.role !== role
            || (data.model !== null && !isLocalCodingModelId(data.model))
            || (typeof data.model === "string" && data.model.includes(jwt))) return undefined;
        return data.model === null ? undefined : data.model as string;
    };
    try {
        timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
        return await Promise.race([work().catch(() => undefined), expired]);
    } finally {
        clearTimeout(timer); controller.abort();
        options.signal?.removeEventListener("abort", abort);
    }
}
