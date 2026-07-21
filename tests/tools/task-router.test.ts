/**
 * Task Router Tests (v7.1.0)
 *
 * Unit tests for the heuristic-based routing engine.
 * Tests cover: type guards, individual signals, composite routing,
 * cold-start/edge cases, and output payload structure.
 *
 * These tests are completely isolated — no database, no API calls.
 */

import { describe, it, expect, vi } from "vitest";

// Mock config to avoid pulling in the full dependency chain
vi.mock("../../src/config.js", () => ({
  PRISM_TASK_ROUTER_CONFIDENCE_THRESHOLD: 0.6,
  PRISM_TASK_ROUTER_MAX_CLAW_COMPLEXITY: 10,
}));

import { computeRoute } from "../../src/tools/taskRouterHandler.js";
import {
  isSessionTaskRouteArgs,
  SESSION_TASK_ROUTE_TOOL,
} from "../../src/tools/sessionMemoryDefinitions.js";
import {
  PRISM_INFER_TOOL,
  resolveRequestedModelCeiling,
} from "../../src/tools/prismInferHandler.js";

// ─── Type Guard Tests ────────────────────────────────────────

describe("isSessionTaskRouteArgs", () => {
  it("accepts valid minimal args", () => {
    expect(isSessionTaskRouteArgs({ task_description: "add a test" })).toBe(true);
  });

  it("accepts fully populated args", () => {
    expect(
      isSessionTaskRouteArgs({
        task_description: "scaffold a new component",
        files_involved: ["src/foo.ts", "src/bar.ts"],
        estimated_scope: "new_feature",
        project: "prism-mcp",
      })
    ).toBe(true);
  });

  it("rejects missing task_description", () => {
    expect(isSessionTaskRouteArgs({})).toBe(false);
    expect(isSessionTaskRouteArgs({ files_involved: ["a.ts"] })).toBe(false);
  });

  it("rejects non-string task_description", () => {
    expect(isSessionTaskRouteArgs({ task_description: 123 })).toBe(false);
    expect(isSessionTaskRouteArgs({ task_description: null })).toBe(false);
  });

  it("rejects invalid estimated_scope", () => {
    expect(
      isSessionTaskRouteArgs({ task_description: "do x", estimated_scope: "invalid" })
    ).toBe(false);
  });

  it("rejects non-array files_involved", () => {
    expect(
      isSessionTaskRouteArgs({ task_description: "do x", files_involved: "not-an-array" })
    ).toBe(false);
  });

  it("rejects files_involved with non-string items", () => {
    expect(
      isSessionTaskRouteArgs({ task_description: "do x", files_involved: [1, 2] })
    ).toBe(false);
  });

  it("rejects null and non-objects", () => {
    expect(isSessionTaskRouteArgs(null)).toBe(false);
    expect(isSessionTaskRouteArgs("a string")).toBe(false);
    expect(isSessionTaskRouteArgs(42)).toBe(false);
  });
});

// ─── Routing Result Shape Tests ──────────────────────────────

