/**
 * Lane status through the real MCP server dispatch (drift-fix D-2a): the block reaches the host at
 * character 0 of a session_load_context result, and nowhere it does not belong. The portal is a
 * stubbed fetch serving the shared contract fixture; everything between the MCP client and that
 * fetch is the real server, handler and storage layer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ storage: null as unknown, settings: new Map<string, string>() }));
// The settings store is in memory here: autoload_projects never touches the user's real settings.
vi.mock("../src/storage/configStorage.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/storage/configStorage.js")>();
  return {
    ...actual,
    getSetting: vi.fn(async (key: string, fallback: string) => holder.settings.get(key) ?? fallback),
    setSetting: vi.fn(async (key: string, value: string) => { holder.settings.set(key, value); }),
  };
});
vi.mock("../src/storage/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/storage/index.js")>();
  return { ...actual, getStorage: vi.fn(async () => holder.storage) };
});

import { createServer } from "../src/server.js";
import { SynaluxStorage } from "../src/storage/synalux.js";
import { newLaneContext, decorateLaneRequest, laneCallContext, recordLaneBlock } from "../src/session/laneStatus.js";

const attach = JSON.parse(readFileSync(join(__dirname, "fixtures/prism-lane-attach-contract.json"), "utf8"));
const real = (block: string) => block.replace(/<n>/g, "100h").replace(/<mm-dd>/g, "11-25");
const CONTEXT = { project: "proj", last_summary: "earlier work", pending_todo: [], active_decisions: [], keywords: [], recent_sessions: [], session_history: [], version: 1 };
const BOUND_BLOCK = real(attach.bound.response.lane_block);
const portalBody = { status: "success", context: CONTEXT, lane_status: attach.bound.response.lane_status, lane_block: BOUND_BLOCK, lane_paths: attach.bound.response.lane_paths };

let fetchMock: ReturnType<typeof vi.fn>;
/** Routes by URL: the portal's memory API answers `body`; skill content is empty; anything else is the JWT exchange. */
function portal(body: unknown) {
  fetchMock = vi.fn(async (url: string) => {
    const target = String(url);
    if (target.includes("/api/v1/prism/memory")) return new Response(JSON.stringify(body));
    if (target.includes("/api/v1/prism/resolve")) return new Response(JSON.stringify({ loaded: [], skills: [], user_local: [] }));
    if (target.includes("/skills/")) return new Response(JSON.stringify({ skills: {} }));
    return new Response(JSON.stringify({ status: "success", jwt: "jwt", expires_in: 900 }));
  });
  vi.stubGlobal("fetch", fetchMock);
}
beforeEach(() => {
  vi.stubEnv("PRISM_SYNALUX_BASE_URL", "https://portal.test");
  vi.stubEnv("PRISM_SYNALUX_API_KEY", "synalux_sk_<fixture>");
  portal(portalBody);
  vi.stubGlobal("fetch", fetchMock);
  holder.storage = new SynaluxStorage();
  holder.settings.clear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function callTool(name: string, args: Record<string, unknown>, clientName = "lane-dispatch") {
  const server = createServer();
  const client = new Client({ name: clientName, version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await client.callTool({ name, arguments: args });
  } finally { await client.close(); await server.close(); }
}
const portalRequests = () => fetchMock.mock.calls.map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : {})).filter(body => body.action);
const firstText = (reply: { content?: unknown }) => ((reply.content as Array<{ type: string; text: string }>)[0]).text;

describe("session_load_context through the real server", () => {
  it("starts with the lane block at character 0, and the portal request carried conversation, program and host", async () => {
    const reply = await callTool("session_load_context", { project: "proj", level: "quick", conversation_id: "conv-wire", program: "alpha" });
    expect(reply.isError, firstText(reply)).not.toBe(true);
    expect(firstText(reply).startsWith(BOUND_BLOCK)).toBe(true);
    const load = portalRequests().find(body => body.action === "load_context");
    expect(load).toMatchObject({ project: "proj", conversation_id: "conv-wire", program: "alpha", host: "lane-dispatch" });
  });

  it("a load that names no program and no conversation sends neither", async () => {
    await callTool("session_load_context", { project: "proj", level: "quick" });
    const load = portalRequests().find(body => body.action === "load_context")!;
    expect(load).not.toHaveProperty("program");
    expect(load).not.toHaveProperty("conversation_id");
  });

  it("a portal with no lane fields leaves the result untouched", async () => {
    portal({ status: "success", context: CONTEXT });
    const reply = await callTool("session_load_context", { project: "proj", level: "quick", conversation_id: "conv-1" });
    expect(firstText(reply)).not.toContain("Lane status");
    expect(firstText(reply)).not.toContain("Lane register unavailable");
  });
});

describe("the conversation id is sent verbatim", () => {
  it("a padded id is not trimmed: the portal looks it up exactly as save_ledger stored it", async () => {
    await callTool("session_load_context", { project: "proj", level: "quick", conversation_id: " conv-pad " });
    expect(portalRequests().find(body => body.action === "load_context")).toMatchObject({ conversation_id: " conv-pad " });
  });
  it("an id the portal would reject (over 255 characters) is left off the request", async () => {
    await callTool("session_load_context", { project: "proj", level: "quick", conversation_id: "x".repeat(256) });
    expect(portalRequests().find(body => body.action === "load_context")).not.toHaveProperty("conversation_id");
  });
});

describe("the host sent with a lane request", () => {
  it("is the MCP client's own name", async () => {
    await callTool("session_load_context", { project: "proj", level: "quick", conversation_id: "c" }, "claude-code");
    expect(portalRequests().find(body => body.action === "load_context")).toMatchObject({ host: "claude-code" });
  });
  it("falls back to prism-mcp for a name that is not a plain label", async () => {
    await callTool("session_load_context", { project: "proj", level: "quick", conversation_id: "c" }, "x".repeat(60));
    expect(portalRequests().find(body => body.action === "load_context")).toMatchObject({ host: "prism-mcp" });
  });
});

describe("each lane tool through the real server", () => {
  const load = (conversation: string) => callTool("session_load_context", { project: "proj", level: "quick", conversation_id: conversation });

  it("session_detect_drift sends the conversation id and host, starts with the block, and does not repeat the raw lane fields", async () => {
    const reply = await callTool("session_detect_drift", { project: "proj", goal: "keep the plan", conversation_id: "conv-d" }, "claude-code");
    expect(portalRequests().find(body => body.action === "detect_drift")).toMatchObject({ project: "proj", goal: "keep the plan", conversation_id: "conv-d", host: "claude-code" });
    const text = firstText(reply);
    expect(text.startsWith(BOUND_BLOCK)).toBe(true);
    const json = text.slice(BOUND_BLOCK.length);
    expect(JSON.parse(json)).toEqual({ status: "success", context: CONTEXT }); // the answer itself is still there, minus the raw lane fields
    expect(json).not.toContain("lane_block");
    expect(json).not.toContain("lane_status");
    expect(json).not.toContain("lane_paths");
  });

  it("session_save_ledger starts with the block and carries the conversation id and host", async () => {
    await load("conv-l");
    fetchMock.mockClear();
    const reply = await callTool("session_save_ledger", { project: "proj", conversation_id: "conv-l", summary: "implemented the lane block and its tests" }, "claude-code");
    expect(reply.isError, firstText(reply)).not.toBe(true);
    expect(firstText(reply).startsWith(BOUND_BLOCK)).toBe(true);
    expect(portalRequests().find(body => body.action === "save_ledger")).toMatchObject({ conversation_id: "conv-l", host: "claude-code" });
  });

  it("session_save_handoff starts with the block and carries the conversation id and host", async () => {
    await load("conv-h");
    portal({ status: "success", result: { status: "updated", version: 2 }, lane_status: attach.bound.response.lane_status, lane_block: BOUND_BLOCK });
    const reply = await callTool("session_save_handoff", { project: "proj", conversation_id: "conv-h", last_summary: "did the thing", expected_version: 1 }, "claude-code");
    expect(reply.isError, firstText(reply)).not.toBe(true);
    expect(firstText(reply).startsWith(BOUND_BLOCK)).toBe(true);
    expect(portalRequests().find(body => body.action === "save_handoff")).toMatchObject({ conversation_id: "conv-h", host: "claude-code" });
  });
});

describe("session_bootstrap", () => {
  it("starts with the lane block at character 0", async () => {
    holder.settings.set("autoload_projects", "proj");
    const reply = await callTool("session_bootstrap", { prompt: "hello" });
    expect(firstText(reply).startsWith(BOUND_BLOCK)).toBe(true);
  });

  it("sends the id it prints even when the supplied one was padded: a trimmed id, so the portal can bind it", async () => {
    holder.settings.set("autoload_projects", "proj");
    const reply = await callTool("session_bootstrap", { prompt: "hello", conversation_id: " conv-pad ", program: "alpha" });
    expect(firstText(reply)).toContain("conv-pad");
    const loads = portalRequests().filter(body => body.action === "load_context");
    expect(loads.length).toBeGreaterThan(0);
    for (const request of loads) expect(request.conversation_id).toBe("conv-pad");
  });

  it("leaves a supplied id the portal would reject (over 255 characters) off the lane requests", async () => {
    holder.settings.set("autoload_projects", "proj");
    await callTool("session_bootstrap", { prompt: "hello", conversation_id: "x".repeat(300) });
    const loads = portalRequests().filter(body => body.action === "load_context");
    expect(loads.length).toBeGreaterThan(0); // it did load: the loop below checks something
    for (const request of loads) expect(request).not.toHaveProperty("conversation_id");
  });

  it("sends its own conversation id on the lane requests it makes, the same one it prints", async () => {
    holder.settings.set("autoload_projects", "proj");
    const reply = await callTool("session_bootstrap", { prompt: "hello" });
    const text = firstText(reply);
    const printed = /conversation_id="?([A-Za-z0-9_-]+)/.exec(text)?.[1];
    expect(printed, text.slice(0, 300)).toBeTruthy();
    const loads = portalRequests().filter(body => body.action === "load_context");
    expect(loads.length).toBeGreaterThan(0);
    for (const load of loads) expect(load.conversation_id).toBe(printed);
  });
});

describe("a result with no portal request, or an error, never carries a block", () => {
  it("a refused session_save_ledger (context not loaded) is an error with no block", async () => {
    const reply = await callTool("session_save_ledger", { project: "proj", summary: "work that was done", conversation_id: "never-loaded" });
    expect(reply.isError).toBe(true);
    expect(firstText(reply)).not.toContain("Lane status");
    expect(portalRequests().filter(body => body.action === "save_ledger")).toEqual([]);
  });
});

describe("through dispatch, another tool that saves to the ledger sends no lane fields and gets no block", () => {
  it("session_save_experience (it calls saveLedger inside) is left alone", async () => {
    const reply = await callTool("session_save_experience", {
      project: "proj", event_type: "success", context: "tried a thing", action: "did it", outcome: "worked", conversation_id: "conv-x",
    });
    expect(firstText(reply)).not.toContain("Lane status");
    for (const body of portalRequests()) {
      expect(body, JSON.stringify(body).slice(0, 80)).not.toHaveProperty("host");
    }
    // The save really went to the portal (otherwise the loop above checks nothing).
    expect(portalRequests().some(body => body.action === "save_ledger")).toBe(true);
  });
});

describe("tools outside the five lane tools are left alone (design D3)", () => {
  it("a context for another tool adds nothing to a request, records nothing, and prepends nothing", () => {
    // prism_infer, memory_checkout, session_export_memory and others call loadContext or saveLedger inside.
    for (const tool of ["prism_infer", "memory_checkout", "session_export_memory", "session_search_memory", "knowledge_ingest"]) {
      const ctx = newLaneContext({ project: "proj", conversation_id: "conv-1", program: "alpha" }, tool);
      expect(ctx.enabled, tool).toBe(false);
      laneCallContext.run(ctx, () => {
        expect(decorateLaneRequest({ action: "load_context", project: "proj" }), tool).toEqual({ action: "load_context", project: "proj" });
        recordLaneBlock("proj", "load_context", { lane_status: { program: "alpha" }, lane_block: "a block" });
      });
      expect(ctx.blocks, tool).toEqual([]); // nothing recorded for it, so the server has nothing to prepend
    }
    for (const tool of ["session_load_context", "session_bootstrap", "session_save_ledger", "session_save_handoff", "session_detect_drift"]) {
      expect(newLaneContext({}, tool).enabled, tool).toBe(true);
    }
  });
});
