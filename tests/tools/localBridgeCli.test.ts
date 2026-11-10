import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("compiled local bridge CLI", () => {
    it.each(["false", "true"])("returns one machine document with debug=%s without inference", async debug => {
        const directory = await mkdtemp(join(tmpdir(), "prism-bridge-cli-"));
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
            const child = spawn(process.execPath, [resolve("dist/cli.js"), "local", "bridge"], {
                cwd: directory, env: { PATH: process.env.PATH, HOME: directory, PRISM_CONFIG_PATH: join(directory, "config.db"),
                    PRISM_STORAGE: "local", PRISM_DEBUG_LOGGING: debug }, stdio: ["pipe", "pipe", "pipe"],
            });
            let stdout = "", stderr = "";
            const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("metadata-only bridge did not close")); }, 10000);
            child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; });
            child.on("error", error => { clearTimeout(timer); reject(error); });
            child.on("close", code => { clearTimeout(timer); done({ code, stdout, stderr }); });
            child.stdin.end(JSON.stringify({ action: "preferences" }) + "\n");
        });
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ schema: 1, configured: false,
            settings: { backend: "auto", source: "existing" }, assignments: {}, resolved: { coder: { runtime: "ollama" } } });
        expect(result.stdout.trim().split("\n")).toHaveLength(1);
    }, 15000);
});
