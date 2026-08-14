/**
 * Layer 1 must see the image, not just the prompt.
 *
 * Gap found in the 2026-08-14 pre-merge review: prism_infer gained image
 * support, but the reserved-content classifier still received the TEXT PROMPT
 * ONLY. A screenshot of clinical material — a SOAP note, a medication label,
 * an AAC session capture — passed the safety gate untouched, because the gate
 * never looked at it. On a product with life-critical AAC evals, "the gate
 * cannot see the input" is the whole failure.
 */
import { describe, it, expect, vi } from "vitest";
import { callLayer1, LAYER1_IMAGE_TIMEOUT_MS } from "../../src/utils/layer1.js";

const B64 = "iVBORw0KGgoAAAANSUhEUg==";

function fetchReturning(content: string, opts: { capture?: (body: any) => void } = {}) {
  return vi.fn(async (_url: any, init: any) => {
    opts.capture?.(JSON.parse(init.body));
    return { ok: true, json: async () => ({ message: { content } }) } as any;
  });
}

describe("callLayer1 with images", () => {
  it("attaches the images to the classify request", async () => {
    let body: any;
    const f = fetchReturning("OBVIOUS_NOT_RESERVED", { capture: b => { body = b; } });
    await callLayer1("what is on this screen?", "http://x", "m", f as any, [B64]);
    const userMsg = body.messages.find((m: any) => m.role === "user");
    expect(userMsg.images).toEqual([B64]);
  });

  it("returns RESERVED when the classifier flags the image content", async () => {
    const f = fetchReturning("OBVIOUS_RESERVED");
    expect(await callLayer1("describe this", "http://x", "m", f as any, [B64]))
      .toBe("OBVIOUS_RESERVED");
  });

  it("an unclassifiable IMAGE is UNCERTAIN, never silently allowed", async () => {
    // Text-only ERROR falls through to a keyword backstop that can read the
    // prompt. With an image there is nothing to fall back on — the gate saw
    // nothing — so the conservative verdict is UNCERTAIN (reserved handling).
    const f = vi.fn(async () => { throw new Error("timeout"); });
    expect(await callLayer1("describe this", "http://x", "m", f as any, [B64]))
      .toBe("UNCERTAIN");
  });

  it("gives image classification a longer budget than the 1.5s text path", () => {
    // A vision classify carries ~3,000 image tokens; the text budget would
    // time out every single time and make the gate useless.
    expect(LAYER1_IMAGE_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000);
  });
});

describe("handler wiring: the gate receives what the model receives", () => {
  it("passes resolved images to Layer 1, not just the prompt", async () => {
    const { runInfer } = await import("../../src/tools/prismInferHandler.js");
    const { _setCacheForTest, _resetEntitlementsForTest } =
      await import("../../src/utils/entitlements.js");
    const ENT: any = {
      plan: "enterprise", model_ceiling: "27b", daily_infer_limit: 1e5, max_tokens: 4096, max_seats: 25,
      features: { cloud_fallback: true, grounding_verifier: true, route_guard: true,
                  knowledge_search_unlimited: true, session_memory_unlimited: true, analytics_dashboard: true },
      upgrade_url: "https://synalux.ai/pricing",
    };
    _setCacheForTest(ENT, 60_000);
    let sawImages: string[] | undefined;
    try {
      await runInfer(
        { prompt: "describe this", images: [B64], mode: "chat", task_complexity: 5 },
        {
          freemem: () => 30 * 1024 ** 3,
          listTags: async () => new Set(["prism-coder:9b", "prism-coder:4b"]),
          listLoaded: async () => new Set<string>(),
          callLocal: async () => ({ ok: true as const, text: "a screen", doneReason: "stop" }),
          callCloud: async () => ({ ok: false as const, reason: "no" }),
          ollamaUrl: "http://x",
          probeVision: async () => true,
          callLayer1: async (_p, _u, _m, _f, images) => { sawImages = images; return "OBVIOUS_NOT_RESERVED"; },
        } as any);
    } finally { _resetEntitlementsForTest(); }
    expect(sawImages).toEqual([B64]);   // the gate saw the screenshot
  });
});
