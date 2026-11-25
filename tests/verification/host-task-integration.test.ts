import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

describe("compiled host task protocol", () => {
    it("binds a real MCP packet to one CLI execution while an existing gate prevents all model calls", async () => {
        const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
        const cli = join(root, "dist/cli.js"), server = join(root, "dist/server.js");
        expect(existsSync(cli) && existsSync(server), "Compile this candidate before the integration test").toBe(true);
        const temp = mkdtempSync(join(tmpdir(), "prism-host-integration-"));
        const trace = join(temp, "network-attempts.jsonl"), preload = join(temp, "network-fence.mjs");
        writeFileSync(preload, [
            "import net from 'node:net'; import {appendFileSync} from 'node:fs';",
            "const deny=kind=>{appendFileSync(process.env.PRISM_HOST_TEST_TRACE,JSON.stringify({kind})+'\\n',{mode:0o600});throw Error('fixture_network_forbidden');};",
            "globalThis.fetch=async()=>deny('fetch');net.Socket.prototype.connect=function(){return deny('socket');};",
        ].join("\n"), { mode: 0o600 });
        const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined));
        Object.assign(env, { PRISM_HOST_TASKS: "required", PRISM_DATA_DIR: temp, PRISM_CONFIG_PATH: join(temp, "config.db"),
            PRISM_DB_PATH: join(temp, "memory.db"), PRISM_STORAGE: "local", PRISM_USER_ID: "host-task-integration-fixture",
            PRISM_SYNALUX_API_KEY: "", PRISM_SYNALUX_BASE_URL: "", SYNALUX_BASE_URL: "", BRAVE_API_KEY: "", VOYAGE_API_KEY: "",
            PRISM_DARK_FACTORY_ENABLED: "false", PRISM_HOST_TEST_TRACE: trace, PRISM_DEBUG_LOGGING: "false", DOTENV_CONFIG_QUIET: "true" });
        const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", preload, server], cwd: root, env, stderr: "pipe" });
        const client = new Client({ name: "host-task-contract-fixture", version: "1.0.0" });
        const runCli = (file: string, approve: boolean, selectedEnv = env) => spawnSync(process.execPath,
            ["--import", preload, cli, "local", "run", "--host-task", file, ...(approve ? ["--approve"] : [])],
            { cwd: root, env: selectedEnv, encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 ** 2 });
        try {
            await client.connect(transport);
            const catalog = await client.listTools();
            expect(catalog.tools.find(tool => tool.name === "prism_infer")?.outputSchema).toBeDefined();
            const query = await client.callTool({ name: "query_memory_natural", arguments: {
                question: "Explain the routine project notes.", web_fallback: false,
            } });
            expect(query.structuredContent).toMatchObject({ status: "host_authorization_required", host_task: { record: { kind: "query_memory_natural" } } });
            const response = await client.callTool({ name: "prism_infer", arguments: {
                prompt: "Explain a routine array sort.", mode: "code", local_backend: "omlx", local_model: "fixture-coder",
                model_ceiling: "2b", cloud_fallback: false, verify: false, escalation: "report", host_authorized: true,
            } });
            expect(response.isError).not.toBe(true);
            const body = response.structuredContent as Record<string, any>;
            expect(body.status).toBe("host_authorization_required");
            const schema = catalog.tools.find(tool => tool.name === "prism_infer")!.outputSchema!;
            const validate = new AjvJsonSchemaValidator().getValidator(schema);
            expect(validate(body).valid).toBe(true);
            expect(validate({ ...body, host_task: { ...body.host_task, record: {} } }).valid).toBe(false);
            expect(validate({ output: "unfinished answer", backend: "omlx" }).valid).toBe(false);
            const intercepted = await client.callTool({ name: "prism_infer", arguments: { prompt: "I might hurt myself tonight." } });
            expect(intercepted.structuredContent).toMatchObject({ backend: "safety_gate", used_cloud: false });
            expect(intercepted.structuredContent).not.toHaveProperty("host_task");
            expect(validate(intercepted.structuredContent).valid).toBe(true);
            expect(validate({ ...intercepted.structuredContent, ...body }).valid).toBe(false);
            const packet = join(temp, "reviewed-packet.json"); writeFileSync(packet, JSON.stringify(body), { mode: 0o600 });
            const missingApproval = runCli(packet, false);
            expect(missingApproval.status).toBe(1); expect(missingApproval.stderr).toContain("host_review_required");
            const changed = structuredClone(body); changed.host_task.execution.prompt = "Substituted task.";
            const changedFile = join(temp, "changed-packet.json"); writeFileSync(changedFile, JSON.stringify(changed), { mode: 0o600 });
            const substitution = runCli(changedFile, true);
            expect(substitution.status).toBe(1); expect(substitution.stderr).toContain("host_task_binding_changed");
            const otherProfile = runCli(packet, true, { ...env, PRISM_CONFIG_PATH: join(temp, "another-profile.db") });
            expect(otherProfile.status).toBe(1); expect(otherProfile.stderr).toContain("host_task_binding_changed");
            const approved = runCli(packet, true);
            expect(approved.error).toBeUndefined(); expect(approved.status, approved.stderr).toBe(0);
            let result: any;
            try { result = JSON.parse(approved.stdout.trim()); }
            catch { throw new Error("CLI stdout JSON contract failed: " + approved.stdout); }
            expect(result.structuredContent).toMatchObject({ backend: "refused", used_cloud: false, gate_outcome: { status: "refused" } });
            const replay = runCli(packet, true);
            expect(replay.status).toBe(1); expect(replay.stderr).toContain("host_task_already_used");
            const state = readFileSync(join(temp, "host-tasks", body.host_task.record.id + ".json"), "utf8");
            expect(state).not.toContain("Explain a routine array sort.");
            expect(existsSync(trace) ? readFileSync(trace, "utf8") : "").toBe("");
        } finally { await client.close(); rmSync(temp, { recursive: true, force: true }); }
    }, 60000);
});
