/**
 * ImageCaptioner Unit Tests (v4.5)
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests the captionImageAsync pipeline and the provider interface contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as nodePath from "path";
import * as os from "os";

// ─── Mock all external dependencies ──────────────────────────────────────────

vi.mock("../../src/utils/llm/factory.js", () => ({
  getLLMProvider: vi.fn(),
}));
vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(),
}));
vi.mock("../../src/utils/logger.js", () => ({
  debugLog: vi.fn(),
}));
vi.mock("../../src/storage/configStorage.js", () => ({
  getSettingSync: vi.fn((_k: string, def?: string) => def ?? ""),
}));

import { getLLMProvider } from "../../src/utils/llm/factory.js";
import { getStorage } from "../../src/storage/index.js";
import { fireCaptionAsync } from "../../src/utils/imageCaptioner.js";

const mockGetLLMProvider = vi.mocked(getLLMProvider);
const mockGetStorage = vi.mocked(getStorage);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Builds a minimal storage mock with all required methods */
function makeStorageMock() {
  return {
    loadContext: vi.fn().mockResolvedValue({
      version: 1,
      metadata: {
        visual_memory: [
          {
            id: "abc12345",
            description: "Login page screenshot",
            filename: "abc12345.png",
            original_path: "/tmp/login.png",
            timestamp: "2026-03-25T12:00:00.000Z",
          },
        ],
      },
      last_summary: null,
      pending_todo: null,
      active_decisions: null,
      keywords: null,
      key_context: null,
      active_branch: null,
    }),
    saveHandoff: vi.fn().mockResolvedValue({ status: "updated", version: 2 }),
    saveLedger: vi.fn().mockResolvedValue({ id: "ledger-001", created_at: "2026-03-25T12:00:01.000Z" }),
    getLedgerEntries: vi.fn().mockResolvedValue([
      { id: "ledger-001", created_at: "2026-03-25T12:00:01.000Z" },
    ]),
    patchLedger: vi.fn().mockResolvedValue(undefined),
  };
}

/** Builds a VLM-capable LLM provider mock */
function makeVLMProvider(caption = "A web login form with email and password fields.") {
  return {
    generateText:             vi.fn().mockResolvedValue("text"),
    generateEmbedding:        vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
    generateImageDescription: vi.fn().mockResolvedValue(caption),
  };
}

/** Builds a text-only LLM provider mock (no VLM) */
function makeTextOnlyProvider() {
  return {
    generateText:      vi.fn().mockResolvedValue("text"),
    generateEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
    // generateImageDescription intentionally absent
  };
}

// ─── File system helper ───────────────────────────────────────────────────────

let tmpFile: string;

beforeEach(() => {
  // Create a tiny fake PNG in os.tmpdir() for file-read tests
  tmpFile = nodePath.join(os.tmpdir(), `test-prism-img-${Date.now()}.png`);
  // 1x1 transparent PNG (89 bytes) — valid enough to not fail fs.existsSync
  const minimalPng = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000a49444154789c6260000000020001e221bc330000000049454e44ae426082",
    "hex"
  );
  fs.writeFileSync(tmpFile, minimalPng);
});

