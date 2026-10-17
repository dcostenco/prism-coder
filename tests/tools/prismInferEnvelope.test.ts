import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InferDeps, PrismInferResult } from "../../src/tools/prismInferHandler.js";

const injected = vi.hoisted(() => ({ deps: undefined as InferDeps | undefined }));
vi.mock("../../src/tools/prismInferHandler.js", async importOriginal => {
    const actual = await importOriginal<typeof import("../../src/tools/prismInferHandler.js")>();
    return { ...actual, prismInferHandler: (args: unknown) => {
        if (!injected.deps) throw new Error("Envelope test requires injected inference dependencies");
        return actual.prismInferHandler(args, injected.deps);
    } };
});

import { createServer } from "../../src/server.js";
import { inferStructuredResult } from "../../src/tools/prismInferHandler.js";
import { FREE_ENTITLEMENTS } from "../../src/utils/entitlements.js";
import { OmlxError } from "../../src/utils/omlxProvider.js";

const MODEL = "Qwen3.8-Flash-Next-oQ8e-mtp";
const OUTPUT = "def identity(value):\n    return value\n";
const REQUEST = { prompt: "Draft a Python identity helper.", local_backend: "omlx", local_model: MODEL,
    mode: "code", cloud_fallback: false, escalation: "report", verify: false };

beforeEach(() => {
    injected.deps = {
        entitlements: { ...FREE_ENTITLEMENTS, source: "unconfigured" },
        freemem: () => 30 * 1024 ** 3,
        listTags: vi.fn(async () => new Set(["prism-coder:4b"])),
        listLoaded: vi.fn(async () => new Set()),
        callLayer1: vi.fn(async () => "OBVIOUS_NOT_RESERVED"),
        classifierInputPolicy: async () => null,
        callLocal: vi.fn(async () => { throw new Error("Unexpected Ollama generation"); }),
        callCloud: vi.fn(async () => { throw new Error("Unexpected cloud generation"); }),
        ollamaUrl: "http://127.0.0.1:11434",
        omlx: {
            detect: vi.fn(async () => ({ url: "http://127.0.0.1:8000/v1", model: MODEL, contextTokens: 65536 })),
            acquire: vi.fn(async () => async () => {}),
            listLoaded: vi.fn(async () => new Set()),
            unload: vi.fn(async () => { throw new Error("Unexpected model unload"); }),
            generate: vi.fn(async () => ({ ok: true, text: OUTPUT, doneReason: "stop", promptTokens: 31, completionTokens: 12 })),
        },
    };
});

async function throughMcp(args: Record<string, unknown>) {
    const server = createServer();
    const client = new Client({ name: "infer-envelope-regression", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const tools = await client.listTools();
        const tool = tools.tools.find(tool => tool.name === "prism_infer");
        expect(tool?.outputSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["output", "backend", "model_picked", "used_cloud"]) });
        // The SDK validates structuredContent against the advertised output schema.
        return await client.callTool({ name: "prism_infer", arguments: args });
    } finally { await client.close(); await server.close(); }
}

describe("prism_infer public result over the real MCP server dispatch", () => {
    it("exposes success metadata without parsing the unchanged human text blocks", async () => {
        const reply = await throughMcp(REQUEST);
        expect(reply.structuredContent).toMatchObject({ output: OUTPUT, backend: "omlx", model_picked: MODEL,
            used_cloud: false, prompt_tokens: 31, completion_tokens: 12, history_turns: 0,
            entitlements_source: "unconfigured", gate_outcome: { status: "success", served_anyway: false } });
        expect(reply.content).toEqual([
            { type: "text", text: expect.stringContaining("[prism_infer] backend=omlx") },
            { type: "text", text: OUTPUT },
        ]);
        expect(injected.deps!.omlx!.unload).not.toHaveBeenCalled();
        expect(injected.deps!.callLocal).not.toHaveBeenCalled(); expect(injected.deps!.callCloud).not.toHaveBeenCalled();
    });
    it("exposes a safe structured detection refusal, with no generation or unload", async () => {
        injected.deps!.omlx!.detect = vi.fn(async () => { throw new OmlxError("omlx_model_not_advertised"); });
        const reply = await throughMcp(REQUEST);
        expect(reply.structuredContent).toMatchObject({ backend: "refused", output: "", model_picked: null,
            used_cloud: false, gate_outcome: { status: "refused", reason: "omlx_model_not_advertised", served_anyway: false } });
        expect(reply.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("backend=refused") });
        expect(reply.content[1]).toEqual({ type: "text", text: "" });
        expect(injected.deps!.omlx!.generate).not.toHaveBeenCalled(); expect(injected.deps!.omlx!.unload).not.toHaveBeenCalled();
    });
    it("preserves next_step in both the machine result and existing human guidance", async () => {
        const reply = await throughMcp({ ...REQUEST, messages: [{ role: "user", content: "Draft the helper." }] });
        expect(reply.structuredContent).toMatchObject({ backend: "refused", output: "", history_turns: 1,
            gate_outcome: { status: "refused", reason: "multi_turn_not_in_plan" },
            next_step: expect.stringContaining("Sign in with a free Synalux account") });
        expect(reply.content[2]).toEqual({ type: "text", text: `Next step: ${reply.structuredContent!.next_step}` });
        expect(injected.deps!.omlx!.detect).not.toHaveBeenCalled();
    });
    it("keeps infrastructure errors as error text instead of fabricating structured success", async () => {
        injected.deps!.omlx!.generate = vi.fn(async () => ({ ok: false, reason: "omlx_http_507" }));
        const reply = await throughMcp(REQUEST);
        expect(reply.isError).toBe(true); expect(reply.structuredContent).toBeUndefined();
        expect(reply.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("omlx_http_507") });
    });
    it("never projects authentication targets, verifier internals, or unchecked route drafts", () => {
        const planted = "synthetic-auth-must-never-leave-the-runtime";
        const result = {
            output: "safe draft", backend: "omlx", model_picked: MODEL, used_cloud: false, ram_free_mb: 30000, latency_ms: 12,
            attempts: [{ tier: "omlx", reason: "authenticated_model_detected", apiKey: planted }],
            gate_outcome: { status: "success", served_anyway: false, authTarget: { apiKey: planted } },
            runtimeTarget: { apiKey: planted },
            verification: { action: "allow", verifierChain: [{ apiKey: planted }] },
            route_guard: { source: "local", action: "preserved", output: "unchecked route draft", apiKey: planted },
        } as unknown as PrismInferResult;
        const structured = inferStructuredResult(result);
        expect(structured).toMatchObject({ output: "safe draft", gate_outcome: { status: "success", served_anyway: false }, verification: { action: "allow" } });
        const serialized = JSON.stringify(structured);
        expect(serialized).not.toContain(planted); expect(serialized).not.toContain("runtimeTarget");
        expect(serialized).not.toContain("verifierChain"); expect(serialized).not.toContain("unchecked route draft");
    });
});
