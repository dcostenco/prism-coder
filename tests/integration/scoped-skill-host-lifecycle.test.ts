/**
 * Scoped skill lifecycle: authenticated manifest -> atomic cache -> prompt
 * routing -> host CLI injection.
 *
 * The unit suites cover these components independently. This test keeps the
 * network and Portal database mocked, while deliberately executing Prism's
 * real manifest validator/materializer, config transaction, cache-backed
 * routing, inline budget shaper, and fresh-process route-prompt CLI.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fixtureRoot: string;
let agentsSkillsDir: string;
let previousConfigPath: string | undefined;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousStorage: string | undefined;
let previousForceLocal: string | undefined;
let previousSyncDisabled: string | undefined;
let storage: typeof import("../../src/storage/configStorage.js");
let runtimeStorage: typeof import("../../src/storage/index.js");
let sync: typeof import("../../src/skillManifestSync.js");
let ledger: typeof import("../../src/tools/ledgerHandlers.js");
let promptRoute: typeof import("../../src/tools/promptRouteHandler.js");
let skillRouting: typeof import("../../src/tools/skillRouting.js");
let promptRouteHook: typeof import("../../src/promptRouteHostHook.js");
let prismUserId: string;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve("tsx/cli");
const SCOPED_SKILL_NAME = "release-note-helper";
const SCOPED_SKILL_MARKER = "PUBLIC_FIXTURE_REACHED_HOST";
const SCOPED_PROMPT = "Draft a release note for the updated account page";
const UNRELATED_PROMPT = "fix the inventory sidebar spacing";
const SCOPED_SKILL_CONTENT = [
  "---",
  `name: ${SCOPED_SKILL_NAME}`,
  "description: Public integration fixture for scoped skill delivery.",
  "prompt_triggers:",
  '  - "\\\\brelease note\\\\b"',
  "---",
  "",
  "# Release note helper",
  "",
  SCOPED_SKILL_MARKER,
  "",
  "Write a concise release note from the facts supplied by the user.",
  "Do not invent dates, versions, customer names, or validation results.",
  "",
  ...Array.from(
    { length: 110 },
    (_, index) => `Fixture section ${index + 1}: preserve supplied facts and keep the result reviewable.`,
  ),
].join("\n");

function manifestSkill(
  name: string,
  content: string,
  options: { scoped?: boolean; priority: number },
) {
  const source = options.scoped ? "database" as const : "filesystem" as const;
  const metadata = options.scoped
    ? { protected: false, priority: options.priority, categories: ["native" as const], minimum_plan: "standard" as const }
    : { protected: true, priority: options.priority, categories: ["universal" as const] };
  return {
    name,
    content,
    digest: digest(content),
    version: 1,
    source,
    metadata,
    files: {
      "SKILL.md": { content, digest: digest(content), encoding: "utf8" as const },
    },
  };
}

async function buildManifest(includeScopedSkill: boolean, routingVersion: number, scopedContent = SCOPED_SKILL_CONTENT) {
  const floor = skillRouting.REQUIRED_NATIVE_SKILL_NAMES.map((name, index) =>
    manifestSkill(name, `---\nname: ${name}\n---\n# ${name}\nProtected fixture.\n`, { priority: index }),
  );
  const skills = includeScopedSkill
    ? [...floor, manifestSkill(SCOPED_SKILL_NAME, scopedContent, { scoped: true, priority: 500 })]
    : floor;
  const value: import("../../src/skillManifestSync.js").SkillManifest = {
    schema_version: 1,
    generation_algorithm: "sha256-json-v1",
    complete: true,
    generation: "",
    tier: "standard",
    routing_version: routingVersion,
    skills,
  };
  value.generation = sync.computeSkillManifestGeneration(value);
  return value;
}

function response(value: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

async function runRouteCli(prompt: string, loaded = "") {
  const child = spawn(process.execPath, [TSX_CLI, "src/cli.ts", "route-prompt", "--loaded", loaded], {
    cwd: process.cwd(),
    env: { ...process.env, PRISM_CONFIG_PATH: join(fixtureRoot, "config.db") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(prompt);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(`route-prompt exited ${exitCode}: ${Buffer.concat(stderr).toString("utf8")}`);
  }
  return JSON.parse(Buffer.concat(stdout).toString("utf8"));
}

function runHook(script: string, payload: unknown, cli: string) {
  const result = execFileSync(
    "python3",
    [script, `--v${promptRouteHook.PROMPT_ROUTE_HOOK_VERSION}`],
    {
      input: JSON.stringify(payload),
      env: {
        ...process.env,
        HOME: fixtureRoot,
        PRISM_CONFIG_PATH: join(fixtureRoot, "config.db"),
        PRISM_ROUTE_CLI: cli,
        PRISM_ROUTE_SKILLS_INDEX: join(agentsSkillsDir, ".prism-managed-skills.json"),
      },
      encoding: "utf8",
    },
  ).trim();
  return JSON.parse(result) as {
    continue: boolean;
    hookSpecificOutput?: { hookEventName: string; additionalContext: string };
  };
}

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "prism-scoped-skill-lifecycle-"));
  agentsSkillsDir = join(fixtureRoot, ".agents", "skills");
  previousConfigPath = process.env.PRISM_CONFIG_PATH;
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousStorage = process.env.PRISM_STORAGE;
  previousForceLocal = process.env.PRISM_FORCE_LOCAL;
  previousSyncDisabled = process.env.PRISM_SKILL_SYNC_DISABLED;
  process.env.HOME = fixtureRoot;
  process.env.USERPROFILE = fixtureRoot;
  process.env.PRISM_CONFIG_PATH = join(fixtureRoot, "config.db");
  process.env.PRISM_STORAGE = "local";
  process.env.PRISM_FORCE_LOCAL = "true";
  process.env.PRISM_SKILL_SYNC_DISABLED = "false";
  vi.resetModules();
  storage = await import("../../src/storage/configStorage.js");
  runtimeStorage = await import("../../src/storage/index.js");
  sync = await import("../../src/skillManifestSync.js");
  ledger = await import("../../src/tools/ledgerHandlers.js");
  promptRoute = await import("../../src/tools/promptRouteHandler.js");
  skillRouting = await import("../../src/tools/skillRouting.js");
  promptRouteHook = await import("../../src/promptRouteHostHook.js");
  ({ PRISM_USER_ID: prismUserId } = await import("../../src/config.js"));
  await storage.initConfigStorage();
});

afterEach(async () => {
  sync._resetSkillManifestSyncForTest();
  await runtimeStorage.closeStorage();
  storage.closeConfigStorage();
  if (previousConfigPath === undefined) delete process.env.PRISM_CONFIG_PATH;
  else process.env.PRISM_CONFIG_PATH = previousConfigPath;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousStorage === undefined) delete process.env.PRISM_STORAGE;
  else process.env.PRISM_STORAGE = previousStorage;
  if (previousForceLocal === undefined) delete process.env.PRISM_FORCE_LOCAL;
  else process.env.PRISM_FORCE_LOCAL = previousForceLocal;
  if (previousSyncDisabled === undefined) delete process.env.PRISM_SKILL_SYNC_DISABLED;
  else process.env.PRISM_SKILL_SYNC_DISABLED = previousSyncDisabled;
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe("scoped skill host lifecycle", () => {
  it("routes a CRLF skill whose description mentions prompt_triggers: end to end, and names the routing table", async () => {
    // Two parser defects left a delivered skill silently inert: a file saved
    // with Windows line endings, and a description line ending in the key's
    // own text. Both are present here; the skill must still route through
    // sync -> cache -> a fresh route-prompt process, and the injection must
    // name the routing table version the device used.
    const content = SCOPED_SKILL_CONTENT
      .replace("description: Public integration fixture for scoped skill delivery.",
        "description: Public integration fixture that routes on its own prompt_triggers:")
      .replace(/\n/g, "\r\n");
    expect(content).toContain("\r\nprompt_triggers:\r\n");
    const manifest = await buildManifest(true, 43, content);
    const applied = await sync.triggerSkillManifestSync({
      baseUrl: "https://portal.example.invalid",
      agentsSkillsDir,
      claudeCodeSkillsDir: false,
      cursorSkillsDir: false,
      claudeCodeAgentsDir: false,
      codexAgentsDir: false,
      geminiAgentsDir: false,
      fetchImpl: vi.fn(() => response(manifest)) as unknown as typeof fetch,
      configuredCredential: true,
      getJwt: async () => "fixture-jwt",
    });
    expect(applied.status).toBe("applied");
    expect(await storage.getSetting(`skill:${SCOPED_SKILL_NAME}`)).toBe(content);

    await storage.setSetting("routing_keywords", JSON.stringify({ version: manifest.routing_version, prompt_keywords: {} }));
    const routed = await ledger.runPromptRouteFromCache(SCOPED_PROMPT, []);
    expect(routed.names).toEqual([SCOPED_SKILL_NAME]);

    const cli = await runRouteCli(SCOPED_PROMPT);
    expect(cli.names).toEqual([SCOPED_SKILL_NAME]);
    expect(cli.text).toContain(SCOPED_SKILL_MARKER);
    expect(cli.text).toContain("Routing table v43.");
    const unrelated = await runRouteCli(UNRELATED_PROMPT);
    expect(unrelated.names).toEqual([]);
  });

  it("survives authenticated sync, atomic cache, cached routing, and the cross-platform CLI; downgrade revokes it", async () => {
    const skillContent = SCOPED_SKILL_CONTENT;
    const initial = await buildManifest(true, 42);
    const fetchImpl = vi.fn(() => response(initial)) as unknown as typeof fetch;

    const applied = await sync.triggerSkillManifestSync({
      baseUrl: "https://portal.example.invalid",
      agentsSkillsDir,
      claudeCodeSkillsDir: false,
      cursorSkillsDir: false,
      claudeCodeAgentsDir: false,
      codexAgentsDir: false,
      geminiAgentsDir: false,
      fetchImpl,
      configuredCredential: true,
      getJwt: async () => "fixture-jwt",
    });

    expect(applied.status).toBe("applied");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://portal.example.invalid/api/v1/prism/skill-manifest",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer fixture-jwt" }),
      }),
    );
    expect(JSON.parse(await storage.getSetting("skill_manifest:names")))
      .toContain(SCOPED_SKILL_NAME);
    expect(await storage.getSetting("skill_manifest:routing_version")).toBe(String(initial.routing_version));
    expect(await storage.getSetting(`skill:${SCOPED_SKILL_NAME}`)).toBe(skillContent);
    expect(await readFile(join(agentsSkillsDir, SCOPED_SKILL_NAME, "SKILL.md"), "utf8"))
      .toBe(skillContent);

    // Run the real first-turn startup path against an actual isolated SQLite
    // handoff. This exercises startup sync reuse, native skill discovery,
    // scoped trigger matching, excerpt/offload budgeting, and final rendering.
    await storage.setSetting("autoload_projects", "public-fixture");
    await storage.setSetting("default_context_depth", "standard");
    await storage.setSetting("agent_name", "Scoped lifecycle test");
    await storage.setSetting("first_bootstrap_at", "2026-09-19T00:00:00.000Z");
    await storage.setSetting("PRISM_STORAGE", "local");
    const backend = await runtimeStorage.getStorage();
    await backend.saveHandoff({
      project: "public-fixture",
      user_id: prismUserId,
      last_summary: "A maintainer is preparing a release note for a completed account-page change.",
      pending_todo: ["Draft the note from supplied facts without inventing validation evidence."],
      active_decisions: [],
      keywords: ["release", "notes"],
      key_context: "The fixture validates scoped skill delivery across supported host paths.",
      active_branch: "scoped-lifecycle-test",
    });

    const prompt = SCOPED_PROMPT;
    const startup = await ledger.sessionBootstrapHandler({
      conversation_id: "scoped-bootstrap",
      prompt,
    });
    const startupText = startup.content[0]?.text ?? "";
    expect(startupText).toContain(`**Symptom-triggered skills:** ${SCOPED_SKILL_NAME}`);
    expect(startupText).toContain(SCOPED_SKILL_MARKER);
    expect(startupText).toContain('conversation_id="scoped-bootstrap"');
    // Standard startup is capped at 8,000 chars plus the real protected-floor
    // digest allowance (6,000) and the reserved machine facts line (256).
    expect(startupText.length).toBeLessThanOrEqual(14_300);

    // route-prompt must stay offline. Persist the same empty public routing
    // table the client would already have; the scoped trigger rides in the
    // authenticated body and is merged on-device.
    await storage.setSetting("routing_keywords", JSON.stringify({ version: initial.routing_version, prompt_keywords: {} }));
    const routed = await ledger.runPromptRouteFromCache(prompt, []);
    expect(routed.names).toEqual([SCOPED_SKILL_NAME]);
    expect(routed.text).toContain(SCOPED_SKILL_MARKER);

    const inline = promptRoute.reshapeForInlineBudget(
      routed,
      promptRoute.HOOK_INLINE_SAFE_CHARS,
      () => { throw new Error("the scoped fixture must fit inline"); },
    );
    expect(inline.offloaded).toBe(false);
    expect(inline.text.length).toBeLessThanOrEqual(promptRoute.HOOK_INLINE_SAFE_CHARS);

    const repeated = await ledger.runPromptRouteFromCache(prompt, [SCOPED_SKILL_NAME]);
    expect(repeated.names).toEqual([]);
    expect(repeated.alreadyLoaded).toEqual([SCOPED_SKILL_NAME]);
    const unrelated = await ledger.runPromptRouteFromCache(UNRELATED_PROMPT, []);
    expect(unrelated.names).not.toContain(SCOPED_SKILL_NAME);

    const cli = await runRouteCli(prompt);
    expect(cli.names).toEqual([SCOPED_SKILL_NAME]);
    expect(cli.text).toContain(SCOPED_SKILL_MARKER);
    expect(cli.text.length).toBeLessThanOrEqual(promptRoute.HOOK_INLINE_SAFE_CHARS);
    const cliRepeat = await runRouteCli(prompt, SCOPED_SKILL_NAME);
    expect(cliRepeat.names).toEqual([]);
    expect(cliRepeat.alreadyLoaded).toEqual([SCOPED_SKILL_NAME]);
    expect(cliRepeat.text).toBe("");

    sync._resetSkillManifestSyncForTest();
    const downgraded = await buildManifest(false, initial.routing_version + 1);
    const revoked = await sync.synchronizeSkillManifest({
      baseUrl: "https://portal.example.invalid",
      agentsSkillsDir,
      claudeCodeSkillsDir: false,
      cursorSkillsDir: false,
      claudeCodeAgentsDir: false,
      codexAgentsDir: false,
      geminiAgentsDir: false,
      fetchImpl: vi.fn(() => response(downgraded)) as unknown as typeof fetch,
      configuredCredential: true,
      getJwt: async () => "fixture-jwt",
    });
    expect(revoked.status).toBe("applied");
    expect(JSON.parse(await storage.getSetting("skill_manifest:names")))
      .not.toContain(SCOPED_SKILL_NAME);
    expect(await storage.getSetting(`skill:${SCOPED_SKILL_NAME}`, "missing")).toBe("missing");
    expect(existsSync(join(agentsSkillsDir, SCOPED_SKILL_NAME))).toBe(false);
    await storage.setSetting("routing_keywords", JSON.stringify({ version: downgraded.routing_version, prompt_keywords: {} }));
    const afterDowngrade = await ledger.runPromptRouteFromCache(prompt, []);
    expect(afterDowngrade.names).not.toContain(SCOPED_SKILL_NAME);
    const revokedCli = await runRouteCli(prompt);
    expect(revokedCli.names).not.toContain(SCOPED_SKILL_NAME);

  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "executes the generated host hook, compaction recovery, and revocation on POSIX hosts",
    async () => {
      const initial = await buildManifest(true, 52);
      const applied = await sync.triggerSkillManifestSync({
        baseUrl: "https://portal.example.invalid",
        agentsSkillsDir,
        claudeCodeSkillsDir: false,
        cursorSkillsDir: false,
        claudeCodeAgentsDir: false,
        codexAgentsDir: false,
        geminiAgentsDir: false,
        fetchImpl: vi.fn(() => response(initial)) as unknown as typeof fetch,
        configuredCredential: true,
        getJwt: async () => "fixture-jwt",
      });
      expect(applied.status).toBe("applied");
      await storage.setSetting("routing_keywords", JSON.stringify({
        version: initial.routing_version,
        prompt_keywords: {},
      }));

      // Execute the generated host hook exactly as the POSIX host adapters do:
      // JSON on stdin and stdout, with the hook invoking the real Prism CLI.
      const hookDir = join(fixtureRoot, "hook");
      mkdirSync(join(hookDir, "state"), { recursive: true });
      const hookScript = join(hookDir, "on_prompt.py");
      writeFileSync(hookScript, promptRouteHook.PROMPT_ROUTE_HOOK_SCRIPT);
      chmodSync(hookScript, 0o755);
      const cliWrapper = join(fixtureRoot, "prism-test-cli");
      writeFileSync(
        cliWrapper,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(TSX_CLI)} ${JSON.stringify(join(process.cwd(), "src", "cli.ts"))} "$@"\n`,
      );
      chmodSync(cliWrapper, 0o755);

      const firstHook = runHook(hookScript, { prompt: SCOPED_PROMPT, session_id: "scoped-hook" }, cliWrapper);
      const firstContext = firstHook.hookSpecificOutput?.additionalContext ?? "";
      expect(firstHook.continue).toBe(true);
      expect(firstContext).toContain("Execute the user's request now");
      expect(firstContext).toContain(SCOPED_SKILL_NAME);
      expect(firstContext).toContain(SCOPED_SKILL_MARKER);
      expect(firstContext.length).toBeLessThanOrEqual(9_800);
      expect(JSON.parse(readFileSync(join(hookDir, "state", "scoped-hook.json"), "utf8")))
        .toMatchObject({ names: [SCOPED_SKILL_NAME] });

      const secondHook = runHook(hookScript, { prompt: SCOPED_PROMPT, session_id: "scoped-hook" }, cliWrapper);
      expect(secondHook.hookSpecificOutput).toBeUndefined();

      const unrelatedHook = runHook(hookScript, {
        prompt: UNRELATED_PROMPT,
        session_id: "unrelated-hook",
      }, cliWrapper);
      expect(unrelatedHook.hookSpecificOutput).toBeUndefined();
      expect(existsSync(join(hookDir, "state", "unrelated-hook.json"))).toBe(false);

      const compactHook = runHook(hookScript, {
        hook_event_name: "SessionStart",
        source: "compact",
        session_id: "scoped-hook",
      }, cliWrapper);
      const compactContext = compactHook.hookSpecificOutput?.additionalContext ?? "";
      expect(compactHook.hookSpecificOutput?.hookEventName).toBe("SessionStart");
      expect(compactContext).toContain(SCOPED_SKILL_NAME);
      expect(compactContext).toContain("Read that file now and follow those skills before proceeding");
      const compactOffload = compactContext.match(/full text of all 1 skill\(s\) is saved at: ([^*\n]+)\*\*/)?.[1]?.trim();
      expect(compactOffload).toBeTruthy();
      expect(readFileSync(compactOffload!, "utf8")).toContain(SCOPED_SKILL_MARKER);
      expect(compactContext.length).toBeLessThanOrEqual(9_800);

      sync._resetSkillManifestSyncForTest();
      const downgraded = await buildManifest(false, initial.routing_version + 1);
      const revoked = await sync.synchronizeSkillManifest({
        baseUrl: "https://portal.example.invalid",
        agentsSkillsDir,
        claudeCodeSkillsDir: false,
        cursorSkillsDir: false,
        claudeCodeAgentsDir: false,
        codexAgentsDir: false,
        geminiAgentsDir: false,
        fetchImpl: vi.fn(() => response(downgraded)) as unknown as typeof fetch,
        configuredCredential: true,
        getJwt: async () => "fixture-jwt",
      });
      expect(revoked.status).toBe("applied");
      await storage.setSetting("routing_keywords", JSON.stringify({
        version: downgraded.routing_version,
        prompt_keywords: {},
      }));

      const revokedHook = runHook(hookScript, { prompt: SCOPED_PROMPT, session_id: "scoped-hook" }, cliWrapper);
      expect(revokedHook.hookSpecificOutput).toBeUndefined();
      expect(JSON.parse(readFileSync(join(hookDir, "state", "scoped-hook.json"), "utf8")))
        .toMatchObject({ names: [] });
    },
    30_000,
  );
});
