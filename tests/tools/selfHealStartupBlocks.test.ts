import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    refreshManagedStartupBlocks,
    configureClaudeNativeStartup,
    configureGeminiNativeStartup,
    configureCodexNativeStartup,
} from "../../src/connect.js";

/**
 * The instruction files are the one delivery channel that does not travel with
 * the package. 20.21.0 proved the cost: the text an older release wrote told
 * hosts to pass `cloud_fallback: false`, which made a paid plan's escalation
 * unreachable, and nothing on an ordinary machine re-runs `prism connect`.
 *
 * The self-heal is deliberately the narrowest useful subset of connect, and
 * these tests pin the narrowness, not just the healing.
 */
describe("self-healing startup blocks", () => {
    let home: string;
    const claudeFile = () => join(home, ".claude", "CLAUDE.md");
    const geminiFile = () => join(home, ".gemini", "GEMINI.md");
    const codexFile = () => join(home, ".codex", "AGENTS.md");
    const stale = (text: string) =>
        text.replace(
            /Leave `cloud_fallback`[\s\S]*?forbid cloud inference fallback\./,
            "`cloud_fallback: false`, and the `project` and `conversation_id` from this session when known.",
        );

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "prism-selfheal-"));
        for (const d of [".claude", ".gemini", ".codex"]) mkdirSync(join(home, d), { recursive: true });
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it("a file with NO ownership marker is left byte-for-byte alone — consent is never inferred from a server start", () => {
        const mine = "# My own notes\n\nNothing of Prism's here.\n";
        writeFileSync(claudeFile(), mine);
        const before = statSync(claudeFile()).mtimeMs;
        const results = refreshManagedStartupBlocks({ homeDir: home, env: {} });
        expect(results.find(r => r.host === "claude-code")?.status).toBe("unmanaged");
        expect(readFileSync(claudeFile(), "utf8")).toBe(mine);
        expect(statSync(claudeFile()).mtimeMs).toBe(before);   // not even rewritten identically
    });

    // The consent gate used to be a substring scan, which a file could pass
    // by MENTIONING the marker. The configurator would then find no exact
    // marker line, take its install branch, and append a block to a file the
    // operator never gave us. Every shape below must be left alone.
    for (const [name, body] of [
        ["the marker quoted in prose", "# Notes\n\nWe use <!-- >>> prism connect managed: native startup --> as our sentinel.\n"],
        ["the marker inside a fenced code block", "# Notes\n\n```md\n<!-- >>> prism connect managed: native startup -->\n```\n"],
        ["the marker indented, so not a standalone line", "# Notes\n\n    <!-- >>> prism connect managed: native startup -->\n"],
        ["only the END marker", "# Notes\n\n<!-- <<< prism connect managed: native startup -->\n"],
        ["the marker with trailing text on the line", "# Notes\n\n<!-- >>> prism connect managed: native startup --> and more\n"],
    ] as Array<[string, string]>) {
        it(`leaves a file alone when it only contains ${name}`, () => {
            writeFileSync(claudeFile(), body);
            const before = readFileSync(claudeFile(), "utf8");
            const results = refreshManagedStartupBlocks({ homeDir: home, env: {} });
            const claude = results.find(r => r.host === "claude-code");
            // Not written is the contract. A lone or unpaired marker line is
            // an ambiguous ownership state: the configurator throws and the
            // refresh reports `failed` with the reason, which is better than
            // silence because the operator's file needs a human. Either way
            // nothing is written.
            expect(claude?.status, `status for: ${name}`).not.toBe("refreshed");
            expect(["unmanaged", "failed"], `status for: ${name}`).toContain(claude?.status);
            expect(readFileSync(claudeFile(), "utf8"), `content for: ${name}`).toBe(before);
        });
    }

    // Claude and Gemini serialize the SAME ownership marker, and a single-file
    // setup symlinks GEMINI.md to CLAUDE.md. Before the real-path de-duplication
    // every start rewrote that one file twice and never converged: two
    // "refreshed" lines on every start, forever, with the loser's flavour
    // winning. Measured 2026-09-16.
    it("two hosts sharing one file are reported, never healed: no content satisfies both", () => {
        writeFileSync(claudeFile(), "# Shared\n");
        configureClaudeNativeStartup(home, false);
        const fresh = readFileSync(claudeFile(), "utf8");
        writeFileSync(claudeFile(), stale(fresh));
        rmSync(geminiFile(), { force: true });
        symlinkSync(claudeFile(), geminiFile());          // one file, two hosts

        const staleBytes = readFileSync(claudeFile(), "utf8");
        const settled = statSync(claudeFile()).mtimeMs;
        for (let start = 0; start < 3; start++) {
            const results = refreshManagedStartupBlocks({ homeDir: home, env: {} });
            for (const host of ["claude-code", "gemini"] as const) {
                const r = results.find(x => x.host === host);
                expect(r?.status, `${host} on start ${start}`).toBe("failed");
                expect(r?.detail).toContain("one file cannot hold both blocks");
            }
            // Never rewritten — not once per host, not once at all.
            expect(results.some(r => r.status === "refreshed"), "a shared file must not be written").toBe(false);
        }
        expect(statSync(claudeFile()).mtimeMs).toBe(settled);
        expect(readFileSync(claudeFile(), "utf8")).toBe(staleBytes);
        expect(fresh).not.toBe(staleBytes);   // it really was stale, and stayed that way on purpose
    });

    it("two hosts hard-linked to one file are reported too — a path comparison would have missed it and broken the link", () => {
        writeFileSync(claudeFile(), "# Shared\n");
        configureClaudeNativeStartup(home, false);
        writeFileSync(claudeFile(), stale(readFileSync(claudeFile(), "utf8")));
        rmSync(geminiFile(), { force: true });
        linkSync(claudeFile(), geminiFile());          // one inode, two paths, no symlink
        const before = readFileSync(claudeFile(), "utf8");
        const results = refreshManagedStartupBlocks({ homeDir: home, env: {} });
        for (const host of ["claude-code", "gemini"] as const) {
            expect(results.find(r => r.host === host)?.status, host).toBe("failed");
        }
        expect(readFileSync(claudeFile(), "utf8")).toBe(before);
    });

    it("PRISM_NO_STARTUP_REFRESH=1 turns it off entirely: nothing is inspected and nothing is written", () => {
        writeFileSync(claudeFile(), "");
        configureClaudeNativeStartup(home, false);
        const older = stale(readFileSync(claudeFile(), "utf8"));
        writeFileSync(claudeFile(), older);
        const settled = statSync(claudeFile()).mtimeMs;
        expect(refreshManagedStartupBlocks({ homeDir: home, env: { PRISM_NO_STARTUP_REFRESH: "1" } })).toEqual([]);
        expect(readFileSync(claudeFile(), "utf8")).toBe(older);
        expect(statSync(claudeFile()).mtimeMs).toBe(settled);
    });

    it("a file with a start marker but no end marker is reported, not written", () => {
        const body = "# Notes\n\n<!-- >>> prism connect managed: native startup -->\nhalf a block\n";
        writeFileSync(claudeFile(), body);
        const claude = refreshManagedStartupBlocks({ homeDir: home, env: {} }).find(r => r.host === "claude-code");
        expect(["unmanaged", "failed"]).toContain(claude?.status);
        expect(readFileSync(claudeFile(), "utf8")).toBe(body);
    });

    it("a file that is simply not Prism's is 'unmanaged', not an error the operator has to read", () => {
        writeFileSync(claudeFile(), "# Notes\n\n<!-- <<< prism connect managed: native startup -->\n");
        const claude = refreshManagedStartupBlocks({ homeDir: home, env: {} }).find(r => r.host === "claude-code");
        expect(claude?.status, "an END marker alone is not an ambiguous Prism block, it is not ours").toBe("unmanaged");
    });

    it("honours CODEX_HOME for the codex instruction file", () => {
        const custom = join(home, "custom-codex");
        mkdirSync(custom, { recursive: true });
        writeFileSync(join(custom, "AGENTS.md"), "");
        configureCodexNativeStartup(home, false, undefined, { CODEX_HOME: custom });
        const fresh = readFileSync(join(custom, "AGENTS.md"), "utf8");
        writeFileSync(join(custom, "AGENTS.md"), stale(fresh));
        const results = refreshManagedStartupBlocks({ homeDir: home, env: { CODEX_HOME: custom } });
        const codex = results.find(r => r.host === "codex");
        expect(codex?.status).toBe("refreshed");
        expect(codex?.path).toBe(join(custom, "AGENTS.md"));
        expect(readFileSync(join(custom, "AGENTS.md"), "utf8")).toBe(fresh);
    });

    it("heals a CRLF file without converting the operator's own line endings", () => {
        writeFileSync(claudeFile(), "# Notes\r\n\r\nKeep me.\r\n");
        configureClaudeNativeStartup(home, false);
        const fresh = readFileSync(claudeFile(), "utf8");
        writeFileSync(claudeFile(), stale(fresh));
        expect(refreshManagedStartupBlocks({ homeDir: home, env: {} }).find(r => r.host === "claude-code")?.status).toBe("refreshed");
        const healed = readFileSync(claudeFile(), "utf8");
        expect(healed).toBe(fresh);
        expect(healed).toContain("# Notes\r\n");
    });

    it("an absent file is never created — the self-heal cannot first-install a block", () => {
        rmSync(join(home, ".claude"), { recursive: true, force: true });
        const results = refreshManagedStartupBlocks({ homeDir: home, env: {} });
        expect(results.find(r => r.host === "claude-code")?.status).toBe("unmanaged");
        expect(() => readFileSync(claudeFile(), "utf8")).toThrow();
    });

    it("a block written by an older release is refreshed, and the operator's own text around it survives", () => {
        writeFileSync(claudeFile(), "# My own notes\n\nKeep me.\n");
        configureClaudeNativeStartup(home, false);
        const fresh = readFileSync(claudeFile(), "utf8");
        const older = stale(fresh);
        expect(older, "fixture did not actually go stale").not.toBe(fresh);
        writeFileSync(claudeFile(), older);

        const results = refreshManagedStartupBlocks({ homeDir: home, env: {} });
        expect(results.find(r => r.host === "claude-code")?.status).toBe("refreshed");
        const healed = readFileSync(claudeFile(), "utf8");
        expect(healed).toBe(fresh);
        expect(healed).toContain("Keep me.");
        expect(healed).not.toContain("`cloud_fallback: false`, and the `project`");
    });

    it("is a no-op on a current block: reports unchanged and never rewrites, however many sessions start", () => {
        writeFileSync(claudeFile(), "");
        configureClaudeNativeStartup(home, false);
        const after = statSync(claudeFile()).mtimeMs;
        for (let session = 0; session < 3; session++) {
            const results = refreshManagedStartupBlocks({ homeDir: home, env: {} });
            expect(results.find(r => r.host === "claude-code")?.status).toBe("unchanged");
        }
        expect(statSync(claudeFile()).mtimeMs, "a current block must not be rewritten on every server start").toBe(after);
    });

    it("heals every managed host independently, and one unmanaged host does not hold back the others", () => {
        writeFileSync(geminiFile(), "");
        configureGeminiNativeStartup(home, false);
        writeFileSync(geminiFile(), stale(readFileSync(geminiFile(), "utf8")));
        writeFileSync(codexFile(), "");
        configureCodexNativeStartup(home, false, undefined, {});
        writeFileSync(codexFile(), stale(readFileSync(codexFile(), "utf8")));
        writeFileSync(claudeFile(), "# not Prism's\n");          // unmanaged

        const byHost = Object.fromEntries(
            refreshManagedStartupBlocks({ homeDir: home, env: {} }).map(r => [r.host, r.status]),
        );
        expect(byHost["gemini"]).toBe("refreshed");
        expect(byHost["codex"]).toBe("refreshed");
        expect(byHost["claude-code"]).toBe("unmanaged");
        expect(readFileSync(claudeFile(), "utf8")).toBe("# not Prism's\n");
    });

    // POSIX only: Windows does not enforce a directory mode this way, so the
    // write succeeds there and the guarantee is not testable, not broken.
    it.skipIf(process.platform === "win32")("an unwritable managed file is reported, never thrown — a self-heal cannot stop a server starting", () => {
        writeFileSync(claudeFile(), "");
        configureClaudeNativeStartup(home, false);
        writeFileSync(claudeFile(), stale(readFileSync(claudeFile(), "utf8")));
        chmodSync(join(home, ".claude"), 0o500);   // directory not writable: the atomic rename cannot land
        try {
            const results = refreshManagedStartupBlocks({ homeDir: home, env: {} });
            const claude = results.find(r => r.host === "claude-code");
            expect(claude?.status, "an unwritable managed file must be REPORTED, not silently skipped").toBe("failed");
            expect(claude?.detail).toBeTruthy();
        } finally {
            chmodSync(join(home, ".claude"), 0o700);
        }
    });

    it("dry run reports the stale block without writing it", () => {
        writeFileSync(claudeFile(), "");
        configureClaudeNativeStartup(home, false);
        const older = stale(readFileSync(claudeFile(), "utf8"));
        writeFileSync(claudeFile(), older);
        const results = refreshManagedStartupBlocks({ homeDir: home, dryRun: true, env: {} });
        // Never "refreshed": a dry run must not claim a write it did not make.
        expect(results.find(r => r.host === "claude-code")?.status).toBe("would-refresh");
        expect(readFileSync(claudeFile(), "utf8")).toBe(older);
    });
});
