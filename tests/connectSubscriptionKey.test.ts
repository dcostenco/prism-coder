/**
 * Regression: `prism connect` must not drop a paid subscription on
 * re-registration.
 *
 * connect writes each host's MCP env block from the environment it can see. On
 * a machine that logged in through Prism's settings store, the subscription key
 * was never in that environment, so connect wrote a base URL and no key. The
 * server then started with no key, portal search availability froze false at
 * module load, and every search failed asking for a Brave key the subscriber
 * in the server's own environment, which a host launched from the graphical
 * shell does not carry. Entitlements still reported the paid plan, because they
 * resolve the key later from the settings store — which is what made the
 * failure look like the portal refusing a paying customer.
 *
 * The repair is composition: hydrate the environment from the settings store,
 * then register. This exercises that chain against a real temporary home.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectHosts } from "../src/connect.js";
import { hydrateSynaluxCredentials } from "../src/utils/synaluxSearch.js";

const ENV_KEYS = ["PRISM_SYNALUX_BASE_URL", "SYNALUX_BASE_URL", "PRISM_SYNALUX_API_KEY"] as const;

let home: string;
let savedEnv: Record<string, string | undefined> = {};

/** A settings store holding what a previous login saved. */
function storeHolding(values: Record<string, string>) {
  return async (key: string, fallback = "") => values[key] ?? fallback;
}

function readHostEnvBlock(): Record<string, string> {
  const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  const entry = config.mcpServers["prism-mcp"] ?? config.mcpServers["prism"];
  return entry.env as Record<string, string>;
}

function register(env: NodeJS.ProcessEnv) {
  return connectHosts({
    hosts: ["claude-code"],
    homeDir: home,
    platform: "darwin",
    env,
    serverPath: join(home, "server.js"),
    nodePath: "/usr/bin/node",
    packageVersion: "0.0.0-test",
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "prism-connect-key-"));
  // An existing Claude Code config, so connect registers rather than skipping.
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }), "utf8");
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("prism connect carries the subscription into the host config", () => {
  it("writes no key when the machine genuinely has no subscription", () => {
    // The honest unauthenticated case must stay unauthenticated.
    const summary = register({ ...process.env });

    expect(summary.usedApiKey).toBe(false);
    expect(readHostEnvBlock().PRISM_SYNALUX_API_KEY).toBeUndefined();
    // The base URL is still written, which is exactly how the broken host looked.
    expect(readHostEnvBlock().PRISM_SYNALUX_BASE_URL).toBeTruthy();
  });

  it("reproduces the defect: a key only in the settings store never reaches the host", () => {
    // What connect did before the repair — register straight from an
    // environment that the settings store had never been merged into.
    const summary = register({ ...process.env });

    expect(summary.usedApiKey).toBe(false);
    expect(readHostEnvBlock().PRISM_SYNALUX_API_KEY).toBeUndefined();
  });

  it("writes the key when hydration precedes registration", async () => {
    await hydrateSynaluxCredentials(storeHolding({
      PRISM_SYNALUX_API_KEY: "test_subscription_from_settings",
      PRISM_SYNALUX_BASE_URL: "https://enterprise.portal.example",
    }));

    const summary = register({ ...process.env });

    expect(summary.usedApiKey).toBe(true);
    const block = readHostEnvBlock();
    expect(block.PRISM_SYNALUX_API_KEY).toBe("test_subscription_from_settings");
    expect(block.PRISM_SYNALUX_BASE_URL).toBe("https://enterprise.portal.example");
  });

  it("prefers the environment's own key over the stored one", async () => {
    process.env.PRISM_SYNALUX_API_KEY = "test_subscription_from_env";
    await hydrateSynaluxCredentials(storeHolding({
      PRISM_SYNALUX_API_KEY: "test_subscription_from_settings",
    }));

    register({ ...process.env });

    expect(readHostEnvBlock().PRISM_SYNALUX_API_KEY).toBe("test_subscription_from_env");
  });

  it("keeps the key across a re-registration, which is when it used to vanish", async () => {
    await hydrateSynaluxCredentials(storeHolding({
      PRISM_SYNALUX_API_KEY: "test_subscription_from_settings",
    }));
    register({ ...process.env });
    expect(readHostEnvBlock().PRISM_SYNALUX_API_KEY).toBe("test_subscription_from_settings");

    // Second run of `prism connect`, e.g. after an update.
    register({ ...process.env });
    expect(readHostEnvBlock().PRISM_SYNALUX_API_KEY).toBe("test_subscription_from_settings");
  });

  it("never writes an unexpanded template as a subscription key", async () => {
    await hydrateSynaluxCredentials(storeHolding({
      PRISM_SYNALUX_API_KEY: "${PRISM_SYNALUX_API_KEY}",
    }));

    const summary = register({ ...process.env });

    expect(summary.usedApiKey).toBe(false);
    expect(readHostEnvBlock().PRISM_SYNALUX_API_KEY).toBeUndefined();
  });
});
