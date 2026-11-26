import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const entry = new URL("../prism-agent.mjs", import.meta.url);
const settings = new URL("../../dist/utils/localCodingSettings.js", import.meta.url);
const storage = new URL("../../dist/storage/configStorage.js", import.meta.url);
const handler = new URL("../../dist/tools/prismInferHandler.js", import.meta.url);
const entitlements = new URL("../../dist/utils/entitlements.js", import.meta.url);
const memory = new URL("../../dist/utils/availableMemory.js", import.meta.url);
const request = 'PRISM_TOOL_REQUESTS\n[{"name":"read_file","arguments":{"path":"facts.txt"}}]';
const GiB = 1024 ** 3;

function fixture(t, { config, assignment, replies, rounds = 2, model, timeout, backendOverride, malformedOmlxSettings,
  planCeiling, ceiling, availableBytes = 16 * GiB, ollamaParams = 9e9, ollamaWeight = 2 * GiB,
  ollamaUrl = "http://127.0.0.1:19992/" }) {
  const dir = mkdtempSync(join(tmpdir(), "prism-agent-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tracePath = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "facts.txt"), "synthetic-tool-result");
  writeFileSync(tracePath, "");
  if (malformedOmlxSettings) {
    mkdirSync(join(dir, ".omlx"));
    writeFileSync(join(dir, ".omlx", "settings.json"), "{");
  }
  const preload = join(dir, "preload.mjs");
  const mockHandler = `
    import { appendFileSync } from "node:fs";
    import { setTimeout } from "node:timers/promises";
    const replies = ${JSON.stringify(replies)};
    export async function prismInferHandler(args, deps, context) {
      const log = value => appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(value) + "\\n");
      log({ transport: "omlx", args, localOnly: context.localOnly, required: context.requiredLocalBackend });
      const reply = replies.shift();
      if (reply.waitForAbort) {
        try { await setTimeout(5_000, undefined, { signal: context.signal }); }
        catch (error) { log({ stopped: context.signal.aborted }); throw error; }
      }
      return { structuredContent: {
        backend: "omlx", model_picked: args.local_model ?? "auto-discovered-mlx",
        used_cloud: false, gate_outcome: { status: "success" }, output_origin: "model", ...reply
      } };
    }
  `;
  const modules = { [handler.href]: mockHandler,
    [memory.href]: `export function getAvailableMemoryBytes() { return ${availableBytes}; }` };
  if (planCeiling) {
    modules[entitlements.href] = `export { clampCeiling } from ${JSON.stringify(entitlements.href + "?fixture-original")};
    export async function getEntitlements() {
      return { model_ceiling: ${JSON.stringify(planCeiling)} };
    }`;
  }
  const loader = `
    const modules = ${JSON.stringify(modules)};
    export async function load(url, context, nextLoad) {
      if (Object.hasOwn(modules, url)) {
        return { format: "module", shortCircuit: true, source: modules[url] };
      }
      return nextLoad(url, context);
    }
  `;
  const ollamaModel = model ?? (assignment?.runtime === "ollama" ? assignment.model : config.models?.ollama?.coder);
  writeFileSync(preload, `
    import { appendFileSync } from "node:fs";
    import { register } from "node:module";
    import { saveLocalCodingSettings } from ${JSON.stringify(settings.href)};
    import { setSetting } from ${JSON.stringify(storage.href)};
    await saveLocalCodingSettings(${JSON.stringify(config)});
    const assignment = ${JSON.stringify(assignment)};
    if (assignment) await setSetting("execution_roles_v1", JSON.stringify({ coder: assignment }));
    register(${JSON.stringify("data:text/javascript," + encodeURIComponent(loader))});
    globalThis.fetch = async (url, init = {}) => {
      const args = init.body ? JSON.parse(init.body) : undefined;
      appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ transport: "http", url, redirect: init.redirect, args }) + "\\n");
      switch (url) {
        case "http://127.0.0.1:19992/api/tags":
          return Response.json({ models: [{ name: ${JSON.stringify(ollamaModel)}, size: ${ollamaWeight} }] });
        case "http://127.0.0.1:19992/api/ps":
          return Response.json({ models: [] });
        case "http://127.0.0.1:19992/api/show":
          if (args?.model !== ${JSON.stringify(ollamaModel)}) throw new Error("Unexpected model metadata request");
          return Response.json({
            capabilities: ["completion", "tools"],
            model_info: {
              "general.parameter_count": ${ollamaParams},
              "general.architecture": "fixture",
              "fixture.context_length": 32768,
              "fixture.block_count": 24,
              "fixture.attention.head_count_kv": 4,
              "fixture.embedding_length": 2048,
              "fixture.attention.head_count": 16,
            },
          });
        case "http://127.0.0.1:19992/api/chat":
          return Response.json({ message: { content: "Ollama fixture answer" } });
        default:
          throw new Error("Unexpected network request");
      }
    };
  `);
  const cliArgs = [...(ceiling ? ["--ceiling", ceiling] : []), "Read the fixture."];
  const child = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, fileURLToPath(entry), ...cliArgs], {
    cwd: dir, encoding: "utf8", timeout: 15_000,
    env: { HOME: dir, USERPROFILE: dir, PATH: process.env.PATH, PRISM_MAX_ROUNDS: String(rounds),
      PRISM_LOCAL_LLM_URL: ollamaUrl,
      ...(backendOverride ? { PRISM_LOCAL_CODING_BACKEND: backendOverride } : {}),
      ...(model ? { PRISM_MODEL: model } : {}), ...(timeout ? { PRISM_TIMEOUT_MS: String(timeout) } : {}) },
  });
  assert.ifError(child.error);
  const trace = readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { ...child, trace };
}

