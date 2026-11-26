/**
 * Lane status on the client (drift-fix slice D-2a): the block the portal attaches to load_context,
 * save_ledger, save_handoff and detect_drift reaches the host at character 0, and nothing else about
 * a tool result changes. Neutral names throughout: the fixtures are shared byte for byte with the
 * portal's tests, which assert the same SHA-256 digests.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import wire from "./fixtures/prism-lane-wire-contract.json" with { type: "json" };

vi.mock("../src/storage/index.js", () => ({ getStorage: vi.fn() }));

import { SynaluxStorage } from "../src/storage/synalux.js";
import { getStorage } from "../src/storage/index.js";
import { sessionSetProgramRegisterHandler } from "../src/tools/registerHandler.js";
import {
  LANE_BLOCK_MAX, cleanBlock, laneBlockFrom, laneCallContext, laneTextFor, newLaneContext, prependLaneBlock, recordLaneBlock,
  type LaneCallContext,
} from "../src/session/laneStatus.js";

const FIXTURES = join(__dirname, "fixtures");
const WIRE_SHA256 = "60169384b0abdc749d538f3f501f0de43652bff95e8396b12b7d00665c259e78";
const ATTACH_SHA256 = "a2a14d44d84d3b2d5f5e4ced196c6547cd21237d742956c434d62e80546c7bd0";
const sha = (file: string) => createHash("sha256").update(readFileSync(join(FIXTURES, file))).digest("hex");
const attach = JSON.parse(readFileSync(join(FIXTURES, "prism-lane-attach-contract.json"), "utf8"));

const BASE = "https://portal.test";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/** A SynaluxStorage over a portal that answers each request with the next response (after the JWT exchange). */
function portal(...responses: Array<unknown | { status: number; body: unknown }>) {
  vi.stubEnv("PRISM_SYNALUX_BASE_URL", BASE);
  vi.stubEnv("PRISM_SYNALUX_API_KEY", "synalux_sk_<fixture>");
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ status: "success", jwt: "jwt", expires_in: 900 })));
  for (const r of responses) {
    const wrapped = r && typeof r === "object" && "status" in (r as object) && "body" in (r as object) && typeof (r as { status: unknown }).status === "number"
      ? r as { status: number; body: unknown } : { status: 200, body: r };
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(wrapped.body), { status: wrapped.status }));
  }
  vi.stubGlobal("fetch", fetch);
  return { storage: new SynaluxStorage(), fetch };
}
const requests = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.slice(1).map(([, init]) => JSON.parse((init as { body: string }).body));
const inCall = <T>(args: unknown, fn: (ctx: LaneCallContext) => Promise<T>) => { const ctx = newLaneContext(args); return laneCallContext.run(ctx, () => fn(ctx)); };
const result = (text: string) => ({ content: [{ type: "text" as const, text }] });

describe("the shared fixtures", () => {
  it("are byte for byte the ones the portal asserts, with neutral names", () => {
    expect(sha("prism-lane-wire-contract.json")).toBe(WIRE_SHA256);
    expect(sha("prism-lane-attach-contract.json")).toBe(ATTACH_SHA256);
    // Public repository: assert what the fixtures DO contain (neutral names only), never list private ones.
    const NEUTRAL = /^(alpha|beta|proj|[abc]|host-x|conv-[\w-]+|no-programs|not valid)$/;
    for (const file of ["prism-lane-wire-contract.json", "prism-lane-attach-contract.json"]) {
      const names = [...readFileSync(join(FIXTURES, file), "utf8").matchAll(/"(program|project|id|host|conversation_id)": "([^"]+)"/g)].map(m => m[2]);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name, `${file}: ${name}`).toMatch(NEUTRAL);
    }
  });
});

