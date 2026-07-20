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