const omlx = { backend: "omlx", source: "existing", models: { omlx: { coder: "fixture-mlx" } } };
const ollama = { backend: "ollama", source: "existing", models: { ollama: { coder: "fixture:9b" } } };

test("saved oMLX backend and coder model drive the CLI tool loop", t => {
  const run = fixture(t, { config: omlx, replies: [{ output: request }, { output: "Final fixture answer" }] });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Final fixture answer/);
  assert.equal(run.trace.length, 2);
  for (const { transport, args, localOnly, required } of run.trace) {
    assert.equal(transport, "omlx");
    assert.equal(args.local_backend, "omlx");
    assert.equal(args.local_model, "fixture-mlx");
    assert.equal(args.cloud_fallback, false);
    assert.equal(localOnly, true);
    assert.equal(required, "omlx");
  }
  assert.match(run.trace[1].args.prompt, /synthetic-tool-result/);
  assert.match(run.trace[1].args.system, /Tools are unavailable/);
});

test("Ollama still uses native chat with the saved model and configured URL", t => {
  const run = fixture(t, { config: ollama, replies: [] });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Ollama fixture answer/);
  assert.deepEqual(run.trace.map(call => new URL(call.url).pathname), ["/api/tags", "/api/ps", "/api/show", "/api/chat"]);
  const chat = run.trace[3];
  assert.equal(chat.redirect, "error");
  assert.equal(chat.args.model, "fixture:9b");
  assert.equal(chat.args.options.num_ctx, 16384);
  assert.ok(chat.args.tools.some(tool => tool.function.name === "read_file"));
});

for (const [name, options, reason] of [
  ["caller ceiling", { ceiling: "4b", ollamaParams: 27e9 }, /ollama_model_ceiling/],
  ["plan ceiling", { planCeiling: "4b", ollamaParams: 27e9 }, /ollama_model_ceiling/],
  ["available RAM", { ollamaParams: 27e9, ollamaWeight: 12 * GiB }, /below the minimum for the selected Ollama model/],
]) {
  test(`a saved Ollama model over the ${name} is refused before chat`, t => {
    const config = { ...ollama, models: { ollama: { coder: "fixture:27b" } } };
    const run = fixture(t, { config, replies: [], ...options });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, reason);
    assert.deepEqual(run.trace.map(call => new URL(call.url).pathname), ["/api/tags", "/api/ps", "/api/show"]);
    assert.equal(run.stdout, "");
  });
}