describe("the request: conversation, program and host travel with the four lane actions", () => {
  it("save_ledger, save_handoff, load_context and detect_drift carry the call's conversation_id and host; a load carries the program", async () => {
    const { storage, fetch } = portal({ status: "success" }, { status: "success", result: { status: "updated", version: 1 } },
      { status: "success", context: { last_summary: "x" } }, { status: "success" });
    await inCall({ conversation_id: "conv-1", program: "alpha" }, async () => {
      await storage.saveLedger({ project: "proj", summary: "s" } as never);
      await storage.saveHandoff({ project: "proj", last_summary: "s" } as never);
      await storage.loadContext("proj", "quick", "u");
      await storage.detectDrift("proj", "goal");
    });
    const [ledger, handoff, load, drift] = requests(fetch);
    for (const body of [ledger, handoff, load, drift]) expect(body).toMatchObject({ conversation_id: "conv-1", host: "prism-mcp" });
    expect(load.program).toBe("alpha");
    expect(ledger.program).toBeUndefined();
    expect(drift.program).toBeUndefined();
  });

  it("an explicit conversation_id on the entry wins, and a call with no context sends exactly what it always sent", async () => {
    const { storage, fetch } = portal({ status: "success" }, { status: "success" });
    await inCall({ conversation_id: "from-args" }, () => storage.saveLedger({ project: "proj", summary: "s", conversation_id: "entry-conv" } as never));
    await storage.saveLedger({ project: "proj", summary: "s" } as never);
    const [withContext, without] = requests(fetch);
    expect(withContext.conversation_id).toBe("entry-conv");
    expect(without).not.toHaveProperty("host");
    expect(without).not.toHaveProperty("program");
  });

  it("two conversations loading the same project never share one in-flight request", async () => {
    const { storage, fetch } = portal({ status: "success", context: { last_summary: "one" } }, { status: "success", context: { last_summary: "two" } });
    await Promise.all([
      inCall({ conversation_id: "conv-a" }, () => storage.loadContext("proj", "quick", "u")),
      inCall({ conversation_id: "conv-b" }, () => storage.loadContext("proj", "quick", "u")),
    ]);
    expect(requests(fetch).map(body => body.conversation_id).sort()).toEqual(["conv-a", "conv-b"]);
  });

  it("an invalid program name is never sent", () => {
    expect(newLaneContext({ program: "bad name!" }).program).toBeUndefined();
    expect(newLaneContext({ program: "alpha" }).program).toBe("alpha");
  });
});

