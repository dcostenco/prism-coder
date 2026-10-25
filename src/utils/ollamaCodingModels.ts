import { PRISM_LOCAL_LLM_URL } from "../config.js";
import { isLocalCodingModelId } from "./localCodingSettings.js";
import type { ModelChoice } from "./modelPicker.js";
import { advertisedImageCapability, type LocalImageModelObservation } from "./localImageModels.js";

const GIB = 1024 ** 3;
const MAX_MODELS = 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const CODING_CONTEXT_LIMIT = 4096;
export interface LocalCodingModelObservation {
    id: string;
    weightBytes?: number;
    loadedBytes?: number;
    loaded: boolean;
    contextTokens?: number;
}
export interface LocalModelProbeOptions { deadlineMs?: number; signal?: AbortSignal }
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Read-only metadata probes; never pulls or loads a model. */
async function metadata(url: string, fetchImpl: typeof fetch, model?: string, options: LocalModelProbeOptions = {}): Promise<Record<string, any>> {
    const check = () => { if (options.signal?.aborted || (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs)) throw new Error("ollama_model_probe_deadline"); };
    check();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadlineFired = false;
    const work = async () => {
        try {
            check();
            signal.throwIfAborted();
            response = await fetchImpl(url, { ...(model === undefined ? {} : {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }),
            }), redirect: "error", signal });
            check();
            signal.throwIfAborted();
            if (!response.ok || !response.body) throw new Error("ollama_model_metadata_unavailable");
            reader = response.body.getReader();
            const chunks: Uint8Array[] = []; let size = 0;
            for (;;) {
                check();
                const part = await reader.read();
                check();
                signal.throwIfAborted();
                if (part.done) break;
                size += part.value.byteLength;
                if (size > MAX_METADATA_BYTES) throw new Error("ollama_model_metadata_invalid");
                chunks.push(part.value);
            }
            const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            check();
            signal.throwIfAborted();
            if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("ollama_model_metadata_invalid");
            return data as Record<string, any>;
        } finally {
            if (reader) void reader.cancel().catch(() => {});
            else void response?.body?.cancel().catch(() => {});
        }
    };
    let onAbort: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
            void reader?.cancel().catch(() => {});
            if (deadlineFired) { reject(new Error("ollama_model_probe_deadline")); return; }
            try { check(); } catch (error) { reject(error); return; }
            reject(new Error("ollama_model_metadata_unavailable"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
    try {
        const remaining = options.deadlineMs === undefined ? Infinity : options.deadlineMs - Date.now();
        const deadlineBound = remaining <= 3000;
        const timeout = Math.min(3000, Math.max(1, Math.ceil(remaining)));
        timer = setTimeout(() => { deadlineFired = deadlineBound; controller.abort(); }, timeout);
        return await Promise.race([work(), aborted]);
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort!);
        controller.abort();
    }
}

/** At most two concurrent inventory probes then one exact selected-ID show.
 * No cache: every refresh observes the current server, even after model replacement. */
export async function inspectOllamaImageModels(selectedId?: string, url = PRISM_LOCAL_LLM_URL,
    fetchImpl: typeof fetch = fetch): Promise<LocalImageModelObservation[]> {
    if (selectedId !== undefined && !isLocalCodingModelId(selectedId)) throw new Error("ollama_model_id_invalid");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
        const [tags, ps] = await Promise.all([metadata(`${url}/api/tags`, fetchImpl, undefined, { signal: controller.signal }),
            metadata(`${url}/api/ps`, fetchImpl, undefined, { signal: controller.signal })]);
        if (!Array.isArray(tags.models) || tags.models.length > MAX_MODELS || !Array.isArray(ps.models) || ps.models.length > MAX_MODELS) throw new Error("ollama_model_inventory_invalid");
        const ids = new Set<string>();
        const models: LocalImageModelObservation[] = tags.models.map((entry: any) => {
            if (!entry || !isLocalCodingModelId(entry.name) || ids.has(entry.name)) throw new Error("ollama_model_inventory_invalid");
            ids.add(entry.name);
            const loaded = ps.models.find((row: any) => row && (row.name === entry.name || row.model === entry.name));
            return { id: entry.name, loaded: Boolean(loaded), capability: advertisedImageCapability("ollama", {}),
                ...(positive(entry.size) ? { weightBytes: entry.size } : {}),
                ...(positive(loaded?.size_vram) ? { loadedBytes: loaded.size_vram } : {}) };
        });
        const selected = models.find(model => model.id === selectedId);
        if (selected) {
            try { selected.capability = advertisedImageCapability("ollama", await metadata(`${url}/api/show`, fetchImpl, selected.id, { signal: controller.signal })); }
            catch { /* Exact model remains installed; failed capability inspection stays unknown. */ }
        }
        return models;
    } finally { clearTimeout(timer); controller.abort(); }
}

