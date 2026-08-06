import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexPluginProvidesPrismMcp } from "../src/connect.js";

/**
 * Installing the Codex plugin and running `prism connect` both register a
 * server under the key `prism-mcp`. Doing both configured the same server
 * twice: every Prism tool appeared in duplicate and load order decided which
 * won. It was previously only documented, which put the burden on the user.
 */
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function codexHome(): string {
  const d = mkdtempSync(join(tmpdir(), "codex-collision-"));
  dirs.push(d);
  return d;
}

function installPlugin(home: string, marketplace: string, plugin: string, version: string, mcp: unknown) {
  const dir = join(home, "plugins", "cache", marketplace, plugin, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcp));
}

describe("detecting a Codex plugin that already provides prism-mcp", () => {
  it("finds a plugin whose .mcp.json declares prism-mcp", () => {
    const home = codexHome();
    installPlugin(home, "prism", "synalux-prism", "20.7.1", {
      mcpServers: { "prism-mcp": { command: "npx", args: ["-y", "prism-mcp-server"] } },
    });
    expect(codexPluginProvidesPrismMcp(home)).toBe("synalux-prism@prism");
  });

  it("matches on the manifest, not the plugin name — so a rename still works", () => {
    const home = codexHome();
    installPlugin(home, "acme", "totally-different-name", "1.0.0", {
      mcpServers: { "prism-mcp": { command: "npx" } },
    });
    expect(codexPluginProvidesPrismMcp(home)).toBe("totally-different-name@acme");
  });

  it("does NOT false-positive on unrelated plugins", () => {
    const home = codexHome();
    installPlugin(home, "openai", "documents", "1.0.0", {
      mcpServers: { "documents": { command: "node" } },
    });
    expect(codexPluginProvidesPrismMcp(home)).toBeNull();
  });

  it("returns null when nothing is installed or the manifest is unreadable", () => {
    expect(codexPluginProvidesPrismMcp(codexHome())).toBeNull();
    const home = codexHome();
    const dir = join(home, "plugins", "cache", "m", "p", "1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".mcp.json"), "{ not json");
    expect(codexPluginProvidesPrismMcp(home)).toBeNull();
  });
});
