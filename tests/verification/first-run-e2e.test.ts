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
 * disabled (no network), and a bound foreign HTTP server for the dashboard
 * probe. It deliberately does NOT assume a port is closed — "nothing listens
 * on port 1" held on macOS and was FALSE on the Windows runner, where
 * something answered 200 and the greeting advertised http://localhost:1.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, "../../dist/server.js");

describe("first-run experience (E2E over stdio)", { timeout: 60_000 }, () => {
  let client: Client;
  let scrubHome: string;
  let foreignServer: http.Server;
  let greeting = "";
  let structured: Record<string, string> | null = null;

  /**
   * Read the trailing <prism_session /> line. Replaced structuredContent,
   * which some hosts surface INSTEAD of the text block — dropping the whole
   * startup payload (see ledgerHandlers.buildSessionFactsLine).
   */
  const readSessionFacts = (text: string): Record<string, string> | null => {
    const match = text.match(/<prism_session ([^>]*)\/>/);
    if (!match) return null;
    const out: Record<string, string> = {};
    for (const [, k, v] of match[1].matchAll(/(\w+)="([^"]*)"/g)) out[k] = v;
    return out;
  };

  beforeAll(async () => {
    // The suite runs after "Build TypeScript" in CI. Fail loudly rather than
    // silently passing against a stale or absent build.
    expect(existsSync(SERVER), `built server missing at ${SERVER} — run npm run build`).toBe(true);

    // Point the dashboard probe at a REAL server that is not Prism, rather
    // than at a port assumed to be closed. "Nothing listens on port 1" is a
    // portability assumption, not a fact: on the Windows runner something
    // answered 200 there and the greeting advertised http://localhost:1.
    // A bound 404 responder is deterministic everywhere AND proves the
    // stronger property — identity is verified, not mere liveness.
    foreignServer = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end("not prism");
    });
    const foreignPort: number = await new Promise((done) => {
      foreignServer.listen(0, "127.0.0.1", () => done((foreignServer.address() as AddressInfo).port));
    });

    scrubHome = mkdtempSync(path.join(tmpdir(), "prism-first-run-e2e-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: scrubHome,
        USERPROFILE: scrubHome, // Windows equivalent of HOME
        PRISM_SKILL_SYNC_DISABLED: "true",
        PRISM_DASHBOARD_PORT: String(foreignPort),
      },
    });
    client = new Client({ name: "first-run-e2e", version: "1.0.0" });
    await client.connect(transport);

    const result = await client.callTool({
      name: "session_bootstrap",
      arguments: { prompt: "hello" },
    });
    greeting = String((result.content as Array<{ text?: string }>)?.[0]?.text ?? "");
    structured = readSessionFacts(greeting);
  });

  afterAll(async () => {
    try {
      await client?.close();
      await new Promise((done) => foreignServer?.close(() => done(null)));
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

  it("proves the save→recall loop in the first session, not the second", () => {
    // A memory product's payoff is structurally deferred: "it remembered"
    // can't be felt until you come back. Seed-and-show closes that gap — the
    // greeting seeds a demo memory and renders it RECALLED. The block below
    // is rendered exclusively from the storage read-back (never the local
    // variable), so its presence in this E2E — scrubbed HOME, built server,
    // real stdio — is evidence the save→recall round-trip works, not that a
    // string was concatenated.
    expect(greeting).toContain("saved a memory and recalled it from disk");
    expect(greeting).toContain("prism-demo");
    // The demo must announce its own removability — it is the user's disk.
    expect(greeting).toContain("delete it anytime");
  });

  it("surfaces the paid tier on the one guaranteed impression", () => {
    // Before 20.7.0 upgrade_url appeared only AFTER hitting an entitlement
    // gate; the startup path referenced it zero times.
    expect(greeting).toContain("https://synalux.ai/pricing");
    expect(greeting).toContain("free");
  });

  it("rejects a listener that is not Prism instead of advertising it", () => {
    // A foreign 404 responder is bound on that port, so a bare liveness check
    // would advertise someone else's service — on a dev machine, most likely
    // the user's own app on :3000.
    expect(greeting).toContain("not running");
    expect(greeting).not.toContain("http://localhost");
  });

  it("flags the run as first on the machine-readable session line", () => {
    // Must live in the TEXT: a host that prefers structuredContent renders it
    // and discards everything else, which is exactly how three weeks of
    // startup context went undelivered.
    expect(structured).toMatchObject({ first_run: "true", projects: "" });
    expect(structured?.conversation_id).toMatch(/^[0-9a-f-]{36}$/);
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
    expect(readSessionFacts(text)?.first_run).toBeUndefined();
    expect(text).not.toContain("first run detected");
    // The demo is one-shot: replaying it every session would turn the payoff
    // into noise and re-seed rows the user may have deleted.
    expect(text).not.toContain("saved a memory and recalled it");
  });
});
