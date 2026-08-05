/**
 * MCP Registry manifest drift guard — node:test
 * =============================================
 * server.json is the storefront the MCP Registry serves, and it is the default
 * place Claude Code and Codex users look for servers. On 2026-08-05 the live
 * registry listing was 1.5.0, server.json said 2.3.4, and npm latest was
 * 20.6.0 — nothing tied the files together, so the public listing drifted ~19
 * majors behind the shipping build while every publish succeeded.
 *
 * Run: node --test scripts/__tests__/publish-manifest.test.mjs
 * (from ~/prism)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { serverManifestVersionMismatches } from "../check-publish-clean.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (name) => JSON.parse(readFileSync(join(REPO_ROOT, name), "utf8"));

describe("serverManifestVersionMismatches", () => {
  it("reports the top-level version when it trails package.json", () => {
    const problems = serverManifestVersionMismatches(
      { name: "prism-mcp-server", version: "20.6.0" },
      { version: "2.3.4", packages: [] },
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /server\.json version is 2\.3\.4, expected 20\.6\.0/);
  });

  it("reports a stale package entry even when the top-level version is current", () => {
    const problems = serverManifestVersionMismatches(
      { name: "prism-mcp-server", version: "20.6.0" },
      {
        version: "20.6.0",
        packages: [{ identifier: "prism-mcp-server", version: "2.3.4" }],
      },
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /packages\[0\]\.version is 2\.3\.4, expected 20\.6\.0/);
  });

  it("ignores package entries that are not this server's npm package", () => {
    const problems = serverManifestVersionMismatches(
      { name: "prism-mcp-server", version: "20.6.0" },
      {
        version: "20.6.0",
        packages: [{ identifier: "some-other-package", version: "0.0.1" }],
      },
    );
    assert.deepEqual(problems, []);
  });

  it("passes when every version agrees", () => {
    const problems = serverManifestVersionMismatches(
      { name: "prism-mcp-server", version: "20.6.0" },
      {
        version: "20.6.0",
        packages: [{ identifier: "prism-mcp-server", version: "20.6.0" }],
      },
    );
    assert.deepEqual(problems, []);
  });
});

describe("the committed server.json", () => {
  it("advertises the version this repo actually publishes", () => {
    assert.deepEqual(
      serverManifestVersionMismatches(readJson("package.json"), readJson("server.json")),
      [],
    );
  });

  it("points at the repository that actually hosts this server", () => {
    const { repository } = readJson("server.json");
    // The registry validates namespace ownership against this URL; the old
    // value (dcostenco/prism-mcp) is now only a GitHub rename redirect.
    assert.equal(repository.url, "https://github.com/dcostenco/prism-coder");
    assert.equal(repository.source, "github");
  });
});
