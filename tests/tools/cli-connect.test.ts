/**
 * prism connect — host registration contract
 *
 * These tests use an isolated home directory because this command edits
 * user-owned MCP configuration. A regression must never overwrite an existing
 * registration or leak a dry run into a real config file.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectHosts,
  normalizeHostName,
  resolveInstalledServerPath,
  type ConnectHostName,
} from "../../src/connect.js";

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
  }
}

function readConfig(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("prism connect", () => {
  it("registers all four supported hosts with the installed server path", () => {
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
  });

  it("copies the Synalux key from the environment but supports local/free mode without it", () => {
    const paidHome = makeHome();
    const freeHome = makeHome();

    connectHosts({
      hosts: ["cursor"],
      homeDir: paidHome,
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
      homeDir: freeHome,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: {},
    });

    expect(readConfig(configPath(paidHome, "cursor")).mcpServers["prism-mcp"].env).toMatchObject({
      PRISM_SYNALUX_API_KEY: "synalux_sk_test",
      PRISM_SYNALUX_BASE_URL: "https://staging.synalux.ai",
    });
    expect(readConfig(configPath(freeHome, "cursor")).mcpServers["prism-mcp"].env)
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

  it("removes a stale Synalux key when a managed entry refreshes into local/free mode", () => {
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
    expect(existsSync(join(homeDir, ".claude.json"))).toBe(false);
    expect(existsSync(join(homeDir, "Library"))).toBe(false);
  });

  it("auto-detects hosts without creating configuration for absent hosts", () => {
    const homeDir = makeHome();
    mkdirSync(join(homeDir, ".cursor"), { recursive: true });
    mkdirSync(join(homeDir, ".gemini"), { recursive: true });

    const result = connectHosts({
      homeDir,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: {},
      pathEnv: "",
    });

    expect(result.results.map((item) => item.host)).toEqual(["cursor", "gemini"]);
    expect(existsSync(configPath(homeDir, "cursor"))).toBe(true);
    expect(existsSync(configPath(homeDir, "gemini"))).toBe(true);
    expect(existsSync(configPath(homeDir, "claude-code"))).toBe(false);
  });

  it("detects fresh macOS GUI installs before their config directories exist", () => {
    const homeDir = makeHome();
    mkdirSync(join(homeDir, "Applications", "Claude.app"), { recursive: true });
    mkdirSync(join(homeDir, "Applications", "Cursor.app"), { recursive: true });

    const result = connectHosts({
      homeDir,
      platform: "darwin",
      serverPath: "/pkg/dist/server.js",
      nodePath: "/usr/bin/node",
      env: {},
      pathEnv: "",
    });

    expect(result.results.map((item) => item.host)).toEqual(["claude-desktop", "cursor"]);
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
});