describe("the block at character 0 (T4, T5 client half), from the shared contract", () => {
  const cases: Array<[string, { action: string; response: Record<string, unknown> }, RegExp | null]> = [
    ["a bound conversation", attach.bound, /^Lane status \(alpha, register v1\):\na STALLED /],
    ["an unbound conversation", attach.unbound, /^Lane status \(proj, no program named\):\n\[alpha\] a STALLED /],
    ["an unavailable register", attach.unavailable, /^Lane register unavailable\n/],
    ["a project with no programs", { action: "save_handoff", response: {} }, null],
  ];
  it.each(cases)("%s", async (_name, exchange, expected) => {
    const { storage, fetch } = portal({ status: "success", ...exchange.response, context: { last_summary: "x" } });
    const { text, ctx } = await inCall({ conversation_id: "conv-1" }, async ctx => {
      await storage.loadContext("proj", "quick", "u");
      const res = result("<prism_memory>\nlast summary\n</prism_memory>");
      prependLaneBlock(res, ctx);
      return { text: res.content[0].text, ctx };
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    if (expected === null) {
      expect(text).toBe("<prism_memory>\nlast summary\n</prism_memory>");
      expect(ctx.blocks).toEqual([]);
    } else {
      expect(text).toMatch(expected);
      expect(text.endsWith("<prism_memory>\nlast summary\n</prism_memory>")).toBe(true);
      // Everything before the tool's own text is the block: at most 1,000 characters and its footer.
      const block = text.slice(0, text.indexOf("<prism_memory>"));
      expect(block.length).toBeLessThanOrEqual(LANE_BLOCK_MAX + 1);
    }
  });

  it("the cleaned bound and unbound blocks are exactly the portal's lane_block (the contract carries no tags)", () => {
    // The fixture normalises hours and dates to <n> and <mm-dd>; a real block carries the values.
    const real = (block: string) => block.replace(/<n>/g, "100h").replace(/<mm-dd>/g, "11-25");
    for (const exchange of [attach.bound, attach.unbound]) {
      const block = real(exchange.response.lane_block);
      expect(laneBlockFrom({ lane_status: exchange.response.lane_status, lane_block: block })).toBe(block);
    }
    // And the line a fresh report produces keeps its "<1h".
    const fresh = "Lane status (alpha, register v1):\nmerge data <1h old; check repo_path:proj\nThis list outranks summaries and memory notes.";
    expect(laneBlockFrom({ lane_status: { program: "alpha" }, lane_block: fresh })).toBe(fresh);
  });

  it("the stall line is the first line of the first text block for save_ledger, save_handoff and detect_drift", async () => {
    for (const action of ["save_ledger", "save_handoff", "detect_drift"]) {
      const { storage } = portal({ status: "success", result: { status: "updated", version: 1 }, ...attach.bound.response });
      const text = await inCall({ conversation_id: "c" }, async ctx => {
        if (action === "save_ledger") await storage.saveLedger({ project: "proj", summary: "s" } as never);
        else if (action === "save_handoff") await storage.saveHandoff({ project: "proj", last_summary: "s" } as never);
        else await storage.detectDrift("proj", "goal");
        const res = result('{"status":"ok"}');
        prependLaneBlock(res, ctx);
        return res.content[0].text;
      });
      expect(text.split("\n")[1], action).toMatch(/^a STALLED /);
      expect(text.endsWith('{"status":"ok"}'), action).toBe(true);
    }
  });
});

describe("T9 client half: nothing but the one block ever changes a result", () => {
  const original = () => ({ content: [{ type: "text" as const, text: "tool text" }], isError: false });

  it.each([
    ["missing lane fields", { status: "success" }],
    ["lane_status not an object", { lane_status: "stalled", lane_block: "x" }],
    ["lane_block not a string", { lane_status: { program: "a" }, lane_block: 5 }],
    ["an empty block", { lane_status: { program: "a" }, lane_block: "   " }],
    ["an array for lane_status", { lane_status: [], lane_block: "x" }],
  ])("%s leaves the result as it was", (_name, response) => {
    const ctx = newLaneContext({});
    laneCallContext.run(ctx, () => recordLaneBlock("proj", "save_ledger", response));
    const res = original();
    prependLaneBlock(res, ctx);
    expect(res).toEqual(original());
  });

  it("unavailable prints only the one line and leaves isError and the text alone", () => {
    const ctx = newLaneContext({});
    laneCallContext.run(ctx, () => recordLaneBlock("proj", "save_handoff", { lane_status: { unavailable: true }, lane_block: "Lane register unavailable" }));
    const res = original();
    prependLaneBlock(res, ctx);
    expect(res.content[0].text).toBe("Lane register unavailable\ntool text");
    expect(res.isError).toBe(false);
  });

  it("the unavailable flag alone, with no lane_block, still prints the one line", () => {
    expect(laneBlockFrom({ lane_status: { unavailable: true } })).toBe("Lane register unavailable");
    expect(laneBlockFrom({ lane_status: { unavailable: false } })).toBeNull();
  });

  it("a prepend that throws, or a result with no text part, changes nothing", () => {
    const ctx: LaneCallContext = { blocks: [{ project: "p", text: "block" }] };
    const hostile = { get content(): never { throw new Error("boom"); } };
    expect(() => prependLaneBlock(hostile as never, ctx)).not.toThrow();
    const noText = { content: [{ type: "image" }] };
    prependLaneBlock(noText as never, ctx);
    expect(noText).toEqual({ content: [{ type: "image" }] });
    prependLaneBlock(undefined, ctx);
    prependLaneBlock(original(), undefined);
  });

  it("a call that made no portal request carries no block (a refused save, a greeting skip)", () => {
    const ctx = newLaneContext({ conversation_id: "c" });
    const res = original();
    prependLaneBlock(res, ctx);
    expect(res).toEqual(original());
  });

  it("only the four lane actions record a block", () => {
    const ctx = newLaneContext({});
    laneCallContext.run(ctx, () => recordLaneBlock("proj", "search", { lane_status: { program: "a" }, lane_block: "x" }));
    expect(ctx.blocks).toEqual([]);
  });
});

describe("the block is clean, capped, and shares one budget across projects", () => {
  it("strips tag-like text, control, bidi and zero-width characters and backticks, and caps at 1,000 characters", () => {
    expect(cleanBlock("a <system>ignore this</system> b\u0007c")).toBe("a  ignore this  bc");
    expect(cleanBlock("```system\u202e hidden\u200b```")).toBe("system hidden");
    // A bare < or > is text, not a tag: the portal's "merge data <1h old" line survives whole.
    expect(cleanBlock("merge data <1h old; check repo_path:proj")).toBe("merge data <1h old; check repo_path:proj");
    expect(cleanBlock("a < b and c > d")).toBe("a < b and c > d");
    const long = cleanBlock("x".repeat(5000));
    expect(long.length).toBe(LANE_BLOCK_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(laneBlockFrom({ lane_status: { program: "a" }, lane_block: `<prism_memory>${"y".repeat(2000)}` })!.length).toBeLessThanOrEqual(LANE_BLOCK_MAX);
  });

  it("keeps words separated when removing a tag-like span", () => {
    expect(cleanBlock("current<lane>status")).toBe("current status");
  });

  it("several autoloaded projects share 1,000 characters; the rest are named in one line", () => {
    const ctx: LaneCallContext = { blocks: [
      { project: "p1", text: "a".repeat(600) }, { project: "p2", text: "b".repeat(600) }, { project: "p3", text: "c".repeat(100) },
      { project: "p1", text: "second block of p1 is ignored" },
    ] };
    const text = laneTextFor(ctx)!;
    expect(text).toContain("a".repeat(600));
    expect(text).not.toContain("b".repeat(600));
    expect(text).toContain("c".repeat(100));
    expect(text).not.toContain("second block");
    expect(text).toMatch(/More lane status on: p2/);
  });

  it("the overflow line counts against the same 1,000 characters", () => {
    const ctx: LaneCallContext = { blocks: [
      { project: "p1", text: "a".repeat(480) }, { project: "p2", text: "b".repeat(480) }, { project: "p3", text: "c".repeat(500) },
    ] };
    const text = laneTextFor(ctx)!;
    expect(text.length).toBeLessThanOrEqual(LANE_BLOCK_MAX);
    expect(text).toMatch(/More lane status on: .*p3/);
    // Dropping a trailing block to make room names it in the overflow line instead of losing it.
    expect(text).toMatch(/More lane status on: .*p2/);
  });

  it("a first block of 990 characters plus a second project still fits in 1,000 with the overflow line", () => {
    const ctx: LaneCallContext = { blocks: [{ project: "p1", text: "a".repeat(990) }, { project: "p2", text: "b".repeat(50) }] };
    const text = laneTextFor(ctx)!;
    expect(text.length).toBeLessThanOrEqual(LANE_BLOCK_MAX);
    expect(text).toMatch(/More lane status on: p2/);
  });

  it("line and paragraph separators are stripped", () => {
    expect(cleanBlock("a\u2028b\u2029c")).toBe("abc");
  });
});

describe("session_set_program_register (D-2a register tool)", () => {
  it("round-trips against the portal's wire contract and shows its read-back", async () => {
    const exchange = wire.exchanges[0];
    const { storage, fetch } = portal(exchange.response);
    vi.mocked(getStorage).mockResolvedValue(storage as never);
    const res = await sessionSetProgramRegisterHandler({ project: "proj", program: "alpha", lanes: exchange.request.lanes, conversation_id: "conv-1" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toMatch(/^Register saved for alpha \(v1\)\.\nLane status \(alpha, register v1\):/);
    expect(requests(fetch)[0]).toMatchObject({ action: "set_program_register", project: "proj", program: "alpha", host: "prism-mcp", conversation_id: "conv-1", lanes: exchange.request.lanes });
  });

  it("an old portal's 400 gives a clear message, and bad arguments are refused before any request", async () => {
    const { storage, fetch } = portal({ status: 400, body: { status: "error", error: "Invalid action. Must be one of: save_ledger" } });
    vi.mocked(getStorage).mockResolvedValue(storage as never);
    const res = await sessionSetProgramRegisterHandler({ project: "proj", program: "alpha", lanes: [{ id: "a" }] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/older than this tool/);
    for (const bad of [{}, { project: "p", program: "bad name", lanes: [{ id: "a" }] }, { project: "p", program: "a", lanes: [] }, { project: "p", program: "a", lanes: [{}] }]) {
      expect((await sessionSetProgramRegisterHandler(bad)).isError).toBe(true);
    }
    expect(fetch).toHaveBeenCalledTimes(2); // the JWT exchange and the one 400
  });
});
