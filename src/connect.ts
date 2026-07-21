import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export const CONNECT_HOSTS = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "gemini",
  "codex",
] as const;

export type ConnectHostName = (typeof CONNECT_HOSTS)[number];
export type ConnectStatus =
  | "registered"
  | "would-register"
  | "refreshed"
  | "would-refresh"
  | "existing"
  | "error";

export interface ConnectResult {
  host: ConnectHostName;
  label: string;
  path: string;
  status: ConnectStatus;
  message?: string;
}

export interface ConnectSummary {
  results: ConnectResult[];
  usedApiKey: boolean;
  serverPath: string;
}

export interface LegacyHookMigration {
  path: string;
  status: "unchanged" | "would-remove" | "removed";
  removed: number;
}

export interface LegacyInstructionMigration {
  path: string;
  status: "unchanged" | "would-remove" | "removed";
  removed: number;
}

export interface NativeStartupConfiguration {
  path: string;
  status: "unchanged" | "would-install" | "would-refresh" | "installed" | "refreshed";
}

export interface ConnectOptions {
  all?: boolean;
  dryRun?: boolean;
  refresh?: boolean;
  hosts?: ConnectHostName[];
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pathEnv?: string;
  serverPath?: string;
  nodePath?: string;
  /** Test seam for simulating a host write immediately before commit. */
  beforeCommit?: (path: string) => void;
}

interface HostDefinition {
  name: ConnectHostName;
  label: string;
  format: "json" | "codex-toml";
  configPath: string;
  detectionPaths: string[];
  executables: string[];
  configurationError?: string;
}

type JsonObject = Record<string, unknown>;

const HOST_ALIASES: Record<string, ConnectHostName> = {
  "claude-code": "claude-code",
  claude: "claude-code",
  code: "claude-code",
  "claude-desktop": "claude-desktop",
  desktop: "claude-desktop",
  cursor: "cursor",
  gemini: "gemini",
  "gemini-cli": "gemini",
  codex: "codex",
  "codex-cli": "codex",
};

const CODEX_MANAGED_START = "# >>> prism connect managed: prism-mcp";
const CODEX_MANAGED_END = "# <<< prism connect managed: prism-mcp";
const CLAUDE_STARTUP_MANAGED_START = "<!-- >>> prism connect managed: native startup -->";
const CLAUDE_STARTUP_MANAGED_END = "<!-- <<< prism connect managed: native startup -->";
const GEMINI_STARTUP_MANAGED_START = "<!-- >>> prism connect managed: native startup -->";
const GEMINI_STARTUP_MANAGED_END = "<!-- <<< prism connect managed: native startup -->";
const CONNECT_STORAGE_BACKENDS = ["auto", "local", "synalux", "supabase"] as const;

export function normalizeHostName(value: string): ConnectHostName {
  const normalized = value.trim().toLowerCase();
  const host = HOST_ALIASES[normalized];
  if (!host) {
    throw new Error(
      `Unsupported host "${value}". Choose one of: ${CONNECT_HOSTS.join(", ")}`,
    );
  }
  return host;
}

export function resolveInstalledServerPath(moduleUrl = import.meta.url): string {
  const manifestPath = fileURLToPath(new URL("../package.json", moduleUrl));
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read Prism package manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isJsonObject(manifest) || typeof manifest.main !== "string" || !manifest.main.trim()) {
    throw new Error(`Prism package manifest has no valid "main" entry: ${manifestPath}`);
  }

  const serverPath = resolve(dirname(manifestPath), manifest.main);
  if (!existsSync(serverPath)) {
    throw new Error(`Prism server entrypoint was not found: ${serverPath}. Run npm run build first.`);
  }
  return realpathSync(serverPath);
}

export function connectHosts(options: ConnectOptions = {}): ConnectSummary {
  if (options.all && options.hosts?.length) {
    throw new Error("Use either --all or --host, not both.");
  }

  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const serverPath = options.serverPath ?? resolveInstalledServerPath();
  const nodePath = options.nodePath ?? process.execPath;
  const definitions = getHostDefinitions(homeDir, platform, env, options.homeDir === undefined);
  const pathEnv = options.pathEnv ?? env.PATH ?? "";

  let selected: HostDefinition[];
  if (options.hosts?.length) {
    const requested = new Set(options.hosts);
    selected = definitions.filter((definition) => requested.has(definition.name));
    const unavailable = options.hosts.filter(
      (host) => !selected.some((definition) => definition.name === host),
    );
    if (unavailable.length > 0) {
      throw new Error(`${unavailable.join(", ")} is not supported on ${platform}`);
    }
  } else if (options.all) {
    selected = definitions;
  } else {
    selected = definitions.filter((definition) => isHostDetected(definition, platform, pathEnv));
  }

  const entry = buildMcpEntry(nodePath, serverPath, env);
  const results = selected.map((definition) => registerHost(
    definition,
    entry,
    !!options.dryRun,
    !!options.refresh,
    options.beforeCommit,
  ));
  return {
    results,
    usedApiKey: typeof env.PRISM_SYNALUX_API_KEY === "string" && env.PRISM_SYNALUX_API_KEY.length > 0,
    serverPath,
  };
}

