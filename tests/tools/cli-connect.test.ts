/**
 * prism connect — host registration contract
 *
 * These tests use an isolated home directory because this command edits
 * user-owned MCP configuration. A regression must never overwrite an existing
 * registration or leak a dry run into a real config file.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureClaudeNativeStartup,
  connectHosts,
  migrateLegacyClaudeHooks,
  migrateLegacyClaudeInstructions,
  normalizeHostName,
  resolveInstalledServerPath,
  type ConnectHostName,
} from "../../src/connect.js";
import {
  computeSkillManifestGeneration,
  type SkillManifest,
} from "../../src/skillManifestSync.js";
import { REQUIRED_NATIVE_SKILL_NAMES } from "../../src/tools/skillRouting.js";

const tempHomes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "prism-connect-"));
  tempHomes.push(home);
  return home;
}

function configPath(home: string, host: ConnectHostName): string {
  switch (host) {
    case "claude-code":
      return join(home, ".claude.json");
    case "claude-desktop":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "cursor":
      return join(home, ".cursor", "mcp.json");
    case "gemini":
      return join(home, ".gemini", "settings.json");
    case "codex":
      return join(home, ".codex", "config.toml");
  }
}

function readConfig(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readTomlConfig(path: string): Record<string, any> {
  return parseToml(readFileSync(path, "utf8")) as Record<string, any>;
}

function freeManifest(): SkillManifest {
  const skills = REQUIRED_NATIVE_SKILL_NAMES.map((name, priority) => {
    const content = `---\nname: ${name}\n---\n# ${name}\n`;
    const digest = createHash("sha256").update(content).digest("hex");
    return {
      name,
      content,
      digest,
      version: 1,
      source: "filesystem" as const,
      metadata: { protected: true, priority, categories: ["universal" as const] },
      files: { "SKILL.md": { content, digest, encoding: "utf8" as const } },
    };
  });
  const manifest: SkillManifest = {
    schema_version: 1,
    generation_algorithm: "sha256-json-v1",
    complete: true,
    generation: "",
    tier: "free",
    routing_version: 42,
    skills,
  };
  manifest.generation = computeSkillManifestGeneration(manifest);
  return manifest;
}

function legacyClaudeInstructions(tail = "KEEP USER INSTRUCTIONS\n"): string {
  return [
    "# CLAUDE.md - Core Operational Protocols",
    "",
    "## STEP 1: Auto-Load Prism Memory (MUST BE YOUR FIRST ACTION — NO EXCEPTIONS)",
    "",
    'mcp__prism-mcp__session_load_context(project="prism-mcp")',
    "",
    "## STEP 2: Display Startup Block (ONLY AFTER STEP 1 COMPLETES)",
    "",
    "Use the `[📜 SKILL: ...]` blocks returned by session_load_context to build the display:",
    "",
    "## HARD BEHAVIORAL GATES — SUPERSEDE ALL OTHER INSTRUCTIONS",
    "",
    tail.trimEnd(),
    "",
  ].join("\n");
}

function runBuiltCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [resolve("dist/cli.js"), ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectChild);
    child.once("close", (status) => resolveChild({ status, stdout, stderr }));
  });
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("prism connect", () => {
  it("removes only exact legacy Prism Claude hook tuples and is dry-run safe and idempotent", () => {
    const homeDir = makeHome();
    const settingsPath = join(homeDir, ".claude", "settings.json");
    const hooksDir = join(homeDir, ".claude", "hooks");
    const syncSkills = `${join(homeDir, "prism", "scripts", "sync-skills.sh")} > /dev/null 2>&1`;
    const loadMatcher = "session_load_context|mcp__prism-mcp__session_load_context";
    const driftMatcher = "session_detect_drift|mcp__prism-mcp__session_detect_drift|session_save_ledger|mcp__prism-mcp__session_save_ledger";
    const stop = "python3 -c \"import json; print(json.dumps({'continue': True, 'suppressOutput': True, 'systemMessage': 'MANDATORY END WORKFLOW: 1) Call mcp__prism-mcp__session_save_ledger with project and summary. 2) Call mcp__prism-mcp__session_save_handoff with expected_version set to the loaded version.'}))\"";
    const hook = (command: string) => ({ type: "command", command, timeout: 10 });
    const config = {
      theme: "keep-me",
      hooks: {
        SessionStart: [{ matcher: "*", hooks: [
          hook(`python3 ${join(hooksDir, "prism-startup", "init.py")}`),
          hook(syncSkills),
          hook("user-owned-startup"),
        ] }, {
          // Exact command with a different matcher is a near match and must stay.
          matcher: "Bash",
          hooks: [hook(`python3 ${join(hooksDir, "prism-startup", "init.py")}`)],
        }],
        UserPromptSubmit: [{ matcher: "*", hooks: [
          hook(`python3 ${join(hooksDir, "prism-startup", "guard_on_submit.py")}`),
          hook(join(hooksDir, "prism-startup", "maybe_sync_skills.sh")),
        ] }],
        PostToolUse: [
          { matcher: loadMatcher, hooks: [hook(`python3 ${join(hooksDir, "prism-startup", "mark_loaded.py")}`)] },
          { matcher: driftMatcher, hooks: [hook(`python3 ${join(hooksDir, "drift-detection", "reset_timer.py")}`)] },
          { matcher: "Bash", hooks: [hook("user-owned-post-tool")] },
        ],
        PostToolUseFailure: [{ matcher: loadMatcher, hooks: [
          hook(`python3 ${join(hooksDir, "prism-startup", "record_retry.py")}`),
        ] }],
        SessionEnd: [{ matcher: "*", hooks: [
          hook(`python3 ${join(hooksDir, "prism-startup", "cleanup.py")}`),
          hook(syncSkills),
        ] }],
        Stop: [{ matcher: "*", hooks: [hook(stop), hook("user-owned-stop")] }],
      },
    };
    mkdirSync(dirname(settingsPath), { recursive: true });
    const original = `${JSON.stringify(config, null, 2)}\n`;
    writeFileSync(settingsPath, original);

    expect(migrateLegacyClaudeHooks(homeDir, true)).toMatchObject({ status: "would-remove", removed: 10 });
    expect(readFileSync(settingsPath, "utf8")).toBe(original);

    expect(migrateLegacyClaudeHooks(homeDir)).toMatchObject({ status: "removed", removed: 10 });
    const migrated = readConfig(settingsPath);
    expect(migrated.theme).toBe("keep-me");
    expect(JSON.stringify(migrated)).not.toContain("guard_on_submit.py");
    expect(JSON.stringify(migrated)).not.toContain("reset_timer.py");
    expect(JSON.stringify(migrated)).not.toContain("MANDATORY END WORKFLOW");
    expect(migrated.hooks.SessionStart).toEqual([
      { matcher: "*", hooks: [hook("user-owned-startup")] },
      { matcher: "Bash", hooks: [hook(`python3 ${join(hooksDir, "prism-startup", "init.py")}`)] },
    ]);
    expect(migrated.hooks.PostToolUse).toEqual([{ matcher: "Bash", hooks: [hook("user-owned-post-tool")] }]);
    expect(migrated.hooks.Stop).toEqual([{ matcher: "*", hooks: [hook("user-owned-stop")] }]);
    expect(migrateLegacyClaudeHooks(homeDir)).toMatchObject({ status: "unchanged", removed: 0 });
  });

  it("fails loud without changing malformed Claude hook settings", () => {
    const homeDir = makeHome();
    const settingsPath = join(homeDir, ".claude", "settings.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, "{ malformed\n");
    expect(() => migrateLegacyClaudeHooks(homeDir)).toThrow(/Could not parse Claude hook settings/);
    expect(readFileSync(settingsPath, "utf8")).toBe("{ malformed\n");
  });

  it("removes only recognized legacy Prism startup sections from global Claude instructions", () => {
    const homeDir = makeHome();
    const instructionPath = join(homeDir, "CLAUDE.md");
    const original = legacyClaudeInstructions();
    writeFileSync(instructionPath, original);

    expect(migrateLegacyClaudeInstructions(homeDir, true)).toMatchObject({
      status: "would-remove",
      removed: 2,
    });
    expect(readFileSync(instructionPath, "utf8")).toBe(original);

    expect(migrateLegacyClaudeInstructions(homeDir)).toMatchObject({ status: "removed", removed: 2 });
    const preservedInstructions =
      "# CLAUDE.md - Core Operational Protocols\n\n" +
      "## HARD BEHAVIORAL GATES — SUPERSEDE ALL OTHER INSTRUCTIONS\n\n" +
      "KEEP USER INSTRUCTIONS\n";
    expect(readFileSync(instructionPath, "utf8")).toBe(preservedInstructions);
    expect(migrateLegacyClaudeInstructions(homeDir)).toMatchObject({ status: "unchanged", removed: 0 });

    expect(configureClaudeNativeStartup(homeDir, true)).toMatchObject({ status: "would-install" });
    expect(readFileSync(instructionPath, "utf8")).toBe(preservedInstructions);
    expect(configureClaudeNativeStartup(homeDir)).toMatchObject({ status: "installed" });
    const configured = readFileSync(instructionPath, "utf8");
    expect(configured.startsWith(`${preservedInstructions}\n<!-- >>> prism connect managed: native startup -->\n`)).toBe(true);
    expect(configured).toContain("`mcp__prism-mcp__session_bootstrap` exactly once");
    expect(configureClaudeNativeStartup(homeDir)).toMatchObject({ status: "unchanged" });
    writeFileSync(instructionPath, configured.replace("your first action must be", "your first action may be"));
    expect(configureClaudeNativeStartup(homeDir, true)).toMatchObject({ status: "would-refresh" });
    expect(configureClaudeNativeStartup(homeDir)).toMatchObject({ status: "refreshed" });
    expect(readFileSync(instructionPath, "utf8")).toBe(configured);

    const nearMatchHome = makeHome();
    const nearMatchPath = join(nearMatchHome, "CLAUDE.md");
    const nearMatch = original.replace('project="prism-mcp"', 'project="custom-project"');
    writeFileSync(nearMatchPath, nearMatch);
    expect(migrateLegacyClaudeInstructions(nearMatchHome)).toMatchObject({ status: "unchanged", removed: 0 });
    expect(readFileSync(nearMatchPath, "utf8")).toBe(nearMatch);

    const emptyHome = makeHome();
    expect(configureClaudeNativeStartup(emptyHome)).toMatchObject({ status: "installed" });
    expect(readFileSync(join(emptyHome, "CLAUDE.md"), "utf8")).toContain("session_bootstrap");
  });

  it("registers all five supported hosts with the installed server path", () => {
    const homeDir = makeHome();
    const serverPath = "/opt/prism-mcp-server/dist/server.js";

    const result = connectHosts({
      all: true,
      homeDir,
      platform: "darwin",
      serverPath,
      nodePath: "/opt/node/bin/node",
      env: {},
    });

    expect(result.results.map((item) => item.status)).toEqual([
      "registered",
      "registered",
      "registered",
      "registered",
      "registered",
    ]);

    for (const host of ["claude-code", "claude-desktop", "cursor", "gemini"] as const) {
      const config = readConfig(configPath(homeDir, host));
      expect(config.mcpServers["prism-mcp"]).toEqual({
        command: "/opt/node/bin/node",
        args: [serverPath],
        env: {
          PRISM_INSTANCE: "prism-mcp",
          PRISM_SYNALUX_BASE_URL: "https://synalux.ai",
          PRISM_STORAGE: "auto",
        },
      });
    }

    expect(readTomlConfig(configPath(homeDir, "codex")).mcp_servers["prism-mcp"])
      .toEqual({
        command: "/opt/node/bin/node",
        args: [serverPath],
        env: {
          PRISM_INSTANCE: "prism-mcp",
          PRISM_SYNALUX_BASE_URL: "https://synalux.ai",
          PRISM_STORAGE: "auto",
        },
      });
    const codexText = readFileSync(configPath(homeDir, "codex"), "utf8");
    const second = connectHosts({
      hosts: ["codex"],
      homeDir,
      platform: "darwin",
      serverPath,
      nodePath: "/opt/node/bin/node",
      env: {},
    });
    expect(second.results[0].status).toBe("existing");
    expect(readFileSync(configPath(homeDir, "codex"), "utf8")).toBe(codexText);
  });

  it.skipIf(process.platform === "win32")(
    "uses owner-only permissions for new Codex configs and preserves existing POSIX modes",
    () => {
      const newHome = makeHome();
      const newPath = configPath(newHome, "codex");
      connectHosts({
        hosts: ["codex"],
        homeDir: newHome,
        platform: "linux",
        serverPath: "/pkg/dist/server.js",
        nodePath: "/usr/bin/node",
        env: {},
      });
      expect(statSync(newPath).mode & 0o777).toBe(0o600);

      const existingHome = makeHome();
      const existingPath = configPath(existingHome, "codex");
      mkdirSync(dirname(existingPath), { recursive: true });
      writeFileSync(existingPath, 'model = "gpt-5.6"\n', { mode: 0o640 });
      connectHosts({
        hosts: ["codex"],
        homeDir: existingHome,
        platform: "linux",
        serverPath: "/pkg/dist/server.js",
        nodePath: "/usr/bin/node",
        env: {},
      });
      expect(statSync(existingPath).mode & 0o777).toBe(0o640);
    },
  );

  it("preserves every valid explicit storage backend independently of the Synalux key", () => {
    for (const storage of ["auto", "local", "synalux", "supabase"]) {
      const homeDir = makeHome();
      connectHosts({
        hosts: ["cursor"],
        homeDir,
        platform: "darwin",
        serverPath: "/pkg/dist/server.js",
        nodePath: "/usr/bin/node",
        env: {
          PRISM_STORAGE: storage,
          PRISM_SYNALUX_API_KEY: "synalux_sk_test",
        },
      });

      expect(readConfig(configPath(homeDir, "cursor")).mcpServers["prism-mcp"].env)
        .toMatchObject({
          PRISM_STORAGE: storage,
          PRISM_SYNALUX_API_KEY: "synalux_sk_test",
        });
    }
  });

  it("rejects an invalid explicit storage backend before writing host config", () => {
    const homeDir = makeHome();
    const path = configPath(homeDir, "cursor");

    expect(() => connectHosts({
      hosts: ["cursor"],
      homeDir,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: { PRISM_STORAGE: "cloud" },
    })).toThrow(/Invalid PRISM_STORAGE "cloud".*auto, local, synalux, supabase/);
    expect(existsSync(path)).toBe(false);
  });

  it("preserves existing Codex TOML byte-for-byte outside Prism's managed block", () => {
    const homeDir = makeHome();
    const path = configPath(homeDir, "codex");
    mkdirSync(dirname(path), { recursive: true });
    const original = [
      "# Keep this comment and formatting exactly",
      'model = "gpt-5.6"',
      "",
      "[projects.\"/work/project\"]",
      'trust_level = "trusted"',
      "",
    ].join("\n");
    writeFileSync(path, original);

    const result = connectHosts({
      hosts: ["codex"],
      homeDir,
      platform: "darwin",
      serverPath: "C:\\Prism \\\"Coder\\\"\\dist\\server.js",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      env: {},
    });

    const updated = readFileSync(path, "utf8");
    expect(result.results[0].status).toBe("registered");
    expect(updated.startsWith(original)).toBe(true);
    expect(updated).toContain("# >>> prism connect managed: prism-mcp");
    expect(updated).toContain("# <<< prism connect managed: prism-mcp");
    expect(readTomlConfig(path).mcp_servers["prism-mcp"]).toMatchObject({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ['C:\\Prism \\"Coder\\"\\dist\\server.js'],
    });
  });

  it("never overwrites custom or legacy Codex registrations", () => {
    const originals = [
      '[mcp_servers.prism-mcp]\ncommand = "custom-prism"\nargs = ["--keep-me"]\n',
      '[mcp_servers."prism-mcp"]\ncommand = "custom-prism"\nargs = ["--keep-me"]\n',
      'mcp_servers = { "prism-mcp" = { command = "custom-prism", args = ["--keep-me"] } }\n',
      '[mcp_servers.prism]\ncommand = "custom-prism"\nargs = ["--keep-me"]\n',
    ];
    for (const original of originals) {
      const homeDir = makeHome();
      const path = configPath(homeDir, "codex");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, original);

      const result = connectHosts({
        hosts: ["codex"],
        homeDir,
        platform: "darwin",
        serverPath: "/pkg/dist/server.js",
        nodePath: "/usr/bin/node",
        env: { PRISM_SYNALUX_API_KEY: "must-not-replace-existing-entry" },
        refresh: true,
      });

      expect(result.results[0].status).toBe("existing");
      expect(readFileSync(path, "utf8")).toBe(original);
    }
  });

  it("refreshes only Prism-managed Codex TOML and preserves unrelated fields", () => {
    const homeDir = makeHome();
    const path = configPath(homeDir, "codex");
    const base = {
      hosts: ["codex"] as ConnectHostName[],
      homeDir,
      platform: "darwin" as const,
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
    };

    connectHosts({ ...base, env: {} });
    const initial = readFileSync(path, "utf8").replace(
      'PRISM_STORAGE = "auto"',
      'PRISM_STORAGE = "auto"\nKEEP_ME = "yes"',
    );
    writeFileSync(path, `model = "gpt-5.6"\n\n${initial}`);

    const beforePreview = readFileSync(path, "utf8");
    const preview = connectHosts({
      ...base,
      dryRun: true,
      refresh: true,
      env: { PRISM_SYNALUX_API_KEY: "synalux_sk_now_valid" },
    });
    expect(preview.results[0].status).toBe("would-refresh");
    expect(readFileSync(path, "utf8")).toBe(beforePreview);

    const paid = connectHosts({
      ...base,
      refresh: true,
      env: { PRISM_SYNALUX_API_KEY: "synalux_sk_now_valid" },
    });
    expect(paid.results[0].status).toBe("refreshed");
    expect(readTomlConfig(path).mcp_servers["prism-mcp"].env).toMatchObject({
      KEEP_ME: "yes",
      PRISM_SYNALUX_API_KEY: "synalux_sk_now_valid",
    });
    expect(readFileSync(path, "utf8").startsWith('model = "gpt-5.6"\n\n')).toBe(true);

    const free = connectHosts({ ...base, refresh: true, env: {} });
    expect(free.results[0].status).toBe("refreshed");
    expect(readTomlConfig(path).mcp_servers["prism-mcp"].env)
      .not.toHaveProperty("PRISM_SYNALUX_API_KEY");
    expect(readTomlConfig(path).mcp_servers["prism-mcp"].env.KEEP_ME).toBe("yes");
  });

  it("uses CODEX_HOME in production resolution while an injected home stays isolated", () => {
    const root = makeHome();
    const codexHome = join(root, "custom-codex-home");
    mkdirSync(codexHome, { recursive: true });
    const production = connectHosts({
      hosts: ["codex"],
      platform: "linux",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: { CODEX_HOME: codexHome },
    });
    expect(production.results[0].path).toBe(join(codexHome, "config.toml"));

    const isolatedHome = makeHome();
    const isolated = connectHosts({
      hosts: ["codex"],
      homeDir: isolatedHome,
      platform: "linux",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: { CODEX_HOME: join(root, "must-not-be-used") },
    });
    expect(isolated.results[0].path).toBe(join(isolatedHome, ".codex", "config.toml"));
  });

  it("fails loudly instead of creating a misspelled CODEX_HOME", () => {
    const root = makeHome();
    const missingCodexHome = join(root, "does-not-exist");
    const result = connectHosts({
      hosts: ["codex"],
      platform: "linux",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: { CODEX_HOME: missingCodexHome },
    });

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toMatch(/CODEX_HOME must be an existing directory/);
    expect(existsSync(missingCodexHome)).toBe(false);
  });

  it("fails safely on invalid or ambiguously marked Codex TOML", () => {
    for (const original of [
      "[mcp_servers.prism-mcp\ncommand = 'broken'\n",
      "# >>> prism connect managed: prism-mcp\nmodel = 'gpt-5.6'\n",
    ]) {
      const homeDir = makeHome();
      const path = configPath(homeDir, "codex");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, original);

      const result = connectHosts({
        hosts: ["codex"],
        homeDir,
        platform: "darwin",
        serverPath: "/pkg/dist/server.js",
        nodePath: "/usr/bin/node",
        env: {},
      });

      expect(result.results[0].status).toBe("error");
      expect(readFileSync(path, "utf8")).toBe(original);
    }
  });

  it("fails clearly when an inline mcp_servers table cannot be extended safely", () => {
    const homeDir = makeHome();
    const path = configPath(homeDir, "codex");
    mkdirSync(dirname(path), { recursive: true });
    const original = 'mcp_servers = { other = { command = "other-server" } }\n';
    writeFileSync(path, original);

    const result = connectHosts({
      hosts: ["codex"],
      homeDir,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: {},
    });

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toMatch(/without rewriting existing TOML/);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("preserves a symlinked Codex config and aborts a concurrent target edit", () => {
    const homeDir = makeHome();
    const path = configPath(homeDir, "codex");
    const target = join(homeDir, "dotfiles", "codex-config.toml");
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'model = "gpt-5.6"\n', { mode: 0o640 });
    symlinkSync(target, path);

    const registered = connectHosts({
      hosts: ["codex"],
      homeDir,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: {},
    });
    expect(registered.results[0].status).toBe("registered");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(target).mode & 0o777).toBe(0o640);
    }

    const before = readFileSync(target, "utf8");
    const competing = `${before}\n# changed by Codex\n`;
    const raced = connectHosts({
      hosts: ["codex"],
      homeDir,
      platform: "darwin",
      serverPath: "/new/pkg/dist/server.js",
      nodePath: "/new/node",
      env: {},
      refresh: true,
      beforeCommit: (writePath) => writeFileSync(writePath, competing),
    });
    expect(raced.results[0].status).toBe("error");
    expect(readFileSync(target, "utf8")).toBe(competing);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it("copies the Synalux key independently of storage and supports registration without it", () => {
    const keyedHome = makeHome();
    const noKeyHome = makeHome();

    connectHosts({
      hosts: ["cursor"],
      homeDir: keyedHome,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: {
        PRISM_SYNALUX_API_KEY: "synalux_sk_test",
        PRISM_SYNALUX_BASE_URL: "https://staging.synalux.ai",
      },
    });
    connectHosts({
      hosts: ["cursor"],
      homeDir: noKeyHome,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: {},
    });

    expect(readConfig(configPath(keyedHome, "cursor")).mcpServers["prism-mcp"].env).toMatchObject({
      PRISM_SYNALUX_API_KEY: "synalux_sk_test",
      PRISM_SYNALUX_BASE_URL: "https://staging.synalux.ai",
    });
    expect(readConfig(configPath(noKeyHome, "cursor")).mcpServers["prism-mcp"].env)
      .not.toHaveProperty("PRISM_SYNALUX_API_KEY");
  });

  it("refreshes only a Prism-managed entry when a valid key becomes available later", () => {
    const homeDir = makeHome();
    const base = {
      hosts: ["cursor"] as ConnectHostName[],
      homeDir,
      platform: "darwin" as const,
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
    };

    connectHosts({ ...base, env: {} });
    const refreshed = connectHosts({
      ...base,
      refresh: true,
      env: { PRISM_SYNALUX_API_KEY: "synalux_sk_now_valid" },
    });

    expect(refreshed.results[0].status).toBe("refreshed");
    expect(readConfig(configPath(homeDir, "cursor")).mcpServers["prism-mcp"].env)
      .toHaveProperty("PRISM_SYNALUX_API_KEY", "synalux_sk_now_valid");
  });

  it("removes a stale Synalux key when a managed entry refreshes without subscription credentials", () => {
    const homeDir = makeHome();
    const base = {
      hosts: ["cursor"] as ConnectHostName[],
      homeDir,
      platform: "darwin" as const,
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
    };

    connectHosts({ ...base, env: { PRISM_SYNALUX_API_KEY: "synalux_sk_revoked" } });
    const refreshed = connectHosts({ ...base, refresh: true, env: {} });

    expect(refreshed.results[0].status).toBe("refreshed");
    expect(readConfig(configPath(homeDir, "cursor")).mcpServers["prism-mcp"].env)
      .not.toHaveProperty("PRISM_SYNALUX_API_KEY");
  });

  it("is idempotent and never overwrites an existing prism-mcp registration", () => {
    const homeDir = makeHome();
    const path = configPath(homeDir, "cursor");
    mkdirSync(dirname(path), { recursive: true });
    const original = `${JSON.stringify({
      theme: "dark",
      mcpServers: {
        "prism-mcp": { command: "custom-prism", args: ["--keep-me"] },
        other: { command: "other" },
      },
    }, null, 4)}\n`;
    writeFileSync(path, original);

    const result = connectHosts({
      hosts: ["cursor"],
      homeDir,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: { PRISM_SYNALUX_API_KEY: "must-not-replace-existing-entry" },
      refresh: true,
    });

    expect(result.results[0].status).toBe("existing");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("preserves a symlinked dotfile config and updates its managed target", () => {
    const homeDir = makeHome();
    const path = configPath(homeDir, "cursor");
    const target = join(homeDir, "dotfiles", "cursor-mcp.json");
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '{"theme":"dark"}\n');
    symlinkSync(target, path);

    const result = connectHosts({
      hosts: ["cursor"],
      homeDir,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: {},
    });

    expect(result.results[0].status).toBe("registered");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readConfig(target).mcpServers).toHaveProperty("prism-mcp");
  });

  it("aborts instead of erasing a host update that lands during registration", () => {
    const homeDir = makeHome();
    const path = configPath(homeDir, "cursor");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"theme":"before"}\n');
    const newer = '{"theme":"written-by-running-host"}\n';

    const result = connectHosts({
      hosts: ["cursor"],
      homeDir,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: {},
      beforeCommit: (writePath) => writeFileSync(writePath, newer),
    });

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toMatch(/changed while Prism was preparing/);
    expect(readFileSync(path, "utf8")).toBe(newer);
  });

  it("recognizes the README's legacy prism name and does not create a duplicate", () => {
    const homeDir = makeHome();
    const path = configPath(homeDir, "gemini");
    mkdirSync(dirname(path), { recursive: true });
    const original = `${JSON.stringify({
      mcpServers: { prism: { command: "npx", args: ["-y", "prism-mcp-server"] } },
    }, null, 2)}\n`;
    writeFileSync(path, original);

    const result = connectHosts({
      hosts: ["gemini"],
      homeDir,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: {},
    });

    expect(result.results[0].status).toBe("existing");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("makes dry-run a true preview with no directory or file writes", () => {
    const homeDir = makeHome();

    const result = connectHosts({
      all: true,
      dryRun: true,
      homeDir,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: {},
    });

    expect(result.results.every((item) => item.status === "would-register")).toBe(true);
    expect(existsSync(join(homeDir, ".cursor"))).toBe(false);
    expect(existsSync(join(homeDir, ".gemini"))).toBe(false);
    expect(existsSync(join(homeDir, ".codex"))).toBe(false);
    expect(existsSync(join(homeDir, ".claude.json"))).toBe(false);
    expect(existsSync(join(homeDir, "Library"))).toBe(false);
  });

  it("auto-detects hosts without creating configuration for absent hosts", () => {
    const homeDir = makeHome();
    mkdirSync(join(homeDir, ".cursor"), { recursive: true });
    mkdirSync(join(homeDir, ".gemini"), { recursive: true });
    mkdirSync(join(homeDir, ".codex"), { recursive: true });

    const result = connectHosts({
      homeDir,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: {},
      pathEnv: "",
    });

    expect(result.results.map((item) => item.host)).toEqual(["cursor", "gemini", "codex"]);
    expect(existsSync(configPath(homeDir, "cursor"))).toBe(true);
    expect(existsSync(configPath(homeDir, "gemini"))).toBe(true);
    expect(existsSync(configPath(homeDir, "codex"))).toBe(true);
    expect(existsSync(configPath(homeDir, "claude-code"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "detects an executable Codex CLI on a POSIX PATH but ignores a non-executable lookalike",
    () => {
      const homeDir = makeHome();
      const binDir = join(homeDir, "bin");
      const executable = join(binDir, "codex");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(executable, "#!/bin/sh\n", { mode: 0o644 });

      const base = {
        homeDir,
        platform: "linux" as const,
        serverPath: "/pkg/dist/server.js",
        nodePath: "/usr/bin/node",
        env: {},
        pathEnv: binDir,
      };
      expect(connectHosts(base).results).toEqual([]);

      chmodSync(executable, 0o755);
      expect(connectHosts(base).results.map((item) => item.host)).toEqual(["codex"]);
    },
  );

  it("detects Windows Codex command shims on PATH without POSIX executable bits", () => {
    for (const extension of [".exe", ".cmd", ".bat"]) {
      const homeDir = makeHome();
      const binDir = join(homeDir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, `codex${extension}`), "");

      const result = connectHosts({
        homeDir,
        platform: "win32",
        serverPath: "C:\\Prism\\dist\\server.js",
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        env: {},
        pathEnv: binDir,
      });

      expect(result.results.map((item) => item.host)).toEqual(["codex"]);
    }

    const unsupportedHome = makeHome();
    const unsupportedBin = join(unsupportedHome, "bin");
    mkdirSync(unsupportedBin, { recursive: true });
    writeFileSync(join(unsupportedBin, "codex.ps1"), "");
    expect(connectHosts({
      homeDir: unsupportedHome,
      platform: "win32",
      serverPath: "C:\\Prism\\dist\\server.js",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      env: {},
      pathEnv: unsupportedBin,
    }).results).toEqual([]);
  });

  it("detects fresh macOS GUI installs before their config directories exist", () => {
    const homeDir = makeHome();
    mkdirSync(join(homeDir, "Applications", "Claude.app"), { recursive: true });
    mkdirSync(join(homeDir, "Applications", "Cursor.app"), { recursive: true });
    mkdirSync(join(homeDir, "Applications", "ChatGPT.app"), { recursive: true });

    const result = connectHosts({
      homeDir,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: {},
      pathEnv: "",
    });

    expect(result.results.map((item) => item.host)).toEqual(["claude-desktop", "cursor", "codex"]);
  });

  it("detects fresh Codex and ChatGPT installs at their Windows application paths", () => {
    for (const relativePath of [
      ["Programs", "OpenAI", "Codex", "bin", "codex.exe"],
      ["Microsoft", "WindowsApps", "ChatGPT.exe"],
    ]) {
      const homeDir = makeHome();
      const localAppData = join(homeDir, "LocalAppData");
      const applicationPath = join(localAppData, ...relativePath);
      mkdirSync(dirname(applicationPath), { recursive: true });
      writeFileSync(applicationPath, "");

      const result = connectHosts({
        homeDir,
        platform: "win32",
        serverPath: "C:\\Prism\\dist\\server.js",
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        env: { LOCALAPPDATA: localAppData },
        pathEnv: "",
      });

      expect(result.results.map((item) => item.host)).toEqual(["codex"]);
    }
  });

  it("uses APPDATA for Claude Desktop on Windows", () => {
    const homeDir = makeHome();
    const appData = join(homeDir, "Roaming");

    const result = connectHosts({
      hosts: ["claude-desktop"],
      homeDir,
      platform: "win32",
      serverPath: "C:\\Prism\\dist\\server.js",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      env: { APPDATA: appData },
    });

    const expected = join(appData, "Claude", "claude_desktop_config.json");
    expect(result.results[0]).toMatchObject({ status: "registered", path: expected });
    expect(existsSync(expected)).toBe(true);
  });

  it("uses XDG_CONFIG_HOME for Claude Desktop on Linux", () => {
    const homeDir = makeHome();
    const configHome = join(homeDir, "xdg-config");
    const result = connectHosts({
      hosts: ["claude-desktop"],
      homeDir,
      platform: "linux",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: { XDG_CONFIG_HOME: configHome },
    });

    const expected = join(configHome, "Claude", "claude_desktop_config.json");
    expect(result.results[0]).toMatchObject({ status: "registered", path: expected });
    expect(existsSync(expected)).toBe(true);
  });

  it("fails safely on invalid JSON instead of replacing a user's config", () => {
    const homeDir = makeHome();
    const path = configPath(homeDir, "cursor");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ this is not valid JSON\n");

    const result = connectHosts({
      hosts: ["cursor"],
      homeDir,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: {},
    });

    expect(result.results[0].status).toBe("error");
    expect(readFileSync(path, "utf8")).toBe("{ this is not valid JSON\n");
  });

  it("normalizes documented host aliases and rejects unknown hosts", () => {
    expect(normalizeHostName("claude-code")).toBe("claude-code");
    expect(normalizeHostName("desktop")).toBe("claude-desktop");
    expect(normalizeHostName("gemini-cli")).toBe("gemini");
    expect(normalizeHostName("CODEX-CLI")).toBe("codex");
    expect(() => normalizeHostName("windsurf")).toThrow(/Unsupported host/);
    expect(() => connectHosts({
      all: true,
      hosts: ["cursor"],
      homeDir: makeHome(),
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: {},
    })).toThrow(/either --all or --host/);
  });

  it("resolves the packaged server from package.json main", () => {
    const packageRoot = makeHome();
    const distDir = join(packageRoot, "dist");
    const serverPath = join(distDir, "server.js");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ main: "dist/server.js" }));
    writeFileSync(serverPath, "// test server\n");

    const moduleUrl = pathToFileURL(join(distDir, "connect.js")).href;
    expect(resolveInstalledServerPath(moduleUrl)).toBe(realpathSync(serverPath));
  });

  it("exposes Codex through the built CLI with fail-loud exit codes", () => {
    const codexHome = join(makeHome(), "codex-home");
    mkdirSync(codexHome, { recursive: true });
    const cliPath = resolve("dist/cli.js");
    const env = {
      ...process.env,
      CODEX_HOME: codexHome,
      PRISM_CONFIG_PATH: join(codexHome, "prism-config.db"),
      PRISM_SKILL_SYNC_DISABLED: "true",
      PRISM_SYNALUX_API_KEY: "",
    };

    const connected = spawnSync(process.execPath, [cliPath, "connect", "--host", "codex"], {
      encoding: "utf8",
      env,
    });
    expect(connected.status, connected.stderr).toBe(0);
    expect(connected.stdout).toContain("Codex: registered");
    expect(readTomlConfig(join(codexHome, "config.toml")).mcp_servers)
      .toHaveProperty("prism-mcp");

    const conflicting = spawnSync(
      process.execPath,
      [cliPath, "connect", "--all", "--host", "codex"],
      { encoding: "utf8", env },
    );
    expect(conflicting.status).toBe(1);
    expect(conflicting.stderr).toMatch(/either --all or --host/);

    const beforeInvalidStorage = readFileSync(join(codexHome, "config.toml"), "utf8");
    const invalidStorage = spawnSync(
      process.execPath,
      [cliPath, "connect", "--host", "codex", "--refresh"],
      {
        encoding: "utf8",
        env: { ...env, PRISM_STORAGE: "cloud" },
      },
    );
    expect(invalidStorage.status).toBe(1);
    expect(invalidStorage.stderr).toMatch(/Invalid PRISM_STORAGE "cloud"/);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(beforeInvalidStorage);

    const invalid = "[mcp_servers.prism-mcp\n";
    writeFileSync(join(codexHome, "config.toml"), invalid);
    const failed = spawnSync(process.execPath, [cliPath, "connect", "--host", "codex"], {
      encoding: "utf8",
      env,
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("could not parse config");
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(invalid);
  }, 30_000); // Four process startups can exceed the 10s default on Windows CI.

  it("exits nonzero after registration when the install-time skill snapshot is unavailable", () => {
    const homeDir = makeHome();
    const codexHome = join(homeDir, "codex-home");
    mkdirSync(codexHome, { recursive: true });

    const failed = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "connect", "--host", "codex"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: homeDir,
          CODEX_HOME: codexHome,
          PRISM_CONFIG_PATH: join(homeDir, "prism-config.db"),
          PRISM_SKILL_SYNC_DISABLED: "false",
          PRISM_SYNALUX_BASE_URL: "http://127.0.0.1:1",
          PRISM_SYNALUX_API_KEY: "",
        },
      },
    );

    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/Synalux skill synchronization failed/);
    expect(readTomlConfig(join(codexHome, "config.toml")).mcp_servers)
      .toHaveProperty("prism-mcp");
  });

  it("keeps legacy Claude hooks when the install-time skill snapshot fails", () => {
    const homeDir = makeHome();
    const settingsPath = join(homeDir, ".claude", "settings.json");
    const instructionPath = join(homeDir, "CLAUDE.md");
    const command = `${join(homeDir, "prism", "scripts", "sync-skills.sh")} > /dev/null 2>&1`;
    const original = `${JSON.stringify({
      hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command }] }] },
    }, null, 2)}\n`;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, original);
    const originalInstructions = legacyClaudeInstructions();
    writeFileSync(instructionPath, originalInstructions);

    const failed = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "connect", "--host", "claude-code"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
          PRISM_CONFIG_PATH: join(homeDir, "prism-config.db"),
          PRISM_SKILL_SYNC_DISABLED: "false",
          PRISM_SYNALUX_BASE_URL: "http://127.0.0.1:1",
          PRISM_SYNALUX_API_KEY: "",
        },
      },
    );

    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/Synalux skill synchronization failed/);
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
    expect(readFileSync(instructionPath, "utf8")).toBe(originalInstructions);
  });

  it("materializes entitled native skills before prism connect exits", async () => {
    const homeDir = makeHome();
    const codexHome = join(homeDir, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    const manifest = freeManifest();
    const server = createServer((request, response) => {
      if (request.url !== "/api/v1/prism/skill-manifest") {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(manifest));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const result = await runBuiltCli(["connect", "--host", "codex"], {
        ...process.env,
        HOME: homeDir,
        CODEX_HOME: codexHome,
        PRISM_CONFIG_PATH: join(homeDir, "prism-config.db"),
        PRISM_SKILL_SYNC_DISABLED: "false",
        PRISM_SYNALUX_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        PRISM_SYNALUX_API_KEY: "",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Synalux skills: free tier");
      expect(readFileSync(join(
        homeDir, ".agents", "skills", "aba-precision-protocol", "SKILL.md",
      ), "utf8")).toContain("name: aba-precision-protocol");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("delivers native skills and migrates only legacy Claude hooks after a successful snapshot", async () => {
    const homeDir = makeHome();
    const codexHome = join(homeDir, ".codex");
    const appData = join(homeDir, "appdata");
    const xdgConfigHome = join(homeDir, "xdg-config");
    mkdirSync(codexHome, { recursive: true });

    const claudeSettings = join(homeDir, ".claude", "settings.json");
    const claudeInstructions = join(homeDir, "CLAUDE.md");
    const cursorHooks = join(homeDir, ".cursor", "hooks.json");
    const geminiSettings = join(homeDir, ".gemini", "settings.json");
    const legacySyncHook = `${join(homeDir, "prism", "scripts", "sync-skills.sh")} > /dev/null 2>&1`;
    const claudeConfig = {
      hooks: {
        SessionStart: ["user-owned-claude-hook"],
        SessionEnd: [{ matcher: "*", hooks: [{ type: "command", command: legacySyncHook, timeout: 10 }] }],
      },
    };
    const cursorHookSentinel = '{\n  "version": 1, "hooks": { "sessionStart": ["user-owned-cursor-hook"] }\n}\n';
    const geminiConfig = {
      theme: "user-theme",
      hooks: { SessionStart: [{ command: "user-owned-gemini-hook" }] },
    };
    mkdirSync(dirname(claudeSettings), { recursive: true });
    mkdirSync(dirname(cursorHooks), { recursive: true });
    mkdirSync(dirname(geminiSettings), { recursive: true });
    writeFileSync(claudeSettings, `${JSON.stringify(claudeConfig, null, 2)}\n`);
    writeFileSync(claudeInstructions, legacyClaudeInstructions("PRESERVE THIS CLAUDE RULE\n"));
    writeFileSync(cursorHooks, cursorHookSentinel);
    writeFileSync(geminiSettings, `${JSON.stringify(geminiConfig, null, 2)}\n`);
    const geminiHooksBefore = JSON.stringify(geminiConfig.hooks);

    const manifest = freeManifest();
    const server = createServer((request, response) => {
      if (request.url !== "/api/v1/prism/skill-manifest") {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(manifest));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const result = await runBuiltCli(["connect", "--all"], {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        APPDATA: appData,
        XDG_CONFIG_HOME: xdgConfigHome,
        CODEX_HOME: codexHome,
        PRISM_CONFIG_PATH: join(homeDir, "prism-config.db"),
        PRISM_SKILL_SYNC_DISABLED: "false",
        PRISM_SYNALUX_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        PRISM_SYNALUX_API_KEY: "",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Claude Code: registered");
      expect(result.stdout).toContain("Claude Desktop: registered");
      expect(result.stdout).toContain("Cursor: registered");
      expect(result.stdout).toContain("Gemini CLI: registered");
      expect(result.stdout).toContain("Codex: registered");
      expect(result.stdout).toContain("removed 1 legacy Prism hook action");
      expect(result.stdout).toContain("removed 2 legacy Prism startup section");
      expect(result.stdout).toContain("installed hook-free native startup instructions");

      // Codex, Gemini CLI, and Cursor share the Agent Skills standard root.
      expect(readFileSync(join(
        homeDir, ".agents", "skills", "aba-precision-protocol", "SKILL.md",
      ), "utf8")).toContain("name: aba-precision-protocol");
      // Claude Code has a separate native discovery root and gets a fully
      // Prism-managed copy. Claude Desktop has no local filesystem target.
      expect(readFileSync(join(
        homeDir, ".claude", "skills", "aba-precision-protocol", "SKILL.md",
      ), "utf8")).toContain("name: aba-precision-protocol");
      const claudeDesktopSkillsDir = process.platform === "darwin"
        ? join(homeDir, "Library", "Application Support", "Claude", "skills")
        : process.platform === "win32"
          ? join(appData, "Claude", "skills")
          : join(xdgConfigHome, "Claude", "skills");
      expect(existsSync(claudeDesktopSkillsDir)).toBe(false);

      expect(readConfig(claudeSettings).hooks).toEqual({ SessionStart: ["user-owned-claude-hook"] });
      expect(readFileSync(claudeInstructions, "utf8")).toContain("PRESERVE THIS CLAUDE RULE");
      expect(readFileSync(claudeInstructions, "utf8")).not.toContain('session_load_context(project="prism-mcp")');
      expect(readFileSync(claudeInstructions, "utf8")).toContain("prism connect managed: native startup");
      expect(readFileSync(claudeInstructions, "utf8")).toContain("mcp__prism-mcp__session_bootstrap");
      expect(readFileSync(cursorHooks, "utf8")).toBe(cursorHookSentinel);
      expect(JSON.stringify(readConfig(geminiSettings).hooks)).toBe(geminiHooksBefore);
      expect(JSON.stringify(readConfig(join(homeDir, ".claude.json")))).not.toMatch(/SessionStart|hooks/i);
      expect(JSON.stringify(readConfig(join(homeDir, ".cursor", "mcp.json")))).not.toMatch(/SessionStart|hooks/i);
      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).not.toMatch(/SessionStart|hooks/i);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("keeps legacy Claude hooks when native skill synchronization is disabled", async () => {
    const homeDir = makeHome();
    const settingsPath = join(homeDir, ".claude", "settings.json");
    const instructionPath = join(homeDir, "CLAUDE.md");
    const command = `${join(homeDir, "prism", "scripts", "sync-skills.sh")} > /dev/null 2>&1`;
    const original = `${JSON.stringify({
      hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command }] }] },
    }, null, 2)}\n`;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, original);
    const originalInstructions = legacyClaudeInstructions();
    writeFileSync(instructionPath, originalInstructions);

    const result = await runBuiltCli(["connect", "--host", "claude-code"], {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      PRISM_CONFIG_PATH: join(homeDir, "prism-config.db"),
      PRISM_SKILL_SYNC_DISABLED: "true",
      PRISM_SYNALUX_API_KEY: "",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
    expect(readFileSync(instructionPath, "utf8")).toBe(originalInstructions);
    expect(result.stdout).not.toContain("legacy Prism hook");
  });
});
