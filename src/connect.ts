import {
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

export const CONNECT_HOSTS = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "gemini",
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
  configPath: string;
  detectionPaths: string[];
  executables: string[];
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
};

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

  if (platform === "darwin") {
    desktopDetectionPaths.push(join(homeDir, "Applications", "Claude.app"));
    cursorDetectionPaths.push(join(homeDir, "Applications", "Cursor.app"));
    if (includeSystemPaths) {
      desktopDetectionPaths.push("/Applications/Claude.app");
      cursorDetectionPaths.push("/Applications/Cursor.app");
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
  }
  const definitions: HostDefinition[] = [
    {
      name: "claude-code",
      label: "Claude Code",
      configPath: join(homeDir, ".claude.json"),
      detectionPaths: [join(homeDir, ".claude.json"), join(homeDir, ".claude")],
      executables: ["claude"],
    },
  ];

  if (claudeDesktop) {
    definitions.push({
      name: "claude-desktop",
      label: "Claude Desktop",
      configPath: claudeDesktop,
      detectionPaths: desktopDetectionPaths,
      executables: ["claude-desktop"],
    });
  }

  definitions.push(
    {
      name: "cursor",
      label: "Cursor",
      configPath: join(homeDir, ".cursor", "mcp.json"),
      detectionPaths: cursorDetectionPaths,
      executables: ["cursor"],
    },
    {
      name: "gemini",
      label: "Gemini CLI",
      configPath: join(homeDir, ".gemini", "settings.json"),
      detectionPaths: [join(homeDir, ".gemini")],
      executables: ["gemini"],
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
  return definition.detectionPaths.some(existsSync)
    || definition.executables.some((executable) => executableExists(executable, platform, pathEnv));
}

function executableExists(name: string, platform: NodeJS.Platform, pathEnv: string): boolean {
  if (!pathEnv) return false;
  const separator = platform === "win32" ? ";" : ":";
  const extensions = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of pathEnv.split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      if (existsSync(join(directory, `${name}${extension}`))) return true;
    }
  }
  return false;
}

function buildMcpEntry(nodePath: string, serverPath: string, env: NodeJS.ProcessEnv): JsonObject {
  const serverEnv: Record<string, string> = {
    PRISM_INSTANCE: "prism-mcp",
    PRISM_SYNALUX_BASE_URL: env.PRISM_SYNALUX_BASE_URL || "https://synalux.ai",
    PRISM_STORAGE: "auto",
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
  const { configPath } = definition;
  let config: JsonObject = {};
  let originalText: string | undefined;
  let writePath = configPath;

  try {
    const pathInfo = lstatSync(configPath);
    if (pathInfo.isSymbolicLink()) {
      try {
        writePath = realpathSync(configPath);
      } catch (error) {
        return result(definition, "error", `config symlink target is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      originalText = readFileSync(configPath, "utf8");
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
      writeJsonAtomically(writePath, config, originalText, beforeCommit);
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
    writeJsonAtomically(writePath, config, originalText, beforeCommit);
    return result(definition, "registered");
  } catch (error) {
    return result(definition, "error", error instanceof Error ? error.message : String(error));
  }
}

function writeJsonAtomically(
  filePath: string,
  value: JsonObject,
  expectedText: string | undefined,
  beforeCommit?: (path: string) => void,
): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const mode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : 0o600;
  const tempPath = join(
    directory,
    `.${basename(filePath)}.prism-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );

  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    beforeCommit?.(filePath);

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