function legacyClaudeHookTuples(homeDir: string): Set<string> {
  const hooksDir = join(homeDir, ".claude", "hooks");
  const syncSkills = `${join(homeDir, "prism", "scripts", "sync-skills.sh")} > /dev/null 2>&1`;
  const loadMatcher = "session_load_context|mcp__prism-mcp__session_load_context";
  const driftMatcher = "session_detect_drift|mcp__prism-mcp__session_detect_drift|session_save_ledger|mcp__prism-mcp__session_save_ledger";
  const stop = "python3 -c \"import json; print(json.dumps({'continue': True, 'suppressOutput': True, 'systemMessage': 'MANDATORY END WORKFLOW: 1) Call mcp__prism-mcp__session_save_ledger with project and summary. 2) Call mcp__prism-mcp__session_save_handoff with expected_version set to the loaded version.'}))\"";
  const tuple = (event: string, matcher: string, command: string) =>
    JSON.stringify([event, matcher, "command", command]);
  return new Set([
    tuple("SessionStart", "*", `python3 ${join(hooksDir, "prism-startup", "init.py")}`),
    tuple("SessionStart", "*", syncSkills),
    tuple("UserPromptSubmit", "*", `python3 ${join(hooksDir, "prism-startup", "guard_on_submit.py")}`),
    tuple("UserPromptSubmit", "*", join(hooksDir, "prism-startup", "maybe_sync_skills.sh")),
    tuple("PostToolUse", loadMatcher, `python3 ${join(hooksDir, "prism-startup", "mark_loaded.py")}`),
    tuple("PostToolUse", driftMatcher, `python3 ${join(hooksDir, "drift-detection", "reset_timer.py")}`),
    tuple("PostToolUseFailure", loadMatcher, `python3 ${join(hooksDir, "prism-startup", "record_retry.py")}`),
    tuple("SessionEnd", "*", `python3 ${join(hooksDir, "prism-startup", "cleanup.py")}`),
    tuple("SessionEnd", "*", syncSkills),
    tuple("Stop", "*", stop),
  ]);
}

/**
 * Remove only the exact Claude lifecycle hooks installed by Prism's legacy
 * bootstrap script. Native skills and server-side drift reminders now own the
 * same behavior; unrelated and near-match user hooks must remain untouched.
 */
