/**
 * First-run E2E — the greeting a brand-new user actually receives.
 *
 * Drives the BUILT server (dist/server.js) over real stdio through the MCP
 * client, exactly as a host does. Unit tests call the handler directly and so
 * cannot catch a regression in transport, tool registration, or startup
 * wiring — the layers where "it works in the test" stops meaning "it works in
 * the product".
 *
 * Why this exists (2026-08-05): a scrubbed-environment probe found the free
 * tier greeting a first-time user with "Welcome back", three "Not loaded"
 * rows, and three statements of what they lacked — no next step, no price, no
 * dashboard, and the tool the greeting pointed at rejected its own documented
 * bare call. Every assertion below is one of those defects. They were fixed in
 * 20.7.0 and verified against the published tarball; this test keeps them fixed.
 *
 * Determinism: a scrubbed HOME (no config, no memory, no marker), skill sync
 * disabled (no network), and a dashboard port nothing listens on.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, "../../dist/server.js");

describe("first-run experience (E2E over stdio)", { timeout: 60_000 }, () => {
  let client: Client;
  let scrubHome: string;
  let greeting = "";
  let structured: Record<string, unknown> | null = null;

  beforeAll(async () => {
    // The suite runs after "Build TypeScript" in CI. Fail loudly rather than
    // silently passing against a stale or absent build.
    expect(existsSync(SERVER), `built server missing at ${SERVER} — run npm run build`).toBe(true);

    scrubHome = mkdtempSync(path.join(tmpdir(), "prism-first-run-e2e-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: scrubHome,
        USERPROFILE: scrubHome, // Windows equivalent of HOME
        PRISM_SKILL_SYNC_DISABLED: "true",
        PRISM_DASHBOARD_PORT: "1", // reserved; nothing ever listens here
      },
    });
    client = new Client({ name: "first-run-e2e", version: "1.0.0" });
    await client.connect(transport);

    const result = await client.callTool({
      name: "session_bootstrap",
      arguments: { prompt: "hello" },
    });
    greeting = String((result.content as Array<{ text?: string }>)?.[0]?.text ?? "");
    structured = (result.structuredContent as Record<string, unknown>) ?? null;
  });

  afterAll(async () => {
    try {
      await client?.close();
    } finally {
      // Best-effort: the server holds sqlite handles that Windows releases on
      // its own schedule. A cleanup failure must not fail a passing suite.
      try {
        rmSync(scrubHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch { /* temp dir is reclaimed by the OS */ }
    }
  });

  it("does not greet a first-time user as a returning one", () => {
    expect(greeting).toContain("Welcome to Prism");
    expect(greeting).not.toContain("Welcome back");
  });

  it("leads with actions, not with an inventory of what the user lacks", () => {
    expect(greeting).not.toContain("Not loaded");
    expect(greeting).toContain("onboarding_wizard");
    expect(greeting).toContain("session_save_ledger");
  });

  it("surfaces the paid tier on the one guaranteed impression", () => {
    // Before 20.7.0 upgrade_url appeared only AFTER hitting an entitlement
    // gate; the startup path referenced it zero times.
    expect(greeting).toContain("https://synalux.ai/pricing");
    expect(greeting).toContain("free");
  });

  it("reports the dashboard honestly instead of advertising a dead URL", () => {
    // Port 1 is not listening, so no URL may be promised.
    expect(greeting).toContain("not running");
    expect(greeting).not.toContain("http://localhost:1");
  });

  it("flags the run as first in structured output", () => {
    expect(structured).toMatchObject({ first_run: true, projects: [] });
    expect(typeof structured?.conversation_id).toBe("string");
  });

  it("the wizard the greeting points at accepts the bare call it documents", async () => {
    // This used to fail with "Invalid arguments": the first tool a new user
    // touches was also the first error they saw.
    const wizard = await client.callTool({ name: "onboarding_wizard", arguments: {} });
    expect(wizard.isError).not.toBe(true);
    const body = JSON.parse(String((wizard.content as Array<{ text?: string }>)?.[0]?.text ?? "{}"));
    expect(body.status).toBe("in_progress");
    expect(body.total_steps).toBe(8);
    expect(body.step_index).toBe(0);
  });

  it("advances the wizard instead of re-rendering step one", async () => {
    const first = JSON.parse(String((await client.callTool({
      name: "onboarding_wizard", arguments: { action: "start" },
    })).content?.[0]?.text ?? "{}"));
    const next = JSON.parse(String((await client.callTool({
      name: "onboarding_wizard", arguments: { action: "next", step: first.step_index },
    })).content?.[0]?.text ?? "{}"));
    expect(next.step_index).toBeGreaterThan(first.step_index);
    expect(next.current_step).not.toBe(first.current_step);
  });

  it("stops calling it a first run once the machine has bootstrapped", async () => {
    // Guards the false positive where "unconfigured" was read as "new", so a
    // user with saved sessions was greeted as a stranger every time.
    const second = await client.callTool({
      name: "session_bootstrap",
      arguments: { prompt: "hello again" },
    });
    const text = String((second.content as Array<{ text?: string }>)?.[0]?.text ?? "");
    expect((second.structuredContent as Record<string, unknown>)?.first_run).not.toBe(true);
    expect(text).not.toContain("first run detected");
  });
});
