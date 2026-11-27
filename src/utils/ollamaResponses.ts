const DEFAULT_REGISTRY = "registry.ollama.ai";
const DEFAULT_NAMESPACE = "library";
const MODEL_PART = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,79}$/;
const NAMESPACE_PART = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$/;
const REGISTRY_PART = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?::[0-9]{1,5})?$/;

/** Shortest Ollama name with defaults made explicit where needed for comparison. */
export function canonicalOllamaName(value: unknown): string | null {
    if (typeof value !== "string" || value !== value.trim()) return null;
    const parts = value.split("/");
    if (parts.length > 3) return null;
    const [model, tag = "latest", extra] = parts.pop()!.split(":");
    const namespace = parts.pop() ?? DEFAULT_NAMESPACE;
    const registry = parts.pop() ?? DEFAULT_REGISTRY;
    if (extra !== undefined || !MODEL_PART.test(model) || !MODEL_PART.test(tag) || !NAMESPACE_PART.test(namespace)) return null;
    if (registry.length > 350 || !REGISTRY_PART.test(registry)) return null;
    const port = registry.split(":")[1];
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
    const host = registry.toLowerCase();
    const scope = namespace.toLowerCase();
    const id = `${model}:${tag}`.toLowerCase();
    if (host !== DEFAULT_REGISTRY) return `${host}/${scope}/${id}`;
    return scope === DEFAULT_NAMESPACE ? id : `${scope}/${id}`;
}

/** Validate the evidence common to non-streaming classifier and generator replies. */
export function isCompleteOllamaChatResponse(data: unknown, requestedModel: string): boolean {
    if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
    const reply = data as {
        done?: unknown; done_reason?: unknown; error?: unknown; model?: unknown;
        message?: { content?: unknown; role?: unknown };
    };
    if (reply.done !== true || reply.error !== undefined || (reply.done_reason !== undefined && reply.done_reason !== "stop")) return false;
    if (typeof reply.message?.content !== "string" || (reply.message.role !== undefined && reply.message.role !== "assistant")) return false;
    if (reply.model === undefined) return true;
    const model = canonicalOllamaName(reply.model);
    return model !== null && model === canonicalOllamaName(requestedModel);
}
