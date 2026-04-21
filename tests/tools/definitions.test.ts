/**
 * Tool Definition Tests — Type Guards & Schema Validation
 *
 * ═══════════════════════════════════════════════════════════════════
 * SCOPE:
 *   Tests the MCP tool schemas and type guard functions that
 *   validate incoming tool call arguments. These are the "front door"
 *   of every MCP tool — if type guards fail, args are rejected before
 *   they ever reach the handler.
 *
 * WHY THESE TESTS MATTER:
 *   Type guards are used in the MCP CallTool handler to validate
 *   arguments before passing them to storage. A broken type guard
 *   means the LLM's tool call silently fails with an unhelpful
 *   "Invalid arguments" error.
 *
 * WHAT WE TEST:
 *   1. isSessionSaveLedgerArgs — validates save_ledger arguments
 *   2. isSessionSaveHandoffArgs — validates save_handoff arguments
 *   3. isSessionLoadContextArgs — validates load_context arguments
 *   4. v3.0 role parameter in all three guards
 *   5. Agent Registry tool schemas (structure validation)
 *   6. Negative cases — invalid/missing required arguments
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  isSessionSaveLedgerArgs,
  isSessionSaveHandoffArgs,
  isSessionLoadContextArgs,
  isSessionExportMemoryArgs,
  isSessionForgetMemoryArgs,
  SESSION_EXPORT_MEMORY_TOOL,
} from "../../src/tools/sessionMemoryDefinitions.js";
import {
  AGENT_REGISTER_TOOL,
  AGENT_HEARTBEAT_TOOL,
  AGENT_LIST_TEAM_TOOL,
  ROLE_ICONS,
  getRoleIcon,
} from "../../src/tools/agentRegistryDefinitions.js";

// ═══════════════════════════════════════════════════════════════════
// 1. SESSION SAVE LEDGER — Type Guard
// ═══════════════════════════════════════════════════════════════════

describe("isSessionSaveLedgerArgs", () => {
  /**
   * Tests that a minimal valid argument set passes the guard.
   * Required fields: project, conversation_id, summary
   */
  it("should accept valid args with required fields only", () => {
    const args = {
      project: "my-app",
      conversation_id: "conv-123",
      summary: "Implemented feature X",
    };

    expect(isSessionSaveLedgerArgs(args)).toBe(true);
  });

  /**
   * Tests that all optional fields are accepted.
   * Optional fields: todos, files_changed, decisions, role
   */
  it("should accept valid args with all optional fields", () => {
    const args = {
      project: "my-app",
      conversation_id: "conv-123",
      summary: "Implemented feature X",
      todos: ["Deploy to staging"],
      files_changed: ["src/app.ts"],
      decisions: ["Use middleware pattern"],
      role: "dev", // v3.0
    };

    expect(isSessionSaveLedgerArgs(args)).toBe(true);
  });

  /**
   * v3.0: Tests that the role field is accessible after type narrowing.
   * This is the critical test — if role isn't in the type guard's
   * return type, TypeScript will reject `args.role` in the handler.
   */
  it("should allow role access after type narrowing (v3.0)", () => {
    const args: unknown = {
      project: "my-app",
      conversation_id: "conv-123",
      summary: "QA found bugs",
      role: "qa",
    };

    if (isSessionSaveLedgerArgs(args)) {
      // This line would fail to compile if role wasn't in the type guard
      expect(args.role).toBe("qa");
    } else {
      // Should never reach here
      expect.unreachable("Type guard should accept valid args");
    }
  });

  /**
   * Tests rejection when project is missing.
   * The guard checks for typeof project === "string".
   */
  it("should reject args without project", () => {
    expect(isSessionSaveLedgerArgs({
      conversation_id: "conv-123",
      summary: "Test",
    })).toBe(false);
  });

  /**
   * Tests rejection when summary is not a string.
   */
  it("should reject args with non-string summary", () => {
    expect(isSessionSaveLedgerArgs({
      project: "my-app",
      conversation_id: "conv-123",
      summary: 42, // wrong type
    })).toBe(false);
  });

  /**
   * Tests rejection of null and undefined inputs.
   * The guard checks typeof args === "object" && args !== null.
   */
  it("should reject null and undefined", () => {
    expect(isSessionSaveLedgerArgs(null)).toBe(false);
    expect(isSessionSaveLedgerArgs(undefined)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. SESSION SAVE HANDOFF — Type Guard
// ═══════════════════════════════════════════════════════════════════

describe("isSessionSaveHandoffArgs", () => {
  /**
   * Tests minimal valid args — only project is required.
   */
  it("should accept args with only project", () => {
    expect(isSessionSaveHandoffArgs({ project: "my-app" })).toBe(true);
  });

  /**
   * Tests full args including v3.0 role and v0.4.0 expected_version.
   */
  it("should accept args with role and expected_version", () => {
    const args = {
      project: "my-app",
      last_summary: "Completed auth refactor",
      open_todos: ["Deploy"],
      active_branch: "main",
      key_context: "All tests passing",
      expected_version: 42,
      role: "dev", // v3.0
    };

    expect(isSessionSaveHandoffArgs(args)).toBe(true);
  });

  /**
   * v3.0: Verifies role is accessible after narrowing.
   */
  it("should allow role access after narrowing (v3.0)", () => {
    const args: unknown = { project: "my-app", role: "lead" };

    if (isSessionSaveHandoffArgs(args)) {
      expect(args.role).toBe("lead");
    } else {
      expect.unreachable("Should pass guard");
    }
  });

  /**
   * Tests rejection when project is missing.
   */
  it("should reject args without project", () => {
    expect(isSessionSaveHandoffArgs({ last_summary: "Test" })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. SESSION LOAD CONTEXT — Type Guard
// ═══════════════════════════════════════════════════════════════════

describe("isSessionLoadContextArgs", () => {
  /**
   * Tests basic valid args.
   */
  it("should accept args with project only", () => {
    expect(isSessionLoadContextArgs({ project: "my-app" })).toBe(true);
  });

  /**
   * Tests with level and role — the full v3.0 interface.
   */
  it("should accept args with level and role (v3.0)", () => {
    const args = {
      project: "my-app",
      level: "deep" as const,
      role: "qa",
    };

    expect(isSessionLoadContextArgs(args)).toBe(true);
  });

  /**
   * v3.0: Verifies role is accessible after narrowing.
   */
  it("should allow role access after narrowing (v3.0)", () => {
    const args: unknown = { project: "my-app", role: "security" };

    if (isSessionLoadContextArgs(args)) {
      expect(args.role).toBe("security");
    } else {
      expect.unreachable("Should pass guard");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. AGENT REGISTRY — Tool Schema Validation
// ═══════════════════════════════════════════════════════════════════

describe("Agent Registry Tool Schemas", () => {
  /**
   * Tests that agent_register tool has the correct name and
   * required input properties.
   *
   * WHY: MCP indexers (Smithery, Glama) consume these schemas
   * to generate public documentation. Wrong schemas = confused users.
   */
  it("agent_register should have correct schema", () => {
    expect(AGENT_REGISTER_TOOL.name).toBe("agent_register");

    const props = AGENT_REGISTER_TOOL.inputSchema.properties as Record<string, any>;

    // Required: project and role
    expect(props.project).toBeDefined();
    expect(props.role).toBeDefined();

    // Optional: agent_name, current_task
    expect(props.agent_name).toBeDefined();
    expect(props.current_task).toBeDefined();

    // Required fields should be listed
    const required = AGENT_REGISTER_TOOL.inputSchema.required;
    expect(required).toContain("project");
    expect(required).toContain("role");
  });

  /**
   * Tests the heartbeat tool schema.
   */
  it("agent_heartbeat should have correct schema", () => {
    expect(AGENT_HEARTBEAT_TOOL.name).toBe("agent_heartbeat");

    const props = AGENT_HEARTBEAT_TOOL.inputSchema.properties as Record<string, any>;
    expect(props.project).toBeDefined();
    expect(props.role).toBeDefined();
  });

  /**
   * Tests the list_team tool schema.
   */
  it("agent_list_team should have correct schema", () => {
    expect(AGENT_LIST_TEAM_TOOL.name).toBe("agent_list_team");

    const props = AGENT_LIST_TEAM_TOOL.inputSchema.properties as Record<string, any>;
    expect(props.project).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. ROLE ICONS — Visual Identity
// ═══════════════════════════════════════════════════════════════════

describe("Role Icons", () => {
  /**
   * Tests that all built-in roles have icons assigned.
   * These icons appear in the dashboard Hivemind Radar and
   * in tool responses when listing team members.
   */
  it("should have icons for all built-in roles", () => {
    const expectedRoles = ["dev", "qa", "pm", "lead", "security", "ux", "cmo"];

    for (const role of expectedRoles) {
      expect(ROLE_ICONS[role]).toBeDefined();
      // Icons should be emoji (non-empty strings)
      expect(ROLE_ICONS[role].length).toBeGreaterThan(0);
    }
  });

  /**
   * Tests the getRoleIcon helper function.
   * It should return the correct icon for known roles
   * and a default robot emoji for unknown roles.
   */
  it("should return default icon for unknown roles", () => {
    const customRoleIcon = getRoleIcon("custom-analyst");

    // Unknown roles get the default robot icon
    expect(customRoleIcon).toBeDefined();
    expect(typeof customRoleIcon).toBe("string");
  });

  /**
   * Tests that known roles get their specific icons via getRoleIcon.
   */
  it("should return specific icons for known roles", () => {
    expect(getRoleIcon("dev")).toBe(ROLE_ICONS.dev);
    expect(getRoleIcon("qa")).toBe(ROLE_ICONS.qa);
    expect(getRoleIcon("pm")).toBe(ROLE_ICONS.pm);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. SESSION EXPORT MEMORY — Type Guard (v4.5.1)
// ═══════════════════════════════════════════════════════════════════

describe("isSessionExportMemoryArgs", () => {
  /**
   * WHY THIS TYPE GUARD MATTERS:
   * session_export_memory is the GDPR Article 20 export tool. Its only
   * required argument is `output_dir` — an absolute path string. If this
   * guard is too permissive, the handler would attempt to write to undefined
   * or non-string paths, causing confusing runtime errors instead of a clear
   * "output_dir is required" message.
   *
   * Unlike other tools, `project` is OPTIONAL here (omitting it exports all
   * projects). The guard must NOT require project, but MUST require output_dir.
   */

  it("accepts minimal valid args (output_dir only)", () => {
    expect(isSessionExportMemoryArgs({ output_dir: path.join(os.tmpdir(), "exports") })).toBe(true);
  });

  it("accepts full args (project + format + output_dir)", () => {
    expect(isSessionExportMemoryArgs({
      project:    "my-project",
      format:     "json",
      output_dir: "/Users/admin/Desktop",
    })).toBe(true);
  });

  it("accepts markdown format", () => {
    expect(isSessionExportMemoryArgs({
      format:     "markdown",
      output_dir: path.join(os.tmpdir(), "exports"),
    })).toBe(true);
  });

  it("rejects missing output_dir", () => {
    // The only required field — omit it and the guard must return false
    expect(isSessionExportMemoryArgs({ project: "my-app", format: "json" })).toBe(false);
  });

  it("rejects output_dir that is a number, not a string", () => {
    expect(isSessionExportMemoryArgs({ output_dir: 12345 })).toBe(false);
  });

  it("rejects output_dir that is null", () => {
    expect(isSessionExportMemoryArgs({ output_dir: null })).toBe(false);
  });

  it("rejects null args", () => {
    expect(isSessionExportMemoryArgs(null)).toBe(false);
  });

  it("rejects undefined args", () => {
    expect(isSessionExportMemoryArgs(undefined)).toBe(false);
  });

  it("rejects a plain string (the path itself, not an args object)", () => {
    // Common mistake: LLM passes the path directly instead of { output_dir: path }
    expect(isSessionExportMemoryArgs(path.join(os.tmpdir(), "exports"))).toBe(false);
  });

  it("allows project to be omitted (exports all projects when absent)", () => {
    // project is OPTIONAL in the schema — omitting it is valid
    const args: unknown = { output_dir: path.join(os.tmpdir(), "exports") };
    if (isSessionExportMemoryArgs(args)) {
      // project should be accessible but undefined
      expect(args.output_dir).toBe(path.join(os.tmpdir(), "exports"));
      expect(args.project).toBeUndefined();
    } else {
      expect.unreachable("Guard should accept args without project");
    }
  });

  it("allows output_dir access after type narrowing", () => {
    const args: unknown = { output_dir: "/Users/admin/Desktop", format: "json" as const };
    if (isSessionExportMemoryArgs(args)) {
      expect(args.output_dir).toBe("/Users/admin/Desktop");
      expect(args.format).toBe("json");
    } else {
      expect.unreachable("Guard should accept valid args");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. SESSION_EXPORT_MEMORY_TOOL — MCP Schema Shape (v4.5.1)
// ═══════════════════════════════════════════════════════════════════

describe("SESSION_EXPORT_MEMORY_TOOL schema shape", () => {
  /**
   * WHY THESE TESTS EXIST:
   *
   * The tool definition object is the contract that MCP clients (Claude,
   * Cursor, etc.) use to discover and call the tool. If the schema is
   * malformed, the client either:
   *   a) Refuses to surface the tool to the LLM (JSON Schema invalid)
   *   b) Generates incorrect arguments (wrong required fields)
   *   c) Fails validation on the server (enum values don't match)
   *
   * These tests pin the critical shape properties so that a future
   * refactor of sessionMemoryDefinitions.ts cannot silently break
   * the public-facing GDPR export surface without a test failure.
   *
   * WHAT WE TEST:
   *   - Tool name matches the MCP routing string in server.ts
   *   - Description mentions both GDPR article reference and key features
   *   - inputSchema.type is "object" (JSON Schema requirement)
   *   - output_dir is in inputSchema.required (only required field)
   *   - project is NOT in required (optional — omit to export all projects)
   *   - format enum values are exactly ["json", "markdown"] — in that order
   *   - format default is "json" (drives client UI pre-selection)
   *   - output_dir.type is "string" (rejects numeric paths at schema level)
   */

  it("name is 'session_export_memory' (matches server.ts routing switch-case)", () => {
    /**
     * WHY: server.ts routes tool calls via:
     *   case "session_export_memory": return sessionExportMemoryHandler(args);
     * If the tool's name field ever drifts from this string, the tool becomes
     * unreachable — requests will fall through to the default "unknown tool" error.
     */
    expect(SESSION_EXPORT_MEMORY_TOOL.name).toBe("session_export_memory");
  });

  it("description mentions GDPR Article 20 (data portability compliance reference)", () => {
    /**
     * WHY: The description is what the LLM reads to decide when to call this tool.
     * If the GDPR reference is removed, LLMs trained on privacy-sensitive queries
     * may not invoke the tool when a user says "export my data for GDPR compliance".
     */
    expect(SESSION_EXPORT_MEMORY_TOOL.description).toContain("GDPR Article 20");
  });

  it("description mentions both 'json' and 'markdown' export formats", () => {
    /**
     * WHY: The format enum is the main decision point for users. If the
     * description doesn't mention both formats, users may not know markdown
     * exists and will always receive JSON even when they want Obsidian-friendly
     * output.
     */
    expect(SESSION_EXPORT_MEMORY_TOOL.description).toContain("json");
    expect(SESSION_EXPORT_MEMORY_TOOL.description).toContain("markdown");
  });

  it("inputSchema.type is 'object'", () => {
    expect(SESSION_EXPORT_MEMORY_TOOL.inputSchema.type).toBe("object");
  });

  it("only 'output_dir' is in inputSchema.required (project and format are optional)", () => {
    /**
     * WHY: project is optional (omit it to export all projects).
     * format is optional (defaults to "json").
     * output_dir is the ONLY required field — without it, the handler
     * cannot write the export file anywhere.
     *
     * If someone accidentally adds "project" to the required array,
     * the multi-project export use-case breaks for all MCP clients that
     * respect JSON Schema (they will refuse to call the tool without project).
     */
    const required = SESSION_EXPORT_MEMORY_TOOL.inputSchema.required as string[];
    expect(required).toContain("output_dir");
    expect(required).not.toContain("project");
    expect(required).not.toContain("format");
    expect(required).toHaveLength(1);
  });

  it("format property has enum ['json', 'markdown'] and default 'json'", () => {
    /**
     * WHY: The enum is used by MCP clients to generate dropdown selectors.
     * If "markdown" is misspelled (e.g., "md") or removed, the client
     * cannot generate the right argument, and the handler falls through to
     * its default (json) silently. This test catches that regression.
     *
     * The `default: "json"` is advisory for clients — they can pre-select
     * it in UI. The handler also defaults to json at runtime.
     */
    const formatProp = SESSION_EXPORT_MEMORY_TOOL.inputSchema.properties!["format"] as {
      type: string;
      enum: string[];
      default: string;
    };
    expect(formatProp.enum).toEqual(["json", "markdown", "vault"]);
    expect(formatProp.default).toBe("json");
  });

  it("output_dir property type is 'string'", () => {
    /**
     * WHY: If someone changes output_dir to accept an array of paths
     * (for future multi-destination export), the type would change from
     * "string" to "array". This test documents the current single-string
     * contract and must be explicitly updated alongside any such change.
     */
    const outputDirProp = SESSION_EXPORT_MEMORY_TOOL.inputSchema.properties!["output_dir"] as {
      type: string;
      description: string;
    };
    expect(outputDirProp.type).toBe("string");
  });

  it("project property is defined in properties (present but optional)", () => {
    /**
     * WHY: Even though project is optional (not in required), it MUST still
     * be declared in properties so JSON Schema validators and MCP clients
     * know the field exists and what type to expect. Without this declaration,
     * strict validators would reject any call that includes project.
     */
    expect(SESSION_EXPORT_MEMORY_TOOL.inputSchema.properties).toHaveProperty("project");
    const projectProp = SESSION_EXPORT_MEMORY_TOOL.inputSchema.properties!["project"] as { type: string };
    expect(projectProp.type).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. isSessionForgetMemoryArgs — Type Guard (v4.4 GDPR Article 17)
// ═══════════════════════════════════════════════════════════════════

describe("isSessionForgetMemoryArgs", () => {
  /**
   * WHY THIS TYPE GUARD MATTERS:
   *
   * session_forget_memory is Prism's GDPR Article 17 (Right to Erasure)
   * implementation. It is an irreversible operation — a soft-delete
   * (tombstone) or hard-delete (permanent erasure) of a specific ledger
   * entry by UUID.
   *
   * The guard's only job: ensure `memory_id` is a non-empty string.
   * Without this check, the handler might receive:
   *   - undefined memory_id → SQL WHERE id = undefined → 0 rows affected
   *   - numeric 42         → type mismatch in UUID comparison
   *   - null               → runtime TypeError in string concatenation
   *
   * All of the above would make the deletion silently fail — the user
   * believes data was deleted when it wasn't. The guard prevents this
   * by rejecting invalid args before any SQL runs.
   *
   * OPTIONAL FIELDS (NOT validated by guard — handler handles them):
   *   - hard_delete?: boolean  (default: false → soft-delete)
   *   - reason?: string        (GDPR audit trail)
   */

  it("accepts minimal valid args (memory_id only — the only required field)", () => {
    expect(isSessionForgetMemoryArgs({ memory_id: "abc123-uuid" })).toBe(true);
  });

  it("accepts full args (memory_id + hard_delete + reason)", () => {
    /**
     * WHY: Verifies that optional fields don't confuse the guard.
     * The guard checks for memory_id; presence of additional fields is fine.
     */
    expect(isSessionForgetMemoryArgs({
      memory_id:   "550e8400-e29b-41d4-a716-446655440000",
      hard_delete: true,
      reason:      "GDPR Article 17 user request",
    })).toBe(true);
  });

  it("accepts args with hard_delete: false (soft-delete, the default case)", () => {
    expect(isSessionForgetMemoryArgs({
      memory_id:   "some-uuid",
      hard_delete: false,  // explicit false — should not confuse the guard
    })).toBe(true);
  });

  it("rejects missing memory_id (empty object)", () => {
    /**
     * WHY: The most common call-of-care bug — LLM provides an empty object.
     * The handler must reject this before touching the database.
     */
    expect(isSessionForgetMemoryArgs({})).toBe(false);
  });

  it("rejects memory_id that is a number, not a string", () => {
    /**
     * WHY: UUIDs are always strings. If an LLM provides a numeric row ID
     * (e.g., from a hallucinated API), the SQL comparison `WHERE id = 42`
     * would silently affect 0 rows (type mismatch in UUID column).
     */
    expect(isSessionForgetMemoryArgs({ memory_id: 42 })).toBe(false);
  });

  it("rejects memory_id that is null", () => {
    /**
     * WHY: null coerces to \"null\" in some string contexts, which would
     * run `DELETE WHERE id = 'null'` — a no-op that the user thinks succeeded.
     */
    expect(isSessionForgetMemoryArgs({ memory_id: null })).toBe(false);
  });

  it("rejects memory_id that is a boolean", () => {
    expect(isSessionForgetMemoryArgs({ memory_id: true })).toBe(false);
  });

  it("rejects null args entirely", () => {
    expect(isSessionForgetMemoryArgs(null)).toBe(false);
  });

  it("rejects undefined args entirely", () => {
    expect(isSessionForgetMemoryArgs(undefined)).toBe(false);
  });

  it("rejects a plain string (UUID passed directly instead of wrapped object)", () => {
    /**
     * WHY: A common LLM mistake is to pass the UUID as the top-level argument
     * rather than wrapping it: `"550e8400-uuid"` instead of `{ memory_id: "550e8400-uuid" }`.
     * Must be caught before reaching the handler.
     */
    expect(isSessionForgetMemoryArgs("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });

  it("confirms memory_id is accessible after type narrowing (TypeScript guard contract)", () => {
    /**
     * WHY: This is a TypeScript compilation test disguised as a runtime test.
     * If the return type `args is { memory_id: string; hard_delete?: boolean; reason?: string }`
     * drifts from the guard's actual behavior, TypeScript would emit a compile
     * error here — preventing the merge rather than causing a runtime surprise.
     */
    const args: unknown = { memory_id: "test-uuid", hard_delete: false, reason: "test" };
    if (isSessionForgetMemoryArgs(args)) {
      // TypeScript narrows `args` here — all fields must be accessible without cast
      expect(args.memory_id).toBe("test-uuid");
      expect(args.hard_delete).toBe(false);
      expect(args.reason).toBe("test");
    } else {
      expect.unreachable("Guard should accept valid forget args");
    }
  });
});