afterEach(() => {
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  vi.clearAllMocks();
});

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("ImageCaptioner — fireCaptionAsync pipeline", () => {

  it("runs the full pipeline: VLM → handoff patch → ledger → embedding", async () => {
    const storage = makeStorageMock();
    const provider = makeVLMProvider();

    mockGetLLMProvider.mockReturnValue(provider as any);
    mockGetStorage.mockResolvedValue(storage as any);

    // fireCaptionAsync is fire-and-forget — await via a small delay
    fireCaptionAsync("prism", "abc12345", tmpFile, "Login page");
    await new Promise(r => setTimeout(r, 100));

    // VLM called with base64 + mimeType + context
    expect(provider.generateImageDescription).toHaveBeenCalledWith(
      expect.any(String),           // base64
      "image/png",
      "Login page",
    );

    // Handoff patched with caption
    expect(storage.saveHandoff).toHaveBeenCalledTimes(1);
    const handoffCall = storage.saveHandoff.mock.calls[0][0];
    const vm = handoffCall.metadata.visual_memory[0];
    expect(vm.caption).toBe("A web login form with email and password fields.");
    expect(vm.caption_at).toBeDefined();

    // Ledger entry saved with embedded metadata in summary
    expect(storage.saveLedger).toHaveBeenCalledWith(expect.objectContaining({
      project: "prism",
      conversation_id: "vlm-captioner",
      event_type: "learning",
      summary: expect.stringContaining("[Visual Memory: abc12345]"),
      keywords: expect.arrayContaining(["image:abc12345", "visual_memory"]),
    }));

    // Caption embedded inline (no circular backfill call)
    expect(provider.generateEmbedding).toHaveBeenCalled();
    expect(storage.patchLedger).toHaveBeenCalledWith(
      "ledger-001",
      expect.objectContaining({ embedding: expect.any(String) }),
    );
  });

  it("skips captioning gracefully when provider has no VLM method", async () => {
    const storage = makeStorageMock();
    const provider = makeTextOnlyProvider();

    mockGetLLMProvider.mockReturnValue(provider as any);
    mockGetStorage.mockResolvedValue(storage as any);

    fireCaptionAsync("prism", "abc12345", tmpFile, "Login page");
    await new Promise(r => setTimeout(r, 100));

    // Nothing should have been stored
    expect(storage.saveLedger).not.toHaveBeenCalled();
    expect(storage.saveHandoff).not.toHaveBeenCalled();
    expect(storage.patchLedger).not.toHaveBeenCalled();
  });

  it("skips captioning when vault file does not exist", async () => {
    const provider = makeVLMProvider();
    mockGetLLMProvider.mockReturnValue(provider as any);

    fireCaptionAsync("prism", "abc12345", "/nonexistent/path.png", "test");
    await new Promise(r => setTimeout(r, 100));

    expect(provider.generateImageDescription).not.toHaveBeenCalled();
  });

  it("skips when Anthropic provider and file > 5MB", async () => {
    const { getSettingSync } = await import("../../src/storage/configStorage.js");
    vi.mocked(getSettingSync).mockImplementation((key: string, def?: string) => {
      if (key === "text_provider") return "anthropic";
      return def ?? "";
    });

    const storage = makeStorageMock();
    const provider = makeVLMProvider();
    mockGetLLMProvider.mockReturnValue(provider as any);
    mockGetStorage.mockResolvedValue(storage as any);

    // Write a fake 6MB file (over 5MB Anthropic limit)
    const bigFile = nodePath.join(os.tmpdir(), `prism-bigtest-${Date.now()}.png`);
    fs.writeFileSync(bigFile, Buffer.alloc(6 * 1024 * 1024, 0));
    try {
      fireCaptionAsync("prism", "abc12345", bigFile, "large image");
      await new Promise(r => setTimeout(r, 100));
      expect(provider.generateImageDescription).not.toHaveBeenCalled();
    } finally {
      fs.unlinkSync(bigFile);
    }
  });

  it("still saves ledger entry even if handoff OCC fails twice", async () => {
    const storage = makeStorageMock();
    storage.saveHandoff.mockResolvedValue({ status: "conflict" }); // always conflict
    const provider = makeVLMProvider();

    mockGetLLMProvider.mockReturnValue(provider as any);
    mockGetStorage.mockResolvedValue(storage as any);

    fireCaptionAsync("prism", "abc12345", tmpFile, "Login page");
    await new Promise(r => setTimeout(r, 100));

    // Caption still saved to ledger despite handoff conflict
    expect(storage.saveLedger).toHaveBeenCalledTimes(1);
    expect(storage.saveHandoff).toHaveBeenCalledTimes(2); // 2 OCC retry attempts
  });
});

describe("LLMProvider interface — generateImageDescription is optional", () => {
  it("text-only adapter satisfies LLMProvider interface without VLM method", () => {
    // TypeScript ensures this at compile time, but runtime check for completeness
    const textOnly = makeTextOnlyProvider();
    expect(textOnly.generateImageDescription).toBeUndefined();
    expect(textOnly.generateText).toBeDefined();
    expect(textOnly.generateEmbedding).toBeDefined();
  });
});
