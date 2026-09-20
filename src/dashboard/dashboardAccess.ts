import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  createDashboardProbeRequest,
  DASHBOARD_PROBE_PATH,
  generateDashboardProbeKey,
  validateDashboardProbeKey,
  verifyDashboardProbeResponse,
} from "./dashboardProbe.js";

const DASHBOARD_URL_FILE = "dashboard.url";
const DASHBOARD_REGISTRY_DIRECTORY = "dashboard-instances";
const MAX_DASHBOARD_URL_BYTES = 4096;
const DASHBOARD_INSTANCE_ID = /^[a-f0-9]{32}$/;

export interface DashboardAccessState {
  url: string;
  probeKey: string;
}

interface DashboardAccessRecord extends DashboardAccessState {
  instanceId: string;
  pid: number;
  registeredAtMs: number;
  recordPath: string;
}

export interface DashboardAccessRegistration {
  recordPath: string;
  state: DashboardAccessState;
  unregister: () => void;
}

export interface DashboardAccessRegistrationOptions {
  instanceId?: string;
  pid?: number;
  registeredAtMs?: number;
}

export function dashboardAccessUrlPath(home = homedir()): string {
  return join(home, ".prism-mcp", DASHBOARD_URL_FILE);
}

export function dashboardAccessRegistryPath(home = homedir()): string {
  return join(home, ".prism-mcp", DASHBOARD_REGISTRY_DIRECTORY);
}

function dashboardAccessDirectory(home: string): string {
  const directory = join(home, ".prism-mcp");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Local dashboard directory is not a regular directory");
  }
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  return directory;
}

function dashboardRegistryDirectory(home: string): string {
  dashboardAccessDirectory(home);
  const directory = dashboardAccessRegistryPath(home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Local dashboard registry is not a regular directory");
  }
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  return directory;
}

function validateDashboardUrl(raw: string): string {
  const value = raw.trim();
  if (!value || Buffer.byteLength(value, "utf8") > MAX_DASHBOARD_URL_BYTES) {
    throw new Error("Local dashboard link is missing or invalid");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Local dashboard link is invalid");
  }

  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const queryKeys = [...parsed.searchParams.keys()];
  if (
    parsed.protocol !== "http:" ||
    !loopbackHosts.has(parsed.hostname) ||
    !/^\d{1,5}$/.test(parsed.port) ||
    Number(parsed.port) < 1 ||
    Number(parsed.port) > 65535 ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.hash ||
    queryKeys.some((key) => key !== "token") ||
    (parsed.searchParams.has("token") && !parsed.searchParams.get("token"))
  ) {
    throw new Error("Local dashboard link is invalid");
  }

  return parsed.toString();
}

function writeOwnerOnlyJson(
  filePath: string,
  directory: string,
  value: Record<string, unknown>,
  label: string,
): string {
  try {
    const existing = lstatSync(filePath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`${label} path is not a regular file`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  // Write a new regular file and atomically replace the directory entry. This
  // never opens an existing target for writing, so a pre-existing target
  // symlink cannot redirect the token write even on platforms without
  // O_NOFOLLOW. The containing directory follows the same-OS-user trust model
  // documented above.
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const fd = openSync(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  let tempExists = true;
  try {
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tempPath, filePath);
    tempExists = false;
    if (process.platform !== "win32") chmodSync(filePath, 0o600);
  } finally {
    if (tempExists) {
      try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    }
  }
  return filePath;
}

function readOwnerOnlyJson(
  filePath: string,
  label: string,
  missingMessage?: string,
): unknown {
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && missingMessage) throw new Error(missingMessage);
    if (code === "ELOOP") throw new Error(`${label} path is not a regular file`);
    throw error;
  }
  try {
    // Validate and read the same opened object. A path-level lstat followed by
    // readFileSync(path) permits the directory entry to be swapped between the
    // check and use; O_NOFOLLOW plus fstat/read on this descriptor closes that
    // race on POSIX without broadening the same-OS-user trust boundary.
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} path is not a regular file`);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error(`${label} file permissions are unsafe`);
    }
    const raw = readFileSync(fd, "utf8");
    if (!raw || Buffer.byteLength(raw, "utf8") > MAX_DASHBOARD_URL_BYTES) {
      throw new Error(`${label} is missing or invalid`);
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`${label} is invalid`);
    }
  } finally {
    closeSync(fd);
  }
}

function parseDashboardAccessState(parsed: unknown, label: string): DashboardAccessState {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} is invalid`);
  }
  const state = parsed as { version?: unknown; url?: unknown; probe_key?: unknown };
  if (state.version !== 1 || typeof state.url !== "string" || typeof state.probe_key !== "string") {
    throw new Error(`${label} is invalid`);
  }
  return {
    url: validateDashboardUrl(state.url),
    probeKey: validateDashboardProbeKey(state.probe_key),
  };
}

