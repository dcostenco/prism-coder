/**
 * prism_infer image support.
 *
 * Measured 2026-08-14: the whole local set was repackaged to restore vision
 * (9b/4b/2b now report `vision`), yet prism_infer had NO image parameter — so
 * the capability was unreachable through the routing path every caller uses.
 * A screenshot could only be judged by bypassing infer and calling ollama
 * directly, which skips Layer 1, entitlements, RAM gating and telemetry.
 */
import { describe, it, expect, vi } from "vitest";
import { isPrismInferArgs, prepareImages, tiersSupportingVision } from "../../src/tools/prismInferHandler.js";

const B64 = "iVBORw0KGgoAAAANSUhEUg==";

describe("images arg validation", () => {
  it("accepts a base64 image list", () => {
    expect(isPrismInferArgs({ prompt: "x", images: [B64] })).toBe(true);
  });
  it("rejects non-array and non-string entries", () => {
    expect(isPrismInferArgs({ prompt: "x", images: B64 })).toBe(false);
    expect(isPrismInferArgs({ prompt: "x", images: [123] })).toBe(false);
  });
  it("rejects an unbounded image count", () => {
    expect(isPrismInferArgs({ prompt: "x", images: Array(9).fill(B64) })).toBe(false);
  });
});

describe("prepareImages", () => {
  it("passes base64 through untouched", async () => {
    expect(await prepareImages([B64])).toEqual([B64]);
  });
  it("reads a filesystem path and base64-encodes it", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const p = join(mkdtempSync(join(tmpdir(), "infer-img-")), "a.png");
    writeFileSync(p, Buffer.from([1, 2, 3, 4]));
    expect(await prepareImages([p])).toEqual([Buffer.from([1, 2, 3, 4]).toString("base64")]);
  });
  it("throws on a path that does not exist rather than sending a filename as base64", async () => {
    await expect(prepareImages(["/no/such/file.png"])).rejects.toThrow(/not readable|ENOENT/i);
  });
});

describe("vision tier gating", () => {
  it("keeps only vision-capable tiers when images are present", async () => {
    const probe = vi.fn(async (_u: string, m: string) => m.includes("27b") ? false : true);
    const tiers = await tiersSupportingVision("http://x", ["prism-coder:27b", "prism-coder:9b"], probe);
    expect(tiers).toEqual(["prism-coder:9b"]);
  });
  it("treats an unprobeable model as NOT vision-capable (fail safe)", async () => {
    const probe = vi.fn(async () => { throw new Error("ollama down"); });
    expect(await tiersSupportingVision("http://x", ["prism-coder:9b"], probe)).toEqual([]);
  });
});

describe("round-1 review findings", () => {
  it("charges image tokens against the tier context budget", async () => {
    const { estimateImageTokens, IMAGE_TOKEN_ESTIMATE } = await import("../../src/tools/prismInferHandler.js");
    // Measured live 2026-08-14: one 1206x2622 screenshot = ~3,100 prompt tokens.
    // The 9b/27b tiers advertise ctxTokens 4_096, so TWO images cannot fit and
    // the ctx gate must know that — it previously counted only the text prompt.
    expect(IMAGE_TOKEN_ESTIMATE).toBeGreaterThanOrEqual(2_500);
    expect(estimateImageTokens(2)).toBeGreaterThan(4_096);
    expect(estimateImageTokens(0)).toBe(0);
  });

  it("refuses an oversized image instead of base64-ing it into memory", async () => {
    const { prepareImages, MAX_IMAGE_BYTES } = await import("../../src/tools/prismInferHandler.js");
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const p = join(mkdtempSync(join(tmpdir(), "infer-big-")), "big.png");
    writeFileSync(p, Buffer.alloc(MAX_IMAGE_BYTES + 1024));
    await expect(prepareImages([p])).rejects.toThrow(/too large/i);
  });
});

describe("round-2: the 27b must stay reachable for text/coding", () => {
  it("vision filtering does NOT apply when no images are supplied", async () => {
    const { isPrismInferArgs } = await import("../../src/tools/prismInferHandler.js");
    // Guard the contract: a text call carries no images, so the ladder is
    // untouched and the 27b coding tier remains selectable.
    expect(isPrismInferArgs({ prompt: "write a function", model_ceiling: "27b" })).toBe(true);
    const src = await import("node:fs").then(fs =>
      fs.readFileSync("src/tools/prismInferHandler.ts", "utf8"));
    expect(src).toMatch(/if \(args\.images\?\.length\)/);      // gating is conditional
    expect(src).toMatch(/visionOk && !visionOk\.has\(ollamaName\)/); // skip only when set
  });
});