describe("computeRoute output shape", () => {
  it("advertises the bounded-high-complexity and hard-host-boundary contract", () => {
    expect(SESSION_TASK_ROUTE_TOOL.description).toMatch(/bounded high-complexity/i);
    expect(SESSION_TASK_ROUTE_TOOL.description).toMatch(/4B\/9B\/27B/);
    expect(SESSION_TASK_ROUTE_TOOL.description).toMatch(/architecture, security/i);
  });

  it("returns all required fields", () => {
    const result = computeRoute({ task_description: "create a new file" });
    expect(result).toHaveProperty("target");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("complexity_score");
    expect(result).toHaveProperty("rationale");
    expect(result).toHaveProperty("recommended_tool");
  });

  it("target is either 'claw' or 'host'", () => {
    const result = computeRoute({ task_description: "fix typo in README" });
    expect(["claw", "host"]).toContain(result.target);
  });

  it("confidence is between 0 and 1", () => {
    const result = computeRoute({ task_description: "add a comment" });
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("complexity_score is between 1 and 10", () => {
    const result = computeRoute({ task_description: "architect a microservice" });
    expect(result.complexity_score).toBeGreaterThanOrEqual(1);
    expect(result.complexity_score).toBeLessThanOrEqual(10);
  });

  it("recommends the exposed prism_infer executor with bounded local-first arguments", () => {
    const result = computeRoute({
      task_description: "fix typo in the readme, simple, straightforward",
      estimated_scope: "minor_edit",
      project: "prism-mcp",
    });
    if (result.target === "claw") {
      expect(result.recommended_tool).toBe(PRISM_INFER_TOOL.name);
      expect(result.recommended_args).toEqual({
        prompt: "fix typo in the readme, simple, straightforward",
        project: "prism-mcp",
        mode: "code",
        task_complexity: result.complexity_score,
        cloud_fallback: false,
        escalation: "report",
      });
    }
  });

  it("forwards complexity but leaves model and thinking selection to prism_infer", () => {
    const result = computeRoute({
      task_description: "scaffold a new REST endpoint",
      estimated_scope: "new_feature",
      project: "prism-mcp",
    });

    expect(result.target).toBe("claw");
    expect(result.complexity_score).toBe(4);
    expect(result.recommended_args).toMatchObject({
      task_complexity: result.complexity_score,
      cloud_fallback: false,
    });
    expect(result.recommended_args).not.toHaveProperty("model_ceiling");
    expect(result.recommended_args).not.toHaveProperty("think");
  });

  it.each([
    {
      label: "4B for a trivial bounded edit",
      args: {
        task_description: "fix typo in README, simple change",
        files_involved: ["README.md"],
        estimated_scope: "minor_edit" as const,
      },
      expectedCeiling: "4b",
    },
    {
      label: "9B for a bounded endpoint scaffold",
      args: {
        task_description: "scaffold a new REST endpoint",
        estimated_scope: "new_feature" as const,
      },
      expectedCeiling: "9b",
    },
    {
      label: "27B for a bounded difficult algorithm",
      args: {
        task_description:
          "Implement a self-contained dynamic programming algorithm from this complete specification with multiple edge cases.",
        files_involved: ["src/solver.ts"],
        estimated_scope: "new_feature" as const,
      },
      expectedCeiling: "27b",
    },
  ])("routes $label through prism_infer without pinning a model", ({ args, expectedCeiling }) => {
    const result = computeRoute(args);

    expect(result.target).toBe("claw");
    expect(result.recommended_tool).toBe(PRISM_INFER_TOOL.name);
    expect(result.recommended_args).not.toHaveProperty("model_ceiling");
    expect(resolveRequestedModelCeiling(result.recommended_args!)).toBe(expectedCeiling);
  });

  it("recommended_tool is null when target is host", () => {
    const result = computeRoute({
      task_description: "redesign the architecture of the entire system with a multi-step migration strategy",
      estimated_scope: "refactor",
    });
    if (result.target === "host") {
      expect(result.recommended_tool).toBeNull();
    }
  });
});

// ─── Routing Logic Tests ─────────────────────────────────────

describe("computeRoute routing logic", () => {
  it("routes simple file creation to claw", () => {
    const result = computeRoute({
      task_description: "create file for the new template stub",
      files_involved: ["src/template.ts"],
      estimated_scope: "minor_edit",
    });
    expect(result.target).toBe("claw");
    expect(result.complexity_score).toBeLessThanOrEqual(4);
  });

  it("routes typo fixes to claw", () => {
    const result = computeRoute({
      task_description: "fix typo in the config file, simple change",
      files_involved: ["src/config.ts"],
      estimated_scope: "minor_edit",
    });
    expect(result.target).toBe("claw");
  });

  it("routes architecture redesign to host", () => {
    const result = computeRoute({
      task_description: "redesign the architecture and implement a migration strategy for the database schema across multiple services",
      files_involved: ["src/db.ts", "src/models/", "src/api/", "src/migrations/", "src/services/", "tests/"],
      estimated_scope: "refactor",
    });
    expect(result.target).toBe("host");
    expect(result.complexity_score).toBeGreaterThan(4);
  });

  it("routes multi-step tasks to host", () => {
    const result = computeRoute({
      task_description: "First, refactor the handler. Second, update the tests. Third, update the documentation. Finally, update the changelog.",
    });
    expect(result.target).toBe("host");
  });

  it("routes complex debugging to host", () => {
    const result = computeRoute({
      task_description: "debug complex race condition in the concurrent request handler, investigate root cause and diagnose the issue",
      estimated_scope: "bug_fix",
    });
    expect(result.target).toBe("host");
  });

  it("routes simple test addition to claw", () => {
    const result = computeRoute({
      task_description: "add test for the new utility function, simple unit test",
      files_involved: ["tests/utils.test.ts"],
      estimated_scope: "minor_edit",
    });
    expect(result.target).toBe("claw");
  });

  it("routes security audit to host", () => {
    const result = computeRoute({
      task_description: "perform a security audit on the authentication module and analyze the vulnerability surface",
      estimated_scope: "refactor",
    });
    expect(result.target).toBe("host");
  });

  it.each([
    {
      label: "architecture judgment",
      task_description: "Design the architecture and migration strategy for services and persistence",
      files_involved: ["src/service.ts"],
      estimated_scope: "new_feature" as const,
    },
    {
      label: "security judgment",
      task_description: "Perform a security audit of authentication and investigate the vulnerability surface",
      files_involved: ["src/auth.ts"],
      estimated_scope: "bug_fix" as const,
    },
    {
      label: "host-tool workflow",
      task_description: "First, read files. Second, modify the file. Finally, run the tests.",
      files_involved: ["src/router.ts"],
      estimated_scope: "bug_fix" as const,
    },
    {
      label: "natural-language read-edit-verify workflow",
      task_description:
        "Read the Prism test harness, persist regression tests for the 4B, 9B, 27B and host-only routing matrix, update the real MCP live-test workflow, then run focused verification.",
      files_involved: [
        "tests/tools/task-router.test.ts",
        "scripts/prism-infer-live-test.mjs",
      ],
      estimated_scope: "bug_fix" as const,
    },
    {
      label: "concurrency diagnosis",
      task_description: "Diagnose the root cause of a race condition in the concurrent request handler",
      files_involved: ["src/handler.ts"],
      estimated_scope: "bug_fix" as const,
    },
  ])("keeps $label on the host even when the file scope looks bounded", (args) => {
    const result = computeRoute(args);

    expect(result.target).toBe("host");
    expect(result.recommended_tool).toBeNull();
    expect(result.recommended_args).toBeUndefined();
  });
});

// ─── Cold Start & Edge Cases ─────────────────────────────────

describe("computeRoute edge cases", () => {
  it("returns host with low confidence for empty-ish input", () => {
    const result = computeRoute({ task_description: "hi" });
    expect(result.target).toBe("host");
    expect(result.confidence).toBeLessThanOrEqual(0.6);
    expect(result.rationale).toContain("Insufficient");
  });

  it("returns host with low confidence for whitespace-only input", () => {
    const result = computeRoute({ task_description: "     " });
    expect(result.target).toBe("host");
    expect(result.rationale).toContain("Insufficient");
  });

  it("handles empty files_involved gracefully", () => {
    const result = computeRoute({
      task_description: "add a simple boilerplate template",
      files_involved: [],
    });
    // Should still route — file count signal is neutral (0)
    expect(["claw", "host"]).toContain(result.target);
  });

  it("handles no optional fields", () => {
    const result = computeRoute({ task_description: "do something with the code" });
    expect(["claw", "host"]).toContain(result.target);
    expect(result.rationale).toBeTruthy();
  });

  it("handles very long task descriptions", () => {
    const longDesc = "analyze ".repeat(500);
    const result = computeRoute({ task_description: longDesc });
    // Very long → host-favoring length signal
    expect(result.target).toBe("host");
  });
});

// ─── Scope Signal Tests ──────────────────────────────────────

describe("computeRoute scope influence", () => {
  const baseTask = "work on the codebase";

  it("minor_edit scope pushes toward claw", () => {
    const result = computeRoute({ task_description: baseTask, estimated_scope: "minor_edit" });
    const resultNone = computeRoute({ task_description: baseTask });
    // minor_edit should produce lower complexity than no scope
    expect(result.complexity_score).toBeLessThanOrEqual(resultNone.complexity_score);
  });

  it("refactor scope pushes toward host", () => {
    const result = computeRoute({ task_description: baseTask, estimated_scope: "refactor" });
    const resultNone = computeRoute({ task_description: baseTask });
    // refactor should produce higher complexity than no scope
    expect(result.complexity_score).toBeGreaterThanOrEqual(resultNone.complexity_score);
  });

  it("bug_fix scope stays moderate", () => {
    const result = computeRoute({ task_description: baseTask, estimated_scope: "bug_fix" });
    // bug_fix is moderate — not trivial, not maximum
    expect(result.complexity_score).toBeGreaterThanOrEqual(2);
    expect(result.complexity_score).toBeLessThanOrEqual(8);
  });
});