/**
 * Persist the latest local dashboard link for older Prism clients. Current
 * clients discover live dashboards from the per-instance registry below.
 * The token is a localhost capability, so the file is owner-only and symlinks
 * present at validation time are rejected rather than followed. This is not a
 * boundary against another process running as the same OS user: that process
 * can already read or replace owner-only Prism state.
 */
export function writeDashboardAccessUrl(
  url: string,
  home = homedir(),
  probeKey = generateDashboardProbeKey(),
): string {
  const validated = validateDashboardUrl(url);
  const validatedProbeKey = validateDashboardProbeKey(probeKey);
  const directory = dashboardAccessDirectory(home);
  return writeOwnerOnlyJson(
    dashboardAccessUrlPath(home),
    directory,
    { version: 1, url: validated, probe_key: validatedProbeKey },
    "Local dashboard link",
  );
}

export function readDashboardAccessState(home = homedir()): DashboardAccessState {
  dashboardAccessDirectory(home);
  return parseDashboardAccessState(
    readOwnerOnlyJson(
      dashboardAccessUrlPath(home),
      "Local dashboard link",
      "No current local dashboard link. Restart your connected MCP host first.",
    ),
    "Local dashboard link",
  );
}

export function readDashboardAccessUrl(home = homedir()): string {
  return readDashboardAccessState(home).url;
}

function validateDashboardInstanceId(value: string): string {
  if (!DASHBOARD_INSTANCE_ID.test(value)) {
    throw new Error("Local dashboard instance ID is invalid");
  }
  return value;
}

function validateRegistrationInteger(value: number, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1)) {
    throw new Error(`Local dashboard ${label} is invalid`);
  }
  return value;
}

function parseDashboardAccessRecord(
  parsed: unknown,
  recordPath: string,
  expectedInstanceId: string,
): DashboardAccessRecord {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Local dashboard registry record is invalid");
  }
  const record = parsed as {
    version?: unknown;
    instance_id?: unknown;
    pid?: unknown;
    registered_at_ms?: unknown;
    url?: unknown;
    probe_key?: unknown;
  };
  if (
    record.version !== 1 ||
    typeof record.instance_id !== "string" ||
    typeof record.pid !== "number" ||
    typeof record.registered_at_ms !== "number" ||
    typeof record.url !== "string" ||
    typeof record.probe_key !== "string"
  ) {
    throw new Error("Local dashboard registry record is invalid");
  }
  const instanceId = validateDashboardInstanceId(record.instance_id);
  if (instanceId !== expectedInstanceId) {
    throw new Error("Local dashboard registry record is invalid");
  }
  return {
    instanceId,
    pid: validateRegistrationInteger(record.pid, "process ID"),
    registeredAtMs: validateRegistrationInteger(record.registered_at_ms, "registration time", true),
    url: validateDashboardUrl(record.url),
    probeKey: validateDashboardProbeKey(record.probe_key),
    recordPath,
  };
}

function readDashboardAccessRecord(recordPath: string, instanceId: string): DashboardAccessRecord {
  return parseDashboardAccessRecord(
    readOwnerOnlyJson(recordPath, "Local dashboard registry record"),
    recordPath,
    instanceId,
  );
}

function unregisterDashboardAccessRecord(record: DashboardAccessRecord): void {
  let current: DashboardAccessRecord;
  try {
    current = readDashboardAccessRecord(record.recordPath, record.instanceId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    return;
  }
  if (
    current.pid !== record.pid ||
    current.registeredAtMs !== record.registeredAtMs ||
    current.url !== record.url ||
    current.probeKey !== record.probeKey
  ) {
    return;
  }
  try {
    unlinkSync(record.recordPath);
  } catch {
    // Best effort: an unreadable registry must not block another live instance.
  }
}

function isDashboardProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves the process exists but is owned by a different principal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Register one running dashboard without replacing records for other hosts. */
export function registerDashboardAccessUrl(
  url: string,
  home = homedir(),
  probeKey = generateDashboardProbeKey(),
  options: DashboardAccessRegistrationOptions = {},
): DashboardAccessRegistration {
  const validatedUrl = validateDashboardUrl(url);
  const validatedProbeKey = validateDashboardProbeKey(probeKey);
  const instanceId = validateDashboardInstanceId(options.instanceId ?? randomBytes(16).toString("hex"));
  const pid = validateRegistrationInteger(options.pid ?? process.pid, "process ID");
  const registeredAtMs = validateRegistrationInteger(
    options.registeredAtMs ?? Date.now(),
    "registration time",
    true,
  );

  // Preserve the singleton file for clients released before the registry.
  writeDashboardAccessUrl(validatedUrl, home, validatedProbeKey);

  const directory = dashboardRegistryDirectory(home);
  const recordPath = join(directory, `${instanceId}.json`);
  const record: DashboardAccessRecord = {
    instanceId,
    pid,
    registeredAtMs,
    url: validatedUrl,
    probeKey: validatedProbeKey,
    recordPath,
  };
  writeOwnerOnlyJson(
    recordPath,
    directory,
    {
      version: 1,
      instance_id: instanceId,
      pid,
      registered_at_ms: registeredAtMs,
      url: validatedUrl,
      probe_key: validatedProbeKey,
    },
    "Local dashboard registry record",
  );

  return {
    recordPath,
    state: { url: validatedUrl, probeKey: validatedProbeKey },
    unregister: () => unregisterDashboardAccessRecord(record),
  };
}

function readDashboardAccessRecords(home: string): DashboardAccessRecord[] {
  const directory = dashboardRegistryDirectory(home);
  const records: DashboardAccessRecord[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = /^([a-f0-9]{32})\.json$/.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) continue;
    try {
      records.push(readDashboardAccessRecord(join(directory, entry.name), match[1]));
    } catch {
      // A malformed or unsafe record can never become a dashboard capability.
    }
  }
  return records.sort((left, right) =>
    right.registeredAtMs - left.registeredAtMs || right.instanceId.localeCompare(left.instanceId),
  );
}

