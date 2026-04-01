/**
 * sessionCognitiveRouteHandler — Phase 6 Integration Tests (v6.5)
 *
 * ═══════════════════════════════════════════════════════════════════
 * SCOPE:
 *   Tests the complete cognitive routing pipeline through the handler
 *   layer with mocked SDM/storage/config dependencies:
 *
 *   1. Args guards — missing required fields, invalid types, threshold range
 *   2. Feature flag — PRISM_HDC_ENABLED=false returns gated error
 *   3. Happy path — mocked PolicyGateway evaluateIntent flow
 *   4. Threshold validation — invalid combos rejected, valid persisted
 *   5. SQLite/Supabase parity — getSetting/setSetting contract
 *   6. Error paths — SDM exceptions surface cleanly
 *   7. Metrics telemetry — recordCognitiveRoute called with correct shape
 *
 * APPROACH:
 *   Full vi.mock on storage, SDM modules, and config. No real DB or
 *   hyperdimensional computation. Each test constructs purpose-built
 *   mock state to exercise a specific handler code path.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Track telemetry calls ──────────────────────────────────────
const mockRecordCognitiveRoute = vi.fn();

// ─── Controllable mock for PolicyGateway.evaluateIntent ─────────
const mockEvaluateIntent = vi.fn(async () => ({
  route: "ACTION_AUTO_ROUTE",
  concept: "State:ActiveSession",
  confidence: 0.92,
  distance: 0.08,
  ambiguous: false,
  steps: 3,
}));

// ─── Mock storage returned by getStorage ────────────────────────
const mockStorage = {
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  getHdcConcept: vi.fn(async () => null),
  saveHdcConcept: vi.fn(async () => {}),
  getAllHdcConcepts: vi.fn(async () => []),
  getAllSettings: vi.fn(async () => ({})),
};

// ─── Mock Dependencies ──────────────────────────────────────────

// 1. Storage
vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(async () => mockStorage),
}));

// 2. SDM Engine — needs to return a SparseDistributedMemory-like object
vi.mock("../../src/sdm/sdmEngine.js", () => ({
  getSdmEngine: vi.fn(() => ({
    readHdc: vi.fn((v: Uint32Array) => new Uint32Array(v)),
  })),
  D_ADDR_UINT32: 24,
  hammingDistance: vi.fn(() => 0),
}));

// 3. ConceptDictionary — must be a proper class constructor
vi.mock("../../src/sdm/conceptDictionary.js", () => {
  return {
    ConceptDictionary: class MockConceptDictionary {
      getConcept = vi.fn(async () => new Uint32Array(24));
      nearestConcept = vi.fn(async () => ({
        winner: { concept: "State:Test", distance: 30, confidence: 0.95 },
        candidates: [{ concept: "State:Test", distance: 30, confidence: 0.95 }],
        ambiguous: false,
      }));
    },
    DeterministicPRNG: class {},
    stringToSeed: vi.fn(() => 42),
  };
});

// 4. HdcStateMachine — must be a proper class constructor
vi.mock("../../src/sdm/stateMachine.js", () => {
  return {
    HdcStateMachine: class MockHdcStateMachine {
      transition = vi.fn(() => new Uint32Array(24));
      recall = vi.fn(() => new Uint32Array(24));
      recallToConcept = vi.fn(async () => ({
        concept: "State:ActiveSession",
        confidence: 0.92,
        distance: 0.08,
        ambiguous: false,
        steps: 3,
      }));
      getCurrentState = vi.fn(() => new Uint32Array(24));
    },
  };
});

// 5. HDC Engine
vi.mock("../../src/sdm/hdc.js", () => ({
  HDCEngine: {
    permute: vi.fn((v: Uint32Array) => new Uint32Array(v)),
    bind: vi.fn((a: Uint32Array, _b: Uint32Array) => new Uint32Array(a)),
    bundle: vi.fn((vs: Uint32Array[]) => vs[0] || new Uint32Array(24)),
  },
}));

// 6. PolicyGateway — must be a proper class constructor
vi.mock("../../src/sdm/policyGateway.js", () => {
  return {
    PolicyGateway: class MockPolicyGateway {
      evaluateIntent = mockEvaluateIntent;
    },
    ActionRoute: {
      ACTION_AUTO_ROUTE: "ACTION_AUTO_ROUTE",
      ACTION_CLARIFY: "ACTION_CLARIFY",
      ACTION_FALLBACK: "ACTION_FALLBACK",
    },
  };
});

// 7. Observability
vi.mock("../../src/observability/graphMetrics.js", () => ({
  recordCognitiveRoute: mockRecordCognitiveRoute,
  recordSynthesisRun: vi.fn(),
  recordTestMeCall: vi.fn(),
  getGraphMetricsSnapshot: vi.fn(() => ({})),
  resetGraphMetricsForTests: vi.fn(),
}));

// 8. Config — HDC feature flags with getter-based runtime overrides
let mockHdcEnabled = true;
let mockExplainEnabled = true;
vi.mock("../../src/config.js", () => ({
  get PRISM_HDC_ENABLED() { return mockHdcEnabled; },
  get PRISM_HDC_EXPLAINABILITY_ENABLED() { return mockExplainEnabled; },
  PRISM_HDC_POLICY_FALLBACK_THRESHOLD: 0.85,
  PRISM_HDC_POLICY_CLARIFY_THRESHOLD: 0.95,
  PRISM_USER_ID: "default",
  GOOGLE_API_KEY: "",
  PRISM_AUTO_CAPTURE: false,
  PRISM_CAPTURE_PORTS: [],
}));

// 9. Silence non-essential imports
vi.mock("../../src/utils/logger.js", () => ({ debugLog: vi.fn() }));
vi.mock("../../src/utils/keywordExtractor.js", () => ({ toKeywordArray: vi.fn(() => []) }));
vi.mock("../../src/utils/llm/factory.js", () => ({
  getLLMProvider: vi.fn(() => ({
    generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
    generateText: vi.fn(async () => "[]"),
  })),
}));
vi.mock("../../src/utils/git.js", () => ({
  getCurrentGitState: vi.fn(() => null),
  getGitDrift: vi.fn(() => null),
}));
vi.mock("../../src/utils/autoCapture.js", () => ({ captureLocalEnvironment: vi.fn() }));
vi.mock("../../src/utils/imageCaptioner.js", () => ({ fireCaptionAsync: vi.fn() }));
vi.mock("../../src/tools/commonHelpers.js", () => ({
  formatRulesBlock: vi.fn(),
  applySentinelBlock: vi.fn(),
  SENTINEL_START: "",
  SENTINEL_END: "",
  REDACT_PATTERNS: [],
}));
vi.mock("../../src/utils/tracing.js", () => ({
  createMemoryTrace: vi.fn(),
  traceToContentBlock: vi.fn(),
}));
vi.mock("../../src/storage/configStorage.js", () => ({
  getSetting: vi.fn(async () => null),
  getAllSettings: vi.fn(async () => ({})),
}));
vi.mock("../../src/utils/crdtMerge.js", () => ({
  mergeHandoff: vi.fn(),
  dbToHandoffSchema: vi.fn(),
  sanitizeForMerge: vi.fn(),
}));
vi.mock("../../src/utils/cognitiveMemory.js", () => ({
  computeEffectiveImportance: vi.fn(),
  updateLastAccessed: vi.fn(),
}));
vi.mock("../../src/server.js", () => ({ notifyResourceUpdate: vi.fn() }));

// ─── Import the handler under test ──────────────────────────────
const { sessionCognitiveRouteHandler } = await import("../../src/tools/graphHandlers.js");

// ═══════════════════════════════════════════════════════════════════
// 1. ARGS GUARDS
// ═══════════════════════════════════════════════════════════════════

describe("sessionCognitiveRouteHandler args guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHdcEnabled = true;
    mockExplainEnabled = true;
  });

  it("rejects missing project", async () => {
    const res = await sessionCognitiveRouteHandler({
      state: "State:Test", role: "Role:dev", action: "Action:inspect",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Invalid arguments");
  });

  it("rejects missing state", async () => {
    const res = await sessionCognitiveRouteHandler({
      project: "p", role: "Role:dev", action: "Action:inspect",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Invalid arguments");
  });

  it("rejects missing role", async () => {
    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", action: "Action:inspect",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Invalid arguments");
  });

  it("rejects missing action", async () => {
    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Invalid arguments");
  });

  it("rejects null args", async () => {
    const res = await sessionCognitiveRouteHandler(null);
    expect(res.isError).toBe(true);
  });

  it("rejects non-object args", async () => {
    const res = await sessionCognitiveRouteHandler("not an object");
    expect(res.isError).toBe(true);
  });

  it("rejects non-numeric fallback_threshold", async () => {
    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
      fallback_threshold: "high",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Invalid arguments");
  });

  it("rejects non-boolean explain", async () => {
    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
      explain: "yes",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Invalid arguments");
  });



  it("rejects NaN fallback_threshold and does not call gateway", async () => {
    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
      fallback_threshold: Number.NaN,
    });
    expect(res.isError).toBe(true);
    expect(mockEvaluateIntent).not.toHaveBeenCalled();
  });

  it("rejects Infinity fallback_threshold and does not call gateway", async () => {
    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
      fallback_threshold: Number.POSITIVE_INFINITY,
    });
    expect(res.isError).toBe(true);
    expect(mockEvaluateIntent).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. FEATURE FLAG — PRISM_HDC_ENABLED
// ═══════════════════════════════════════════════════════════════════

describe("sessionCognitiveRouteHandler feature flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHdcEnabled = false;
  });

  afterEach(() => {
    mockHdcEnabled = true;
  });

  it("returns gated error when PRISM_HDC_ENABLED is false", async () => {
    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("disabled");
    expect(res.content[0].text).toContain("PRISM_HDC_ENABLED");
  });

  it("does NOT call PolicyGateway when disabled", async () => {
    await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
    });
    expect(mockEvaluateIntent).not.toHaveBeenCalled();
  });

  it("does NOT record telemetry when disabled", async () => {
    await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
    });
    expect(mockRecordCognitiveRoute).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. HAPPY PATH — Full pipeline with mocked SDM
// ═══════════════════════════════════════════════════════════════════

describe("sessionCognitiveRouteHandler happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHdcEnabled = true;
    mockExplainEnabled = true;
    mockStorage.getSetting.mockResolvedValue(null);
    mockEvaluateIntent.mockResolvedValue({
      route: "ACTION_AUTO_ROUTE",
      concept: "State:ActiveSession",
      confidence: 0.92,
      distance: 0.08,
      ambiguous: false,
      steps: 3,
    });
  });

  it("returns success with expected output lines", async () => {
    const res = await sessionCognitiveRouteHandler({
      project: "my-proj",
      state: "State:ActiveSession",
      role: "Role:dev",
      action: "Action:inspect",
    });

    expect(res.isError).toBe(false);
    const text = res.content[0].text;

    // Header
    expect(text).toContain("Cognitive Route");
    expect(text).toContain("my-proj");

    // Input echo
    expect(text).toContain("State: State:ActiveSession");
    expect(text).toContain("Role: Role:dev");
    expect(text).toContain("Action: Action:inspect");

    // Result fields
    expect(text).toContain("Route: ACTION_AUTO_ROUTE");
    expect(text).toContain("Concept: State:ActiveSession");
    expect(text).toContain("Confidence: 92.00%");
    expect(text).toContain("Distance: 0.08");
    expect(text).toContain("Ambiguous: no");
    expect(text).toContain("Convergence Steps: 3");
  });

  it("includes explainability section when both flags are true", async () => {
    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
      explain: true,
    });

    expect(res.isError).toBe(false);
    const text = res.content[0].text;
    expect(text).toContain("Explainability:");
    expect(text).toContain("Policy thresholds:");
    expect(text).toContain("Routing logic:");
  });

  it("omits explainability when explain=false", async () => {
    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
      explain: false,
    });

    expect(res.isError).toBe(false);
    expect(res.content[0].text).not.toContain("Explainability:");
  });

  it("omits explainability when PRISM_HDC_EXPLAINABILITY_ENABLED is false", async () => {
    mockExplainEnabled = false;
    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
      explain: true,
    });

    expect(res.isError).toBe(false);
    expect(res.content[0].text).not.toContain("Explainability:");
    mockExplainEnabled = true;
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. THRESHOLD VALIDATION + STORAGE PARITY
// ═══════════════════════════════════════════════════════════════════

describe("sessionCognitiveRouteHandler threshold semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHdcEnabled = true;
    mockStorage.getSetting.mockResolvedValue(null);
    mockEvaluateIntent.mockResolvedValue({
      route: "ACTION_AUTO_ROUTE",
      concept: "State:Test",
      confidence: 0.99,
      distance: 0.01,
      ambiguous: false,
      steps: 2,
    });
  });

  it("rejects fallback_threshold >= default clarify threshold", async () => {
    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
      fallback_threshold: 0.96, // >= 0.95 default clarify
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Invalid policy thresholds");
  });

  /**
   * Valid custom thresholds should be persisted via setSetting.
   * Exercises the Phase 2 storage parity contract:
   *   getSetting('hdc:fallback_threshold:...') / setSetting(key, String(value))
   */
  it("persists valid threshold overrides via setSetting", async () => {
    await sessionCognitiveRouteHandler({
      project: "my-proj", state: "State:Test", role: "Role:dev", action: "Action:inspect",
      fallback_threshold: 0.5, clarify_threshold: 0.8,
    });

    expect(mockStorage.setSetting).toHaveBeenCalledWith(
      "hdc:fallback_threshold:my-proj", "0.5"
    );
    expect(mockStorage.setSetting).toHaveBeenCalledWith(
      "hdc:clarify_threshold:my-proj", "0.8"
    );
  });

  it("reads persisted thresholds from storage when no override provided", async () => {
    mockStorage.getSetting.mockImplementation(async (key: string) => {
      if (key === "hdc:fallback_threshold:p") return "0.6";
      if (key === "hdc:clarify_threshold:p") return "0.9";
      return null;
    });

    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
    });

    expect(res.isError).toBe(false);
    expect(mockStorage.getSetting).toHaveBeenCalledWith("hdc:fallback_threshold:p");
    expect(mockStorage.getSetting).toHaveBeenCalledWith("hdc:clarify_threshold:p");
    // setSetting should NOT be called — no overrides provided
    expect(mockStorage.setSetting).not.toHaveBeenCalled();
  });


  it("uses default fallback when persisted fallback is corrupt but clarify is valid", async () => {
    mockStorage.getSetting.mockImplementation(async (key: string) => {
      if (key === "hdc:fallback_threshold:p") return "not-a-number";
      if (key === "hdc:clarify_threshold:p") return "0.9";
      return null;
    });

    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
    });

    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain("Route:");
  });

  it("uses default clarify when persisted clarify is corrupt but fallback is valid", async () => {
    mockStorage.getSetting.mockImplementation(async (key: string) => {
      if (key === "hdc:fallback_threshold:p") return "0.7";
      if (key === "hdc:clarify_threshold:p") return "bad";
      return null;
    });

    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
    });

    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain("Route:");
  });

  it("accepts fallback override only when persisted/default clarify remains valid", async () => {
    mockStorage.getSetting.mockImplementation(async (key: string) => {
      if (key === "hdc:clarify_threshold:p") return "0.93";
      return null;
    });

    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
      fallback_threshold: 0.5,
    });

    expect(res.isError).toBe(false);
    expect(mockStorage.setSetting).toHaveBeenCalledWith("hdc:fallback_threshold:p", "0.5");
    expect(mockStorage.setSetting).toHaveBeenCalledWith("hdc:clarify_threshold:p", "0.93");
  });

  it("accepts clarify override only when persisted/default fallback remains valid", async () => {
    mockStorage.getSetting.mockImplementation(async (key: string) => {
      if (key === "hdc:fallback_threshold:p") return "0.4";
      return null;
    });

    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
      clarify_threshold: 0.8,
    });

    expect(res.isError).toBe(false);
    expect(mockStorage.setSetting).toHaveBeenCalledWith("hdc:fallback_threshold:p", "0.4");
    expect(mockStorage.setSetting).toHaveBeenCalledWith("hdc:clarify_threshold:p", "0.8");
  });

  /**
   * getSetting / setSetting value encoding: thresholds should be encoded
   * as plain decimal strings. This is the parity contract between SQLite
   * and Supabase storage backends.
   */
  it("encodes thresholds as plain decimal strings (storage parity)", async () => {
    await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
      fallback_threshold: 0.42, clarify_threshold: 0.73,
    });

    const calls = mockStorage.setSetting.mock.calls;
    for (const [_key, value] of calls) {
      expect(typeof value).toBe("string");
      expect(Number.isFinite(Number(value))).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. METRICS TELEMETRY — recordCognitiveRoute shape
// ═══════════════════════════════════════════════════════════════════

describe("sessionCognitiveRouteHandler telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHdcEnabled = true;
    mockStorage.getSetting.mockResolvedValue(null);
    mockEvaluateIntent.mockResolvedValue({
      route: "ACTION_CLARIFY",
      concept: "State:Ambiguous",
      confidence: 0.88,
      distance: 0.12,
      ambiguous: true,
      steps: 5,
    });
  });

  it("calls recordCognitiveRoute with correct shape on success", async () => {
    await sessionCognitiveRouteHandler({
      project: "telemetry-proj", state: "State:Test", role: "Role:dev", action: "Action:inspect",
    });

    expect(mockRecordCognitiveRoute).toHaveBeenCalledTimes(1);
    const data = mockRecordCognitiveRoute.mock.calls[0][0];

    expect(data.project).toBe("telemetry-proj");
    expect(data.route).toBe("ACTION_CLARIFY");
    expect(data.concept).toBe("State:Ambiguous");
    expect(data.confidence).toBe(0.88);
    expect(data.distance).toBe(0.12);
    expect(data.ambiguous).toBe(true);
    expect(data.steps).toBe(5);
    expect(typeof data.duration_ms).toBe("number");
    expect(data.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("records finite duration for telemetry", async () => {
    await sessionCognitiveRouteHandler({
      project: "telemetry-proj", state: "State:Test", role: "Role:dev", action: "Action:inspect",
    });

    const data = mockRecordCognitiveRoute.mock.calls[0][0];
    expect(Number.isFinite(data.duration_ms)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. ERROR PATHS — SDM/Storage exceptions
// ═══════════════════════════════════════════════════════════════════

describe("sessionCognitiveRouteHandler error paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHdcEnabled = true;
    mockStorage.getSetting.mockResolvedValue(null);
  });

  it("returns isError when PolicyGateway.evaluateIntent throws", async () => {
    mockEvaluateIntent.mockRejectedValueOnce(new Error("SDM dimension mismatch"));

    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("SDM dimension mismatch");
  });

  it("does NOT record telemetry when PolicyGateway throws", async () => {
    mockEvaluateIntent.mockRejectedValueOnce(new Error("boom"));

    await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
    });

    expect(mockRecordCognitiveRoute).not.toHaveBeenCalled();
  });
  it("returns isError when storage.getSetting throws", async () => {
    mockStorage.getSetting.mockRejectedValueOnce(new Error("DB connection lost"));

    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("DB connection lost");
  });

  it("returns isError when storage.setSetting throws during override persistence", async () => {
    mockStorage.setSetting.mockRejectedValueOnce(new Error("persist failed"));

    const res = await sessionCognitiveRouteHandler({
      project: "p", state: "State:Test", role: "Role:dev", action: "Action:inspect",
      fallback_threshold: 0.5, clarify_threshold: 0.8,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("persist failed");
    expect(mockRecordCognitiveRoute).not.toHaveBeenCalled();
  });
});
