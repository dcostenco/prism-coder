/**
 * prism-route hook — install machinery and the hook script itself.
 *
 * The failure this feature exists to prevent is "shipped but never activated":
 * hooks that lived on one machine because a bootstrap script ran there once.
 * So the tests that matter are idempotence, preservation of OTHER people's
 * hooks, and the script's never-break-the-turn contract.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  ensurePromptRouteHook,
  PROMPT_ROUTE_HOOK_SCRIPT,
  PROMPT_ROUTE_HOOK_VERSION,
} from "../src/promptRouteHostHook.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "prism-hook-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const claudeConfig = () => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
const codexConfig = () => JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));

describe("install", () => {
  it("installs script + registration for BOTH hosts", () => {
    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    expect(results.map((r) => `${r.host}:${r.script}:${r.config}`).sort()).toEqual([
      "claude:installed:registered",
      "codex:installed:registered",
    ]);
    for (const cfg of [claudeConfig(), codexConfig()]) {
      // JSON.stringify doubles backslashes on Windows; normalize before matching.
      const cmds = JSON.stringify(cfg.hooks.UserPromptSubmit).replace(/\\+/g, "/");
      // The version rides in the CONFIGURED COMMAND: Codex's trust hash covers
      // the definition, not the script file, so a version-refreshed script
      // behind a stable command would silently change trusted content.
      expect(cmds).toContain(`prism-route/on_prompt.py --v${PROMPT_ROUTE_HOOK_VERSION}`);
    }
    expect(existsSync(join(home, ".claude", "hooks", "prism-route", "on_prompt.py"))).toBe(true);
    expect(existsSync(join(home, ".codex", "hooks", "prism-route", "state"))).toBe(true);
  });

  it("is idempotent — second run writes nothing and registers nothing twice", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} });
    const before = readFileSync(join(home, ".claude", "settings.json"), "utf8");
    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    expect(results.every((r) => r.script === "unchanged" && r.config === "unchanged")).toBe(true);
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(before);
  });

  it("preserves hooks that are not ours — the config is shared real estate", () => {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        env: { KEEP: "me" },
        hooks: {
          UserPromptSubmit: [
            { matcher: "*", hooks: [{ type: "command", command: "python3 /x/screenshot-first/detect.py", timeout: 5 }] },
          ],
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/y/gate.py" }] }],
        },
      }),
    );
    ensurePromptRouteHook({ homeDir: home, env: {} });
    const cfg = claudeConfig();
    expect(cfg.env.KEEP).toBe("me");
    expect(cfg.hooks.PreToolUse).toHaveLength(1);
    expect(cfg.hooks.UserPromptSubmit).toHaveLength(2);
    expect(JSON.stringify(cfg.hooks.UserPromptSubmit[0])).toContain("screenshot-first");
  });

  it("a version bump UPDATES the registered command in place — no duplicate, new trust hash", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} });
    // Simulate a previous release: old marker AND an old-style command.
    const cfgPath = join(home, ".codex", "hooks.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const hook = cfg.hooks.UserPromptSubmit[0].hooks[0];
    hook.command = hook.command.replace(/ --v\d+$/, " --v0");
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    writeFileSync(join(home, ".codex", "hooks", "prism-route", ".prism-managed.json"),
      JSON.stringify({ managedBy: "prism", version: "0" }));

    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    const codex = results.find((r) => r.host === "codex");
    expect(codex?.config).toBe("updated");
    const after = JSON.parse(readFileSync(cfgPath, "utf8"));
    const cmds = after.hooks.UserPromptSubmit.flatMap((e: { hooks: Array<{ command: string }> }) => e.hooks.map((h) => h.command));
    expect(cmds.filter((c: string) => c.includes("prism-route"))).toHaveLength(1); // replaced, not appended
    expect(cmds[0]).toContain(`--v${PROMPT_ROUTE_HOOK_VERSION}`);
  });

  it("codex registration carries additionalContextLimit: 0 — the default (~2,500 tokens) truncates our payload to a preview", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} });
    const entry = codexConfig().hooks.UserPromptSubmit.find((e: unknown) => JSON.stringify(e).includes("prism-route"));
    expect(entry.hooks[0].additionalContextLimit).toBe(0);
  });

  it("claude registration does NOT carry the codex-only field — no unknown keys in settings.json", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} });
    const entry = claudeConfig().hooks.UserPromptSubmit.find((e: unknown) => JSON.stringify(e).includes("prism-route"));
    expect("additionalContextLimit" in entry.hooks[0]).toBe(false);
  });

  it("a codex entry missing the field is CONVERGED in place — no duplicate entry", () => {
    // The state every machine registered before this fix is in right now.
    ensurePromptRouteHook({ homeDir: home, env: {} });
    const cfgPath = join(home, ".codex", "hooks.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    delete cfg.hooks.UserPromptSubmit[0].hooks[0].additionalContextLimit;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    expect(results.find((r) => r.host === "codex")?.config).toBe("updated");
    const after = JSON.parse(readFileSync(cfgPath, "utf8"));
    const ours = after.hooks.UserPromptSubmit.flatMap((e: { hooks: Array<{ command: string }> }) => e.hooks)
      .filter((h: { command: string }) => h.command.includes("prism-route"));
    expect(ours).toHaveLength(1); // converged, not appended
    expect((ours[0] as { additionalContextLimit?: number }).additionalContextLimit).toBe(0);
  });

  it("codex results carry the approval hint — registered is NOT active", () => {
    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    expect(results.find((r) => r.host === "codex")?.codexApproval).toBe("pending-or-unknown");
    expect(results.find((r) => r.host === "claude")?.codexApproval).toBeUndefined();
  });

  it("refreshes the script when the version marker is older", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} });
    const marker = join(home, ".claude", "hooks", "prism-route", ".prism-managed.json");
    writeFileSync(marker, JSON.stringify({ managedBy: "prism", version: "0" }));
    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    const claude = results.find((r) => r.host === "claude");
    expect(claude?.script).toBe("refreshed");
    expect(JSON.parse(readFileSync(marker, "utf8")).version).toBe(PROMPT_ROUTE_HOOK_VERSION);
  });

  it("skips a host whose root does not exist rather than creating it", () => {
    rmSync(join(home, ".codex"), { recursive: true });
    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    expect(results.map((r) => r.host)).toEqual(["claude"]);
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  it("honours CODEX_HOME", () => {
    const alt = join(home, "custom-codex");
    mkdirSync(alt, { recursive: true });
    const results = ensurePromptRouteHook({ homeDir: home, env: { CODEX_HOME: alt } });
    const codex = results.find((r) => r.host === "codex");
    expect(codex?.configPath).toBe(join(alt, "hooks.json"));
    expect(existsSync(join(alt, "hooks", "prism-route", "on_prompt.py"))).toBe(true);
  });
});

describe("opt-out — disabled marker survives upgrades", () => {
  it("a marker with disabled:true blocks reinstall AND re-registration on every path", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} });
    const hookDir = join(home, ".claude", "hooks", "prism-route");
    // Operator turns it off: marks disabled, removes the registration.
    writeFileSync(join(hookDir, ".prism-managed.json"), JSON.stringify({ managedBy: "prism", disabled: true }));
    const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    cfg.hooks.UserPromptSubmit = [];
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(cfg, null, 2));

    // Upgrade paths must NOT resurrect it — self-healing must not be
    // self-reinfecting.
    for (const mode of ["explicit", "auto"] as const) {
      const results = ensurePromptRouteHook({ homeDir: home, env: {}, mode });
      expect(results.find((r) => r.host === "claude")).toBeUndefined();
    }
    const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(after.hooks.UserPromptSubmit).toEqual([]);
  });
});

describe("consent — auto paths must not touch a stranger's machine", () => {
  // prism-mcp-server is PUBLIC npm. postinstall and server-start run on every
  // machine that installs it, including people who never ran `prism connect`.
  // Rewriting their ~/.claude/settings.json would be consent they never gave.
  it("auto mode installs NOTHING on a host with no prior prism integration", () => {
    const results = ensurePromptRouteHook({ homeDir: home, env: {}, mode: "auto" });
    expect(results).toEqual([]);
    expect(existsSync(join(home, ".claude", "hooks", "prism-route"))).toBe(false);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });

  it("auto mode installs when the host's MCP config references prism — the machine was connected", () => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { "prism-mcp": { command: "node" } } }));
    writeFileSync(join(home, ".codex", "config.toml"), "[mcp_servers.prism]\ncommand = \"prism-coder\"\n");
    const results = ensurePromptRouteHook({ homeDir: home, env: {}, mode: "auto" });
    expect(results.map((r) => r.host).sort()).toEqual(["claude", "codex"]);
  });

  it("auto mode refreshes an existing managed install — the upgrade path stays alive", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} }); // explicit first install
    const marker = join(home, ".claude", "hooks", "prism-route", ".prism-managed.json");
    writeFileSync(marker, JSON.stringify({ managedBy: "prism", version: "0" }));
    const results = ensurePromptRouteHook({ homeDir: home, env: {}, mode: "auto" });
    expect(results.find((r) => r.host === "claude")?.script).toBe("refreshed");
  });

  it("explicit mode (prism connect) needs no prior evidence — connect IS the consent", () => {
    const results = ensurePromptRouteHook({ homeDir: home, env: {}, mode: "explicit" });
    expect(results).toHaveLength(2);
  });
});

// The script itself is exercised with a bash stub CLI and POSIX chmod; the
// hosts this hook serves on Windows execute the same python, but the harness
// is POSIX-only, so the behaviour suite runs on POSIX runners.
describe.skipIf(process.platform === "win32")("the hook script — never breaks the turn", () => {
  // Run the ACTUAL script under python3 with a stub CLI, exactly as a host
  // would: JSON on stdin, JSON on stdout.
  let hookDir: string;
  let script: string;
  let stub: string;

  beforeEach(() => {
    hookDir = join(home, ".claude", "hooks", "prism-route");
    mkdirSync(hookDir, { recursive: true });
    script = join(hookDir, "on_prompt.py");
    writeFileSync(script, PROMPT_ROUTE_HOOK_SCRIPT);
    chmodSync(script, 0o755);
    // Stub prism CLI: routes when --loaded is empty, dedupes when not.
    stub = join(home, "stub-prism");
    writeFileSync(
      stub,
      `#!/bin/bash
if [ "$1" != "route-prompt" ]; then echo '{"names":[],"text":""}'; exit 0; fi
if [ "$3" = "" ]; then echo '{"names":["visual-screenshot-verification"],"text":"SKILL BODY HERE"}'; else echo '{"names":[],"text":""}'; fi
`,
    );
    chmodSync(stub, 0o755);
  });

  const run = (payload: unknown): { continue: boolean; hookSpecificOutput?: { additionalContext?: string } } =>
    JSON.parse(
      execFileSync("python3", [script], {
        input: JSON.stringify(payload),
        env: { ...process.env, PRISM_ROUTE_CLI: stub },
        encoding: "utf8",
      }).trim(),
    );

  it("injects context on a routed prompt", () => {
    const out = run({ prompt: "the totals are not sticky", session_id: "s1" });
    expect(out.continue).toBe(true);
    expect(out.hookSpecificOutput?.additionalContext).toBe("SKILL BODY HERE");
  });

  it("dedupes on the second prompt of the same session via its state file", () => {
    run({ prompt: "the totals are not sticky", session_id: "s2" });
    const state = JSON.parse(readFileSync(join(hookDir, "state", "s2.json"), "utf8"));
    expect(state).toEqual(["visual-screenshot-verification"]);
    const out = run({ prompt: "the totals are not sticky", session_id: "s2" });
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("passes through micro-prompts and slash commands without invoking the CLI", () => {
    for (const prompt of ["ok", "merge", "/model claude"]) {
      const out = run({ prompt, session_id: "s3" });
      expect(out).toEqual({ continue: true, suppressOutput: true });
    }
  });

  it("passes through when the CLI is missing — a broken install must not block prompts", () => {
    // PATH is emptied so the script's own `which prism` finds nothing; python3
    // itself must then be launched by absolute path.
    const python3 = execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
    const out = JSON.parse(
      execFileSync(python3, [script], {
        input: JSON.stringify({ prompt: "the totals are not sticky" }),
        env: { ...process.env, PRISM_ROUTE_CLI: "/does/not/exist", PATH: "/nonexistent", HOME: home },
        encoding: "utf8",
      }).trim(),
    );
    expect(out).toEqual({ continue: true, suppressOutput: true });
  });

  it("survives stdout pollution from node wrappers (dotenv banners etc.)", () => {
    writeFileSync(stub, `#!/bin/bash
echo "[dotenv] injected env (10) from .env"
echo '{"names":["visual-screenshot-verification"],"text":"BODY"}'
`);
    chmodSync(stub, 0o755);
    const out = run({ prompt: "the totals are not sticky", session_id: "s9" });
    expect(out.hookSpecificOutput?.additionalContext).toBe("BODY");
  });

  it("passes through on garbage stdin", () => {
    const out = JSON.parse(
      execFileSync("python3", [script], {
        input: "not json at all",
        env: { ...process.env, PRISM_ROUTE_CLI: stub },
        encoding: "utf8",
      }).trim(),
    );
    expect(out).toEqual({ continue: true, suppressOutput: true });
  });
});