test("a remote Ollama endpoint is refused before sending the prompt", t => {
  const run = fixture(t, { config: ollama, ollamaUrl: "http://example.test:11434", replies: [] });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /loopback Ollama endpoint/);
  assert.deepEqual(run.trace, []);
});

test("Auto skips oMLX settings when the plan cannot select oMLX", t => {
  const run = fixture(t, { config: { backend: "auto", source: "existing", models: { ollama: { coder: "fixture:2b" } } },
    malformedOmlxSettings: true, planCeiling: "4b", ollamaParams: 2e9, replies: [] });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.trace.length, 4);
  assert.equal(run.trace[3].url, "http://127.0.0.1:19992/api/chat");
  assert.equal(run.trace[3].args.model, "fixture:2b");
});

test("the coder role model takes precedence over the older backend model", t => {
  const run = fixture(t, { config: omlx, assignment: { runtime: "omlx", model: "role-mlx" },
    replies: [{ output: "Fixture answer" }] });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.trace[0].args.local_model, "role-mlx");
});

test("an environment override that conflicts with a saved coder assignment causes zero dispatches", t => {
  const run = fixture(t, { config: omlx, assignment: { runtime: "omlx", model: "role-mlx" },
    backendOverride: "ollama", replies: [] });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /execution_assignment_override_conflict/);
  assert.deepEqual(run.trace, []);
});

test("explicit model override stays within the selected local backend", t => {
  const run = fixture(t, { config: omlx, model: "cli-mlx", replies: [{ output: "Fixture answer" }] });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.trace[0].args.local_backend, "omlx");
  assert.equal(run.trace[0].args.local_model, "cli-mlx");
});

test("a hosted coder assignment causes zero local dispatches", t => {
  const run = fixture(t, { config: omlx, assignment: { runtime: "synalux" }, replies: [] });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /requires a local coder role/);
  assert.deepEqual(run.trace, []);
});

for (const [name, options, reason] of [
  ["provider refusal", { replies: [{ gate_outcome: { status: "refused", reason: "omlx_unavailable" }, output: request }] }, /omlx_unavailable/],
  ["replaced output", { replies: [{ output: request, output_origin: "replaced" }] }, /tool-enabled round/],
  ["malformed tool request", { replies: [{ output: "PRISM_TOOL_REQUESTS\n[" }] }, /Invalid oMLX tool request/],
  ["mixed tool batch with a missing required argument", {
    replies: [{ output: request.slice(0, -1) + ',{"name":"read_file","arguments":{}}]' }],
  }, /Invalid oMLX tool request/],
  ["mixed tool batch with the wrong argument type", {
    replies: [{ output: request.slice(0, -1) + ',{"name":"list_directory","arguments":{"depth":"two"}}]' }],
  }, /Invalid oMLX tool request/],
  ["final round", { rounds: 1, replies: [{ output: request }] }, /tool-enabled round/],
]) {
  test(`oMLX ${name} executes no CLI action and causes no fallback`, t => {
    const run = fixture(t, { config: omlx, ...options });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, reason);
    assert.doesNotMatch(run.stderr, /synthetic-tool-result|→ read_file/);
    assert.deepEqual(run.trace.map(event => event.transport), ["omlx"]);
    assert.equal(run.stdout, "");
  });
}

test("oMLX CLI timeout reaches the inference caller signal", t => {
  const run = fixture(t, { config: omlx, timeout: 25, replies: [{ waitForAbort: true }] });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.trace.length, 2);
  assert.equal(run.trace[0].transport, "omlx");
  assert.deepEqual(run.trace[1], { stopped: true });
});