export async function inspectOllamaCodingModels(url = PRISM_LOCAL_LLM_URL, fetchImpl: typeof fetch = fetch, options: LocalModelProbeOptions = {}): Promise<LocalCodingModelObservation[]> {
    const [tags, ps] = await Promise.all([metadata(`${url}/api/tags`, fetchImpl, undefined, options), metadata(`${url}/api/ps`, fetchImpl, undefined, options)]);
    if (!Array.isArray(tags.models) || tags.models.length > MAX_MODELS || !Array.isArray(ps.models) || ps.models.length > MAX_MODELS) throw new Error("ollama_model_inventory_invalid");
    const ids = new Set<string>();
    return tags.models.map((model: any) => {
        if (!model || !isLocalCodingModelId(model.name) || ids.has(model.name)) throw new Error("ollama_model_inventory_invalid");
        ids.add(model.name);
        const loaded = ps.models.find((entry: any) => entry && (entry.name === model.name || entry.model === model.name));
        return { id: model.name, loaded: Boolean(loaded),
            ...(positive(model.size) ? { weightBytes: model.size } : {}),
            ...(positive(loaded?.size_vram) ? { loadedBytes: loaded.size_vram } : {}),
            ...(positive(loaded?.context_length) ? { contextTokens: loaded.context_length } : {}) };
    });
}

/** A selected model gets one exact attempt, not a walk through named tiers.
 * Sizes plus overhead are an estimate, not a guarantee about peak RAM. */
export async function selectedOllamaCodingModel(url: string, id: string, ceiling: string,
    fetchImpl: typeof fetch = fetch, options: LocalModelProbeOptions = {}): Promise<ModelChoice> {
    if (!isLocalCodingModelId(id)) throw new Error("ollama_model_id_invalid");
    const models = await inspectOllamaCodingModels(url, fetchImpl, options);
    const selected = models.find(model => model.id === id);
    if (!selected) throw new Error("ollama_model_not_installed");
    const show = await metadata(`${url}/api/show`, fetchImpl, id, options);
    const info = show.model_info;
    const params = info?.["general.parameter_count"];
    const architecture = info?.["general.architecture"];
    const nativeContext = typeof architecture === "string" ? info?.[`${architecture}.context_length`] : undefined;
    if (!selected.weightBytes || !positive(params) || !positive(nativeContext)
        || !Array.isArray(show.capabilities) || !show.capabilities.includes("completion")) throw new Error("ollama_model_metadata_incomplete");
    // Entitlement tiers name nominal billions, not exact tensor counts.
    // Rounding admits e.g. 27.4B as 27B without making the top tier unlimited.
    const maxBillions = /^(2|4|9|27)b$/.test(ceiling) ? Number(ceiling.slice(0, -1)) : 0;
    if (!maxBillions || Math.round(params / 1e9) > maxBillions) throw new Error("ollama_model_ceiling");
    const ctxTokens = Math.min(nativeContext, CODING_CONTEXT_LIMIT);
    const layers = info[`${architecture}.block_count`], heads = info[`${architecture}.attention.head_count_kv`];
    const embedding = info[`${architecture}.embedding_length`], attentionHeads = info[`${architecture}.attention.head_count`];
    if (![layers, heads, embedding, attentionHeads].every(positive)) throw new Error("ollama_model_memory_unknown");
    const rawKeyLength = info[`${architecture}.attention.key_length`], rawValueLength = info[`${architecture}.attention.value_length`];
    if ((rawKeyLength !== undefined && !positive(rawKeyLength)) || (rawValueLength !== undefined && !positive(rawValueLength))) throw new Error("ollama_model_memory_unknown");
    // Some architectures declare independent K/V dimensions. Never shrink the
    // fp16 estimate below either the declared or the derived head dimension.
    const derivedHead = embedding / attentionHeads;
    const keyLength = Math.max(derivedHead, rawKeyLength ?? derivedHead), valueLength = Math.max(derivedHead, rawValueLength ?? derivedHead);
    const kvBytes = layers * heads * (keyLength + valueLength) * ctxTokens * 2;
    const requiredBytes = Math.max(selected.weightBytes * 1.5, selected.weightBytes + kvBytes + 2 * GIB);
    if (!Number.isFinite(requiredBytes) || requiredBytes <= 0) throw new Error("ollama_model_memory_unknown");
    return { tag: id, weightsGb: selected.weightBytes / GIB, minFreeGb: requiredBytes / GIB, ctxTokens,
        prefersThinking: show.capabilities.includes("thinking") };
}