// ── Chain-level tests (mocked deps, no live models) ────────────────────
import { runInfer, type InferDeps } from "../../src/tools/prismInferHandler.js";
import { _setCacheForTest, _resetEntitlementsForTest, type PrismEntitlements } from "../../src/utils/entitlements.js";

const ENTERPRISE_ENTITLEMENTS: PrismEntitlements = {
  plan: "enterprise", model_ceiling: "27b", daily_infer_limit: 100000,
  max_tokens: 4096, max_seats: 25,
  features: { cloud_fallback: true, grounding_verifier: true, route_guard: true,
              knowledge_search_unlimited: true, session_memory_unlimited: true,
              analytics_dashboard: true },
  upgrade_url: "https://synalux.ai/pricing",
};
import { beforeEach, afterAll } from "vitest";
const GB = 1024 ** 3;
const ALL = new Set(["prism-coder:27b", "prism-coder:9b", "prism-coder:4b", "prism-coder:2b"]);
function deps(o: Partial<InferDeps> = {}): InferDeps {
  return {
    freemem: () => 30 * GB,
    listTags: async () => ALL,
    listLoaded: async () => new Set<string>(),
    callLocal: async () => ({ ok: true as const, text: "ok", doneReason: "stop" }),
    callCloud: async () => ({ ok: false as const, reason: "cloud_disabled" }),
    ollamaUrl: "http://x",
    callLayer1: async () => "OBVIOUS_NOT_RESERVED",
    entitlements: ENTERPRISE_ENTITLEMENTS,
    ...o,
  } as InferDeps;
}

// Harness note: entitlements are read from a module cache, not from deps —
// without _setCacheForTest the ladder clamps to the free tier and never
// reaches 9b/27b. Complexity buckets: <=3 -> 4b, <=6 -> 9b, >6 -> 27b.
beforeEach(() => { _setCacheForTest(ENTERPRISE_ENTITLEMENTS, 60_000); });
afterAll(() => { _resetEntitlementsForTest(); });

describe("infer chain with screenshots", () => {
  it("routes an image request to a vision tier and forwards the images", async () => {
    const seen: Array<string[] | undefined> = [];
    const r = await runInfer(
      { prompt: "what is occluded?", images: [B64], mode: "chat", task_complexity: 5 },
      deps({
        probeVision: async (_u, m) => m.includes("9b"),
        callLocal: async (_u, _m, _p, _s, _mt, _t, _to, _th, images) => {
          seen.push(images);
          return { ok: true as const, text: "YES — Sources & Citations", doneReason: "stop" };
        },
      }));
    expect(r.model_picked).toContain("9b");
    expect(seen[0]).toEqual([B64]);          // images actually reached the model
  });

  it("SKIPS a text-only tier rather than showing it a prompt about an image it never got", async () => {
    const tried: string[] = [];
    const r = await runInfer(
      { prompt: "what is occluded?", images: [B64], mode: "chat", task_complexity: 9 },
      deps({
        probeVision: async (_u, m) => !m.includes("27b"),   // 27b text-only, like production
        callLocal: async (_u, m) => { tried.push(m); return { ok: true as const, text: "ok", doneReason: "stop" }; },
      }));
    expect(r.output.length).toBeGreaterThan(0);
    expect(tried.some(m => m.includes("27b"))).toBe(false); // never handed the image prompt
    expect(tried.some(m => m.includes("9b"))).toBe(true);   // 9b remains the workhorse
  });

  it("stays LOCAL-FIRST when the ceiling tier lacks RAM — degrades to 9b, never the cloud", async () => {
    const tried: string[] = [];
    let cloudCalls = 0;
    const r = await runInfer(
      { prompt: "write a clamp fn", mode: "code", task_complexity: 9 },
      deps({
        freemem: () => 10 * GB,                       // below the 27b's 20GB floor
        callLocal: async (_u, m) => { tried.push(m); return { ok: true as const, text: "const clamp=…", doneReason: "stop" }; },
        callCloud: async () => { cloudCalls++; return { ok: false as const, reason: "should_not_be_called" }; },
      }));
    expect(r.used_cloud).toBe(false);
    expect(tried.some(m => m.includes("27b"))).toBe(false);
    expect(tried.some(m => m.includes("9b"))).toBe(true);
    expect(cloudCalls).toBe(0);
  });
});

describe("round-2 review findings", () => {
  it("treats a Windows path as a path, not as base64", async () => {
    // The CLI ships cross-platform. `C:\Users\...\shot.png` fails the
    // startsWith("/") test, so it was passed through as if it WERE image
    // bytes — the model then answers confidently about an image it never got,
    // which is the exact failure mode the throw-on-unreadable rule exists for.
    await expect(prepareImages(["C:\\Users\\dev\\shot.png"])).rejects.toThrow(/not readable|ENOENT/i);
  });
});