/**
 * Return the newest cryptographically verified dashboard that is still alive.
 * Dead registry entries are removed one at a time; a surviving instance is
 * never deleted just because a newer process stopped.
 */
export async function findRunningDashboardAccessState(
  home = homedir(),
  fetcher: typeof fetch = fetch,
): Promise<DashboardAccessState> {
  const records = readDashboardAccessRecords(home);
  const probed = new Set<string>();
  for (const record of records) {
    const key = `${record.url}\n${record.probeKey}`;
    probed.add(key);
    if (await isLocalDashboardRunning(record.url, record.probeKey, fetcher)) {
      return { url: record.url, probeKey: record.probeKey };
    }
    // One timeout is not proof that a live host is dead. Remove the record only
    // when the owning PID is also gone; otherwise preserve it for a later retry.
    if (!isDashboardProcessAlive(record.pid)) unregisterDashboardAccessRecord(record);
  }

  // A singleton-only record was written by Prism versions before this registry.
  try {
    const legacy = readDashboardAccessState(home);
    const key = `${legacy.url}\n${legacy.probeKey}`;
    if (!probed.has(key) && await isLocalDashboardRunning(legacy.url, legacy.probeKey, fetcher)) {
      return legacy;
    }
  } catch (error) {
    if (records.length === 0) throw error;
  }

  throw new Error("No registered Prism dashboard is running. Restart your connected MCP host first.");
}

export async function isLocalDashboardRunning(
  dashboardUrl: string,
  probeKey: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const validated = validateDashboardUrl(dashboardUrl);
  const challenge = createDashboardProbeRequest(probeKey);
  const probe = new URL(DASHBOARD_PROBE_PATH, validated);
  probe.searchParams.set("nonce", challenge.nonce);
  probe.searchParams.set("proof", challenge.proof);
  try {
    const response = await fetcher(probe, {
      redirect: "error",
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const finalUrl = response.url ? new URL(response.url) : probe;
    if (finalUrl.href !== probe.href) {
      return false;
    }
    const body = await response.json() as { name?: string; nonce?: string; proof?: string };
    return body.name === "Prism Mind Palace" &&
      body.nonce === challenge.nonce &&
      typeof body.proof === "string" &&
      verifyDashboardProbeResponse(probeKey, challenge.nonce, body.proof);
  } catch {
    return false;
  }
}

export interface DashboardOpenCommand {
  command: string;
  args: string[];
}

export function dashboardOpenSuccessMessage(): string {
  return "Opened the current local Prism dashboard in your default browser. Your Synalux account and plan are unchanged.";
}

export function dashboardOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): DashboardOpenCommand {
  const validated = validateDashboardUrl(url);
  if (platform === "darwin") return { command: "open", args: [validated] };
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", validated] };
  }
  return { command: "xdg-open", args: [validated] };
}

type DashboardOpenRunner = (
  command: string,
  args: readonly string[],
) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;

export function openDashboardUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
  runner: DashboardOpenRunner = (command, args) => spawnSync(command, args, {
    shell: false,
    stdio: "ignore",
    timeout: 5_000,
    windowsHide: true,
  }),
): void {
  const launch = dashboardOpenCommand(url, platform);
  const result = runner(launch.command, launch.args);
  if (result.error || result.status !== 0) {
    throw new Error("Could not open the local dashboard browser");
  }
}