export function migrateLegacyClaudeHooks(
  homeDir = homedir(),
  dryRun = false,
  beforeCommit?: (path: string) => void,
): LegacyHookMigration {
  const configPath = join(homeDir, ".claude", "settings.json");
  let writePath = configPath;
  let symlinkPath: string | undefined;
  let originalText: string;

  try {
    const pathInfo = lstatSync(configPath);
    if (pathInfo.isSymbolicLink()) {
      writePath = realpathSync(configPath);
      symlinkPath = configPath;
      if (!statSync(writePath).isFile()) throw new Error("target is not a regular file");
    }
    originalText = readFileSync(writePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { path: configPath, status: "unchanged", removed: 0 };
    throw new Error(`Could not inspect Claude hook settings: ${error instanceof Error ? error.message : String(error)}`);
  }

  let config: JsonObject;
  try {
    const parsed: unknown = JSON.parse(originalText);
    if (!isJsonObject(parsed)) throw new Error("top-level JSON value must be an object");
    config = parsed;
  } catch (error) {
    throw new Error(`Could not parse Claude hook settings: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isJsonObject(config.hooks)) return { path: configPath, status: "unchanged", removed: 0 };
  const legacyTuples = legacyClaudeHookTuples(homeDir);
  const nextEvents: JsonObject = {};
  let removed = 0;

  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) {
      nextEvents[event] = groups;
      continue;
    }
    const nextGroups: unknown[] = [];
    for (const group of groups) {
      if (!isJsonObject(group) || !Array.isArray(group.hooks)) {
        nextGroups.push(group);
        continue;
      }
      let removedFromGroup = 0;
      const nextHooks = group.hooks.filter((hook) => {
        const owned = isJsonObject(hook)
          && hook.type === "command"
          && typeof hook.command === "string"
          && legacyTuples.has(JSON.stringify([event, group.matcher, hook.type, hook.command]));
        if (owned) removedFromGroup += 1;
        return !owned;
      });
      removed += removedFromGroup;
      if (removedFromGroup === 0) nextGroups.push(group);
      else if (nextHooks.length > 0) nextGroups.push({ ...group, hooks: nextHooks });
    }
    if (nextGroups.length > 0) nextEvents[event] = nextGroups;
  }

  if (removed === 0) return { path: configPath, status: "unchanged", removed: 0 };
  if (Object.keys(nextEvents).length > 0) config.hooks = nextEvents;
  else delete config.hooks;
  if (dryRun) return { path: configPath, status: "would-remove", removed };

  writeTextAtomically(
    writePath,
    `${JSON.stringify(config, null, 2)}\n`,
    originalText,
    beforeCommit,
    symlinkPath,
  );
  return { path: configPath, status: "removed", removed };
}

/**
 * Remove the legacy Prism-only startup sections from ~/CLAUDE.md. The rest of
 * the developer's global instructions remain byte-for-byte unchanged. Native
 * skill and MCP metadata now own first-turn bootstrap selection.
 */
export function migrateLegacyClaudeInstructions(
  homeDir = homedir(),
  dryRun = false,
  beforeCommit?: (path: string) => void,
): LegacyInstructionMigration {
  const instructionPath = join(homeDir, "CLAUDE.md");
  let writePath = instructionPath;
  let symlinkPath: string | undefined;
  let originalText: string;
  let instructionEntryExists = false;

  try {
    const pathInfo = lstatSync(instructionPath);
    instructionEntryExists = true;
    if (pathInfo.isSymbolicLink()) {
      writePath = realpathSync(instructionPath);
      symlinkPath = instructionPath;
      if (!statSync(writePath).isFile()) throw new Error("target is not a regular file");
    }
    originalText = readFileSync(writePath, "utf8");
  } catch (error) {
    if (!instructionEntryExists && isErrno(error, "ENOENT")) {
      return { path: instructionPath, status: "unchanged", removed: 0 };
    }
    throw new Error(`Could not inspect Claude instructions: ${error instanceof Error ? error.message : String(error)}`);
  }

  const stepOne = findExactLineRanges(
    originalText,
    "## STEP 1: Auto-Load Prism Memory (MUST BE YOUR FIRST ACTION — NO EXCEPTIONS)",
  );
  const hardGates = findExactLineRanges(
    originalText,
    "## HARD BEHAVIORAL GATES — SUPERSEDE ALL OTHER INSTRUCTIONS",
  );
  if (stepOne.length !== 1 || hardGates.length !== 1 || hardGates[0].start <= stepOne[0].start) {
    return { path: instructionPath, status: "unchanged", removed: 0 };
  }

  const legacyBlock = originalText.slice(stepOne[0].start, hardGates[0].start);
  const signatures = [
    'mcp__prism-mcp__session_load_context(project="prism-mcp")',
    "## STEP 2: Display Startup Block (ONLY AFTER STEP 1 COMPLETES)",
    "Use the `[📜 SKILL: ...]` blocks returned by session_load_context to build the display:",
  ];
  if (!signatures.every((signature) => legacyBlock.includes(signature))) {
    return { path: instructionPath, status: "unchanged", removed: 0 };
  }

  const nextText = originalText.slice(0, stepOne[0].start) + originalText.slice(hardGates[0].start);
  if (dryRun) return { path: instructionPath, status: "would-remove", removed: 2 };
  writeTextAtomically(writePath, nextText, originalText, beforeCommit, symlinkPath);
  return { path: instructionPath, status: "removed", removed: 2 };
}

/** Remove only Prism's marked startup block from the former ~/CLAUDE.md path. */
export function migrateLegacyClaudeManagedStartup(
  homeDir = homedir(),
  dryRun = false,
  beforeCommit?: (path: string) => void,
): LegacyInstructionMigration {
  const instructionPath = join(homeDir, "CLAUDE.md");
  let writePath = instructionPath;
  let symlinkPath: string | undefined;
  let originalText: string;
  let instructionEntryExists = false;

  try {
    const pathInfo = lstatSync(instructionPath);
    instructionEntryExists = true;
    if (pathInfo.isSymbolicLink()) {
      writePath = realpathSync(instructionPath);
      symlinkPath = instructionPath;
      if (!statSync(writePath).isFile()) throw new Error("target is not a regular file");
    }
    originalText = readFileSync(writePath, "utf8");
  } catch (error) {
    if (!instructionEntryExists && isErrno(error, "ENOENT")) {
      return { path: instructionPath, status: "unchanged", removed: 0 };
    }
    throw new Error(`Could not inspect legacy Claude instructions: ${error instanceof Error ? error.message : String(error)}`);
  }

  const startRanges = findExactLineRanges(originalText, CLAUDE_STARTUP_MANAGED_START);
  const endRanges = findExactLineRanges(originalText, CLAUDE_STARTUP_MANAGED_END);
  if (startRanges.length !== endRanges.length || startRanges.length > 1) {
    throw new Error(`Legacy Claude instructions contain ambiguous Prism startup ownership markers: ${instructionPath}`);
  }
  if (startRanges.length === 0) return { path: instructionPath, status: "unchanged", removed: 0 };
  if (endRanges[0].start <= startRanges[0].start) {
    throw new Error(`Legacy Claude instructions contain out-of-order Prism startup ownership markers: ${instructionPath}`);
  }

  const nextText = originalText.slice(0, startRanges[0].start) + originalText.slice(endRanges[0].end);
  if (dryRun) return { path: instructionPath, status: "would-remove", removed: 1 };
  writeTextAtomically(writePath, nextText, originalText, beforeCommit, symlinkPath);
  return { path: instructionPath, status: "removed", removed: 1 };
}

function serializeClaudeStartupBlock(newline: string): string {
  return [
    CLAUDE_STARTUP_MANAGED_START,
    "## Prism session startup",
    "On the first user turn of every conversation, including a greeting, your first action must be to call",
    "`mcp__prism-mcp__session_bootstrap` exactly once with an empty object (`{}`). Emit no preamble. Print the",
    "complete tool result verbatim as the entire first-turn startup display, before any optional answer. Do not",
    "summarize, paraphrase, rename headings, reformat, or omit any returned section. Preserve its order and line",
    "content. For a greeting-only prompt, stop after the verbatim startup display. If `session_bootstrap` is",
    "deferred, use native tool discovery/ToolSearch to load that",
    "exact tool, then invoke it. Do not use shell commands, file reads, subagents, or unrelated tool inspection",
    "as a substitute. Do not call `session_load_context`. If discovery or invocation fails, report",
    "`Prism startup failure` and stop. This block is managed by `prism connect`; do not edit it manually.",
    CLAUDE_STARTUP_MANAGED_END,
    "",
  ].join(newline);
}

/** Install or refresh Claude Code's native, hook-free first-turn instruction. */
export function configureClaudeNativeStartup(
  homeDir = homedir(),
  dryRun = false,
  beforeCommit?: (path: string) => void,
): NativeStartupConfiguration {
  const instructionPath = join(homeDir, ".claude", "CLAUDE.md");
  let writePath = instructionPath;
  let symlinkPath: string | undefined;
  let originalText: string | undefined;
  let instructionEntryExists = false;

  try {
    const pathInfo = lstatSync(instructionPath);
    instructionEntryExists = true;
    if (pathInfo.isSymbolicLink()) {
      writePath = realpathSync(instructionPath);
      symlinkPath = instructionPath;
      if (!statSync(writePath).isFile()) throw new Error("target is not a regular file");
    }
    originalText = readFileSync(writePath, "utf8");
  } catch (error) {
    if (instructionEntryExists || !isErrno(error, "ENOENT")) {
      throw new Error(`Could not inspect Claude instructions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const currentText = originalText ?? "";
  const newline = currentText.includes("\r\n") ? "\r\n" : "\n";
  const startRanges = findExactLineRanges(currentText, CLAUDE_STARTUP_MANAGED_START);
  const endRanges = findExactLineRanges(currentText, CLAUDE_STARTUP_MANAGED_END);
  if (startRanges.length !== endRanges.length || startRanges.length > 1) {
    throw new Error(`Claude instructions contain ambiguous Prism startup ownership markers: ${instructionPath}`);
  }

  const managedBlock = serializeClaudeStartupBlock(newline);
  let nextText: string;
  let action: "install" | "refresh";
  if (startRanges.length === 1) {
    if (endRanges[0].start <= startRanges[0].start) {
      throw new Error(`Claude instructions contain out-of-order Prism startup ownership markers: ${instructionPath}`);
    }
    const managedEnd = endRanges[0].end;
    if (currentText.slice(startRanges[0].start, managedEnd) === managedBlock) {
      return { path: instructionPath, status: "unchanged" };
    }
    nextText = currentText.slice(0, startRanges[0].start) + managedBlock + currentText.slice(managedEnd);
    action = "refresh";
  } else {
    const separator = currentText.length === 0
      ? ""
      : currentText.endsWith("\n") || currentText.endsWith("\r")
        ? newline
        : `${newline}${newline}`;
    nextText = currentText + separator + managedBlock;
    action = "install";
  }

  if (dryRun) {
    return { path: instructionPath, status: action === "install" ? "would-install" : "would-refresh" };
  }
  writeTextAtomically(writePath, nextText, originalText, beforeCommit, symlinkPath);
  return { path: instructionPath, status: action === "install" ? "installed" : "refreshed" };
}

function serializeGeminiStartupBlock(newline: string): string {
  return [
    GEMINI_STARTUP_MANAGED_START,
    "## Prism session startup",
    "On the first user turn of every conversation, including a greeting, your first action must be",
    "`session_bootstrap({})`, exactly once. Emit no preamble. Print the complete tool result verbatim as the",
    "entire first-turn startup display, before any optional answer. Do not summarize, paraphrase, rename headings,",
    "reformat, or omit any returned section. Preserve its order and line content. For a greeting-only prompt, stop",
    "after the verbatim startup display. If `session_bootstrap` is deferred, use native tool discovery/ToolSearch",
    "to load that exact tool, then invoke it.",
    "Do not use shell commands, file reads, subagents, or unrelated tool inspection as a substitute. Do not call",
    "`session_load_context`. If discovery or invocation fails, report `Prism startup failure` and stop. This block",
    "is managed by `prism connect`; do not edit it manually.",
    GEMINI_STARTUP_MANAGED_END,
    "",
  ].join(newline);
}

/** The exact Gemini startup section provisioned before native bootstrap support. */
function legacyGeminiStartupBlock(newline: string): string {
  return [
    "# Startup — MANDATORY",
    "",
    "Your first action in every conversation is loading Prism session context. Zero text before the tool call.",
    "",
    "**Dual-path detection:** Check your available toolset.",
    "- **If `mcp_prism-mcp_session_load_context` exists:** Call it with `project: \"prism-mcp\"`, `level: \"deep\"`.",
    "- **If no MCP tools are available (Antigravity):** Run `bash ~/.gemini/antigravity/scratch/prism_session_loader.sh prism-mcp` via `run_command`. This uses the `prism load` CLI under the hood, sharing the same storage layer (SQLite or Supabase) as the MCP tool.",
    "",
    "After success: echo agent identity, last summary, open TODOs, session version.",
    "If any call fails: say \"Prism load failed — retrying\" and retry ONE more time.",
    "",
    "",
  ].join(newline);
}

/** Install or refresh Gemini CLI's native, hook-free first-turn instruction. */
export function configureGeminiNativeStartup(
  homeDir = homedir(),
  dryRun = false,
  beforeCommit?: (path: string) => void,
): NativeStartupConfiguration {
  const instructionPath = join(homeDir, ".gemini", "GEMINI.md");
  let writePath = instructionPath;
  let symlinkPath: string | undefined;
  let originalText: string | undefined;
  let instructionEntryExists = false;

  try {
    const pathInfo = lstatSync(instructionPath);
    instructionEntryExists = true;
    if (pathInfo.isSymbolicLink()) {
      writePath = realpathSync(instructionPath);
      symlinkPath = instructionPath;
      if (!statSync(writePath).isFile()) throw new Error("target is not a regular file");
    }
    originalText = readFileSync(writePath, "utf8");
  } catch (error) {
    if (instructionEntryExists || !isErrno(error, "ENOENT")) {
      throw new Error(`Could not inspect Gemini instructions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const currentText = originalText ?? "";
  const newline = currentText.includes("\r\n") ? "\r\n" : "\n";
  const startRanges = findExactLineRanges(currentText, GEMINI_STARTUP_MANAGED_START);
  const endRanges = findExactLineRanges(currentText, GEMINI_STARTUP_MANAGED_END);
  if (startRanges.length !== endRanges.length || startRanges.length > 1) {
    throw new Error(`Gemini instructions contain ambiguous Prism startup ownership markers: ${instructionPath}`);
  }

  const managedBlock = serializeGeminiStartupBlock(newline);
  let nextText: string;
  let action: "install" | "refresh";
  if (startRanges.length === 1) {
    if (endRanges[0].start <= startRanges[0].start) {
      throw new Error(`Gemini instructions contain out-of-order Prism startup ownership markers: ${instructionPath}`);
    }
    const managedEnd = endRanges[0].end;
    if (currentText.slice(startRanges[0].start, managedEnd) === managedBlock) {
      return { path: instructionPath, status: "unchanged" };
    }
    nextText = currentText.slice(0, startRanges[0].start) + managedBlock + currentText.slice(managedEnd);
    action = "refresh";
  } else {
    const legacyBlock = legacyGeminiStartupBlock(newline);
    if (currentText.startsWith(legacyBlock)) {
      nextText = managedBlock + newline + currentText.slice(legacyBlock.length);
    } else {
      const separator = currentText.length === 0
        ? ""
        : currentText.endsWith("\n") || currentText.endsWith("\r")
          ? newline
          : `${newline}${newline}`;
      nextText = currentText + separator + managedBlock;
    }
    action = "install";
  }

  if (dryRun) {
    return { path: instructionPath, status: action === "install" ? "would-install" : "would-refresh" };
  }
  writeTextAtomically(writePath, nextText, originalText, beforeCommit, symlinkPath);
  return { path: instructionPath, status: action === "install" ? "installed" : "refreshed" };
}

function getHostDefinitions(
  homeDir: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  includeSystemPaths: boolean,
): HostDefinition[] {
  const claudeDesktop = claudeDesktopPath(homeDir, platform, env);
  const cursorDetectionPaths = [join(homeDir, ".cursor")];
  const desktopDetectionPaths = claudeDesktop ? [dirname(claudeDesktop)] : [];
  const configuredCodexHome = includeSystemPaths && env.CODEX_HOME?.trim()
    ? resolve(env.CODEX_HOME.trim())
    : undefined;
  const codexHome = configuredCodexHome ?? join(homeDir, ".codex");
  const codexDetectionPaths = [codexHome];
  let codexConfigurationError: string | undefined;
  if (configuredCodexHome) {
    try {
      if (!statSync(configuredCodexHome).isDirectory()) {
        codexConfigurationError = `CODEX_HOME must be an existing directory: ${configuredCodexHome}`;
      }
    } catch (error) {
      codexConfigurationError = `CODEX_HOME must be an existing directory: ${configuredCodexHome} (${error instanceof Error ? error.message : String(error)})`;
    }
  }

  if (platform === "darwin") {
    desktopDetectionPaths.push(join(homeDir, "Applications", "Claude.app"));
    cursorDetectionPaths.push(join(homeDir, "Applications", "Cursor.app"));
    codexDetectionPaths.push(join(homeDir, "Applications", "ChatGPT.app"));
    if (includeSystemPaths) {
      desktopDetectionPaths.push("/Applications/Claude.app");
      cursorDetectionPaths.push("/Applications/Cursor.app");
      codexDetectionPaths.push("/Applications/ChatGPT.app");
    }
  } else if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || join(homeDir, "AppData", "Local");
    desktopDetectionPaths.push(
      join(localAppData, "Programs", "Claude", "Claude.exe"),
      join(localAppData, "AnthropicClaude", "Claude.exe"),
    );
    cursorDetectionPaths.push(
      join(localAppData, "Programs", "cursor", "Cursor.exe"),
      join(localAppData, "Cursor", "Cursor.exe"),
    );
    codexDetectionPaths.push(
      join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
      join(localAppData, "Microsoft", "WindowsApps", "ChatGPT.exe"),
    );
  }
  const definitions: HostDefinition[] = [
    {
      name: "claude-code",
      label: "Claude Code",
      format: "json",
      configPath: join(homeDir, ".claude.json"),
      detectionPaths: [join(homeDir, ".claude.json"), join(homeDir, ".claude")],
      executables: ["claude"],
    },
  ];

  if (claudeDesktop) {
    definitions.push({
      name: "claude-desktop",
      label: "Claude Desktop",
      format: "json",
      configPath: claudeDesktop,
      detectionPaths: desktopDetectionPaths,
      executables: ["claude-desktop"],
    });
  }

  definitions.push(
    {
      name: "cursor",
      label: "Cursor",
      format: "json",
      configPath: join(homeDir, ".cursor", "mcp.json"),
      detectionPaths: cursorDetectionPaths,
      executables: ["cursor"],
    },
    {
      name: "gemini",
      label: "Gemini CLI",
      format: "json",
      configPath: join(homeDir, ".gemini", "settings.json"),
      detectionPaths: [join(homeDir, ".gemini")],
      executables: ["gemini"],
    },
    {
      name: "codex",
      label: "Codex",
      format: "codex-toml",
      configPath: join(codexHome, "config.toml"),
      detectionPaths: codexDetectionPaths,
      executables: ["codex"],
      configurationError: codexConfigurationError,
    },
  );
  return definitions;
}

function claudeDesktopPath(
  homeDir: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    const appData = env.APPDATA || join(homeDir, "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  if (platform === "linux") {
    const configHome = env.XDG_CONFIG_HOME || join(homeDir, ".config");
    return join(configHome, "Claude", "claude_desktop_config.json");
  }
  return undefined;
}

function isHostDetected(
  definition: HostDefinition,
  platform: NodeJS.Platform,
  pathEnv: string,
): boolean {
  return definition.configurationError !== undefined
    || definition.detectionPaths.some(existsSync)
    || definition.executables.some((executable) => executableExists(executable, platform, pathEnv));
}

function executableExists(name: string, platform: NodeJS.Platform, pathEnv: string): boolean {
  if (!pathEnv) return false;
  const separator = platform === "win32" ? ";" : ":";
  const extensions = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of pathEnv.split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (platform !== "win32") accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        // Keep searching PATH entries when a candidate is absent or not executable.
      }
    }
  }
  return false;
}

function buildMcpEntry(nodePath: string, serverPath: string, env: NodeJS.ProcessEnv): JsonObject {
  const storage = env.PRISM_STORAGE ?? "auto";
  if (!CONNECT_STORAGE_BACKENDS.includes(storage as (typeof CONNECT_STORAGE_BACKENDS)[number])) {
    throw new Error(
      `Invalid PRISM_STORAGE "${storage}". Choose one of: ${CONNECT_STORAGE_BACKENDS.join(", ")}`,
    );
  }

  const serverEnv: Record<string, string> = {
    PRISM_INSTANCE: "prism-mcp",
    PRISM_SYNALUX_BASE_URL: env.PRISM_SYNALUX_BASE_URL || "https://synalux.ai",
    PRISM_STORAGE: storage,
  };
  if (env.PRISM_SYNALUX_API_KEY) {
    serverEnv.PRISM_SYNALUX_API_KEY = env.PRISM_SYNALUX_API_KEY;
  }

  return {
    command: nodePath,
    args: [serverPath],
    env: serverEnv,
  };
}

function registerHost(
  definition: HostDefinition,
  entry: JsonObject,
  dryRun: boolean,
  refresh: boolean,
  beforeCommit?: (path: string) => void,
): ConnectResult {
  if (definition.configurationError) {
    return result(definition, "error", definition.configurationError);
  }
  if (definition.format === "codex-toml") {
    return registerCodexTomlHost(definition, entry, dryRun, refresh, beforeCommit);
  }
  return registerJsonHost(definition, entry, dryRun, refresh, beforeCommit);
}

function registerJsonHost(
  definition: HostDefinition,
  entry: JsonObject,
  dryRun: boolean,
  refresh: boolean,
  beforeCommit?: (path: string) => void,
): ConnectResult {
  const { configPath } = definition;
  let config: JsonObject = {};
  let originalText: string | undefined;
  let writePath = configPath;
  let symlinkPath: string | undefined;

  try {
    const pathInfo = lstatSync(configPath);
    if (pathInfo.isSymbolicLink()) {
      try {
        writePath = realpathSync(configPath);
        symlinkPath = configPath;
      } catch (error) {
        return result(definition, "error", `config symlink target is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      originalText = readFileSync(writePath, "utf8");
      const parsed: unknown = JSON.parse(originalText);
      if (!isJsonObject(parsed)) {
        throw new Error("top-level JSON value must be an object");
      }
      config = parsed;
    } catch (error) {
      return result(definition, "error", `could not parse config: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      return result(definition, "error", `could not inspect config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const currentServers = config.mcpServers;
  if (currentServers !== undefined && !isJsonObject(currentServers)) {
    return result(definition, "error", '"mcpServers" must be a JSON object');
  }
  const mcpServers = (currentServers ?? {}) as JsonObject;

  const existingKey = Object.prototype.hasOwnProperty.call(mcpServers, "prism-mcp")
    ? "prism-mcp"
    : Object.prototype.hasOwnProperty.call(mcpServers, "prism")
      ? "prism"
      : undefined;

  if (existingKey) {
    const existingEntry = mcpServers[existingKey];
    if (!refresh || existingKey !== "prism-mcp" || !isManagedPrismEntry(existingEntry)) {
      return result(definition, "existing", "Prism is already registered; existing entry left untouched");
    }

    const refreshedEntry = refreshManagedEntry(existingEntry, entry);
    if (JSON.stringify(refreshedEntry) === JSON.stringify(existingEntry)) {
      return result(definition, "existing", "Prism-managed entry is already current");
    }
    if (dryRun) {
      return result(definition, "would-refresh");
    }

    mcpServers[existingKey] = refreshedEntry;
    config.mcpServers = mcpServers;
    try {
      writeTextAtomically(
        writePath,
        `${JSON.stringify(config, null, 2)}\n`,
        originalText,
        beforeCommit,
        symlinkPath,
      );
      return result(definition, "refreshed");
    } catch (error) {
      return result(definition, "error", error instanceof Error ? error.message : String(error));
    }
  }

  if (dryRun) {
    return result(definition, "would-register");
  }

  mcpServers["prism-mcp"] = entry;
  config.mcpServers = mcpServers;

  try {
    writeTextAtomically(
      writePath,
      `${JSON.stringify(config, null, 2)}\n`,
      originalText,
      beforeCommit,
      symlinkPath,
    );
    return result(definition, "registered");
  } catch (error) {
    return result(definition, "error", error instanceof Error ? error.message : String(error));
  }
}

function registerCodexTomlHost(
  definition: HostDefinition,
  entry: JsonObject,
  dryRun: boolean,
  refresh: boolean,
  beforeCommit?: (path: string) => void,
): ConnectResult {
  const { configPath } = definition;
  let config: JsonObject = {};
  let originalText: string | undefined;
  let writePath = configPath;
  let symlinkPath: string | undefined;

  try {
    const pathInfo = lstatSync(configPath);
    if (pathInfo.isSymbolicLink()) {
      try {
        writePath = realpathSync(configPath);
        symlinkPath = configPath;
        if (!statSync(writePath).isFile()) {
          throw new Error("config symlink target is not a regular file");
        }
      } catch (error) {
        return result(definition, "error", `config symlink target is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      originalText = readFileSync(writePath, "utf8");
      const parsed: unknown = parseToml(originalText);
      if (!isJsonObject(parsed)) {
        throw new Error("top-level TOML value must be a table");
      }
      config = parsed;
    } catch (error) {
      return result(definition, "error", `could not parse config: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      return result(definition, "error", `could not inspect config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let managedBlock: { start: number; end: number } | undefined;
  try {
    managedBlock = locateCodexManagedBlock(originalText ?? "");
  } catch (error) {
    return result(definition, "error", error instanceof Error ? error.message : String(error));
  }

  const currentServers = config.mcp_servers;
  if (currentServers !== undefined && !isJsonObject(currentServers)) {
    return result(definition, "error", '"mcp_servers" must be a TOML table');
  }
  const mcpServers = (currentServers ?? {}) as JsonObject;
  const hasCanonical = Object.prototype.hasOwnProperty.call(mcpServers, "prism-mcp");
  const hasLegacy = Object.prototype.hasOwnProperty.call(mcpServers, "prism");

  if (hasCanonical && hasLegacy) {
    return result(definition, "error", "Codex config contains both prism and prism-mcp entries; resolve the duplicate before retrying");
  }

  if (hasCanonical || hasLegacy) {
    const existingKey = hasCanonical ? "prism-mcp" : "prism";
    const existingEntry = mcpServers[existingKey];
    if (!refresh || existingKey !== "prism-mcp") {
      return result(definition, "existing", "Prism is already registered; existing entry left untouched");
    }
    if (!managedBlock) {
      return result(definition, "existing", "Prism is already registered; existing entry left untouched");
    }
    if (!isManagedPrismEntry(existingEntry)) {
      return result(definition, "error", "Prism-managed Codex block has an invalid ownership marker");
    }

    const refreshedEntry = refreshManagedEntry(existingEntry, entry);
    if (isDeepStrictEqual(refreshedEntry, existingEntry)) {
      return result(definition, "existing", "Prism-managed entry is already current");
    }

    let nextText: string;
    try {
      nextText = `${originalText!.slice(0, managedBlock.start)}${serializeCodexManagedBlock(refreshedEntry, originalText!)}${originalText!.slice(managedBlock.end)}`;
      validateCodexCandidate(nextText);
    } catch (error) {
      return result(definition, "error", `could not build valid Codex config: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (dryRun) {
      return result(definition, "would-refresh");
    }

    try {
      writeTextAtomically(writePath, nextText, originalText, beforeCommit, symlinkPath);
      return result(definition, "refreshed");
    } catch (error) {
      return result(definition, "error", error instanceof Error ? error.message : String(error));
    }
  }

  if (managedBlock) {
    return result(definition, "error", "Codex config contains a Prism-managed marker without its MCP entry");
  }

  let nextText: string;
  try {
    const currentText = originalText ?? "";
    const newline = currentText.includes("\r\n") ? "\r\n" : "\n";
    const separator = currentText.length === 0
      ? ""
      : currentText.endsWith("\n") || currentText.endsWith("\r")
        ? newline
        : `${newline}${newline}`;
    nextText = `${currentText}${separator}${serializeCodexManagedBlock(entry, currentText)}`;
    validateCodexCandidate(nextText);
  } catch (error) {
    return result(
      definition,
      "error",
      `could not safely extend Codex config without rewriting existing TOML: ${error instanceof Error ? error.message : String(error)}. Convert an inline mcp_servers value to standard TOML tables, then retry`,
    );
  }
  if (dryRun) {
    return result(definition, "would-register");
  }

  try {
    writeTextAtomically(writePath, nextText, originalText, beforeCommit, symlinkPath);
    return result(definition, "registered");
  } catch (error) {
    return result(definition, "error", error instanceof Error ? error.message : String(error));
  }
}

function serializeCodexManagedBlock(entry: JsonObject, existingText: string): string {
  const newline = existingText.includes("\r\n") ? "\r\n" : "\n";
  const serialized = stringifyToml({ mcp_servers: { "prism-mcp": entry } }).trimEnd();
  return `${CODEX_MANAGED_START}\n${serialized}\n${CODEX_MANAGED_END}\n`.replaceAll("\n", newline);
}

function validateCodexCandidate(text: string): void {
  const parsed: unknown = parseToml(text);
  if (!isJsonObject(parsed) || !isJsonObject(parsed.mcp_servers)) {
    throw new Error("generated mcp_servers table is unavailable");
  }
  const entry = parsed.mcp_servers["prism-mcp"];
  if (!isManagedPrismEntry(entry)) {
    throw new Error("generated prism-mcp entry failed ownership validation");
  }
}

function locateCodexManagedBlock(text: string): { start: number; end: number } | undefined {
  const starts = findExactLineRanges(text, CODEX_MANAGED_START);
  const ends = findExactLineRanges(text, CODEX_MANAGED_END);
  if (starts.length === 0 && ends.length === 0) return undefined;
  if (starts.length !== 1 || ends.length !== 1 || starts[0].start >= ends[0].start) {
    throw new Error("Codex config has malformed or duplicate Prism-managed markers; no changes made");
  }
  return { start: starts[0].start, end: ends[0].end };
}

function findExactLineRanges(text: string, expected: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const lineEnd = newline === -1 ? text.length : newline;
    const contentEnd = lineEnd > start && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    if (text.slice(start, contentEnd) === expected) {
      ranges.push({ start, end: newline === -1 ? text.length : newline + 1 });
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  return ranges;
}

function writeTextAtomically(
  filePath: string,
  contents: string,
  expectedText: string | undefined,
  beforeCommit?: (path: string) => void,
  symlinkPath?: string,
): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const mode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : 0o600;
  const tempPath = join(
    directory,
    `.${basename(filePath)}.prism-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );

  try {
    writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    beforeCommit?.(filePath);

    if (symlinkPath) {
      let currentTarget: string;
      try {
        currentTarget = realpathSync(symlinkPath);
        if (currentTarget !== filePath || !statSync(currentTarget).isFile()) {
          throw new Error("target changed");
        }
      } catch (error) {
        throw new Error(
          `Config symlink changed while Prism was preparing the update; retry: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (expectedText === undefined) {
      if (existsSync(filePath)) {
        throw new Error(`Config changed while Prism was preparing the update; retry: ${filePath}`);
      }
    } else {
      let currentText: string;
      try {
        currentText = readFileSync(filePath, "utf8");
      } catch (error) {
        throw new Error(`Config changed while Prism was preparing the update; retry: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (currentText !== expectedText) {
        throw new Error(`Config changed while Prism was preparing the update; retry: ${filePath}`);
      }
    }
    // This compare-before-rename catches observable host edits and the rename
    // itself is atomic. No portable filesystem API can make the comparison and
    // replacement one operation against an uncooperative host, which is why the
    // CLI also tells users to close target hosts before writing.
    renameSync(tempPath, filePath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

function result(
  definition: HostDefinition,
  status: ConnectStatus,
  message?: string,
): ConnectResult {
  return {
    host: definition.name,
    label: definition.label,
    path: definition.configPath,
    status,
    message,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManagedPrismEntry(value: unknown): value is JsonObject {
  return isJsonObject(value)
    && isJsonObject(value.env)
    && value.env.PRISM_INSTANCE === "prism-mcp";
}

function refreshManagedEntry(existing: JsonObject, desired: JsonObject): JsonObject {
  const existingEnv = isJsonObject(existing.env) ? existing.env : {};
  const desiredEnv = isJsonObject(desired.env) ? desired.env : {};
  const mergedEnv: JsonObject = {
    ...existingEnv,
    ...desiredEnv,
  };
  if (!Object.prototype.hasOwnProperty.call(desiredEnv, "PRISM_SYNALUX_API_KEY")) {
    delete mergedEnv.PRISM_SYNALUX_API_KEY;
  }
  return {
    ...existing,
    command: desired.command,
    args: desired.args,
    env: mergedEnv,
  };
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
