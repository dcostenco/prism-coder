import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync } from "node:fs";
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

    it("an absent file is never created — the self-heal cannot first-install a block", () => {
        rmSync(join(home, ".claude"), { recursive: true, force: true });
        const results = refreshManagedStartupBlocks({ homeDir: home, env: {} });
        expect(results.find(r => r.host === "claude-code")?.status).toBe("absent");
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

    it("an unwritable managed file is reported, never thrown — a self-heal cannot stop a server starting", () => {
        writeFileSync(claudeFile(), "");
        configureClaudeNativeStartup(home, false);
        writeFileSync(claudeFile(), stale(readFileSync(claudeFile(), "utf8")));
        chmodSync(join(home, ".claude"), 0o500);   // directory not writable: the atomic rename cannot land
        try {
            const results = refreshManagedStartupBlocks({ homeDir: home, env: {} });
            const claude = results.find(r => r.host === "claude-code");
            expect(["failed", "refreshed"]).toContain(claude?.status);
            if (claude?.status === "failed") expect(claude.detail).toBeTruthy();
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
        expect(results.find(r => r.host === "claude-code")?.status).toBe("refreshed");
        expect(readFileSync(claudeFile(), "utf8")).toBe(older);
    });
});
