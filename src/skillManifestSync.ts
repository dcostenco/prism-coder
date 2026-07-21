import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  applyManagedSkillManifest, getSetting, refreshConfigStorageCache,
} from "./storage/configStorage.js";
import { REQUIRED_NATIVE_SKILL_NAMES } from "./tools/skillRouting.js";
import { getSynaluxJwt, invalidateSynaluxJwt } from "./utils/synaluxJwt.js";

const OWNER = "prism-skill-sync-v1";
const MARKER = ".prism-managed.json";
const INDEX = ".prism-managed-skills.json";
const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const TIERS = new Set(["free", "standard", "advanced", "enterprise"]);
const CATEGORIES = new Set(["universal", "project", "prompt", "native"]);
const MAX_SKILLS = 500;
const MAX_FILES_PER_SKILL = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 50;
const TRANSACTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SIBLING_SKILL_LINK = /\.\.\/([a-z0-9][a-z0-9_-]{0,127})\/SKILL\.md/g;

export interface ManifestFile {
  content: string;
  digest: string;
  encoding: "utf8" | "base64";
}

export interface ManifestSkill {
  name: string;
  content: string;
  digest: string;
  version: number;
  source: "database" | "filesystem";
  metadata: {
    protected: boolean;
    priority: number;
    categories: Array<"universal" | "project" | "prompt" | "native">;
    minimum_plan?: "free" | "standard" | "advanced" | "enterprise";
  };
  files: Record<string, ManifestFile>;
}

export interface SkillManifest {
  schema_version: 1;
  generation_algorithm: "sha256-json-v1";
  complete: true;
  generation: string;
  tier: "free" | "standard" | "advanced" | "enterprise";
  routing_version: number;
  skills: ManifestSkill[];
}

export interface SkillSyncResult {
  status: "applied" | "unchanged" | "partial" | "disabled" | "failed";
  tier?: string;
  generation?: string;
  /** Names from the latest portal-validated manifest, even if DB apply failed. */
  entitledNames?: string[];
  installed: string[];
  updated: string[];
  pruned: string[];
  conflicts: string[];
  error?: string;
}

interface NativeIndex {
  owner: typeof OWNER;
  generation: string;
  skills: string[];
}

interface NativeMarker {
  owner: typeof OWNER;
  generation: string;
  files: Record<string, string>;
}

interface SyncLockRecord {
  owner: typeof OWNER;
  pid: number;
  started_at: string;
  token: string;
}

export interface SkillSyncOptions {
  baseUrl?: string;
  /** Override the user home for hermetic host-discovery tests. */
  homeDir?: string;
  agentsSkillsDir?: string;
  /**
   * Claude Code's native skill root. `false` disables the mirror. When omitted,
   * Prism auto-detects Claude Code only while using the production default
   * ~/.agents/skills root, so tests and callers with custom roots stay isolated.
   */
  claudeCodeSkillsDir?: string | false;
  /**
   * Cursor's native user skill root. `false` disables the mirror. When omitted,
   * Prism auto-detects Cursor only while using the production default
   * ~/.agents/skills root, so tests and callers with custom roots stay isolated.
   */
  cursorSkillsDir?: string | false;
  fetchImpl?: typeof fetch;
  getJwt?: () => Promise<string | null>;
  invalidateJwt?: () => void;
  applyManifest?: typeof applyManagedSkillManifest;
  configuredCredential?: boolean;
  /** Test seam for bounded lock contention. */
  lockWaitMs?: number;
  /** Test seam for verifying rollback after native mutations, before index commit. */
  beforeNativeCommit?: () => Promise<void>;
  /** Test seams for fail-closed downgrade phase coverage. */
  afterNativePrune?: (name: string) => Promise<void>;
  beforeNativeStage?: () => Promise<void>;
  beforeNativeCleanup?: () => Promise<void>;
}

let inFlight: Promise<SkillSyncResult> | null = null;
let lastResult: SkillSyncResult | null = null;
let lastFinishedAt = 0;
const SUCCESS_TTL_MS = 5 * 60 * 1000;

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function computeSkillManifestGeneration(
  manifest: Pick<SkillManifest, "tier" | "routing_version" | "skills">,
): string {
  const canonical = {
    schema_version: 1,
    tier: manifest.tier,
    routing_version: manifest.routing_version,
    skills: manifest.skills.map((skill) => ({
      name: skill.name,
      digest: skill.digest,
      version: skill.version,
      source: skill.source,
      metadata: skill.metadata,
      files: Object.entries(skill.files).map(([path, file]) => ({
        path, digest: file.digest, encoding: file.encoding,
      })),
    })),
  };
  return sha256(JSON.stringify(canonical));
}

function decodeFile(file: ManifestFile): Buffer {
  if (file.encoding === "utf8") return Buffer.from(file.content, "utf8");
  const compact = file.content.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new Error("invalid base64 content");
  }
  return Buffer.from(compact, "base64");
}

function validateRelativePath(path: string): void {
  if (!path || path.length > 240 || path.includes("\\") || /[\u0000-\u001f<>:"|?*]/.test(path) || isAbsolute(path)) {
    throw new Error(`unsafe skill file path: ${path}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
      path === MARKER || path.startsWith(".prism-")) {
    throw new Error(`unsafe skill file path: ${path}`);
  }
}

export function validateSkillManifest(payload: unknown): SkillManifest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("manifest must be an object");
  const value = payload as Record<string, unknown>;
  if (value.schema_version !== 1) throw new Error("unsupported skill manifest schema_version");
  if (value.generation_algorithm !== "sha256-json-v1") throw new Error("unsupported skill manifest generation algorithm");
  if (value.complete !== true) throw new Error("skill manifest is not complete");
  if (typeof value.generation !== "string" || !SHA256.test(value.generation)) throw new Error("invalid manifest generation");
  if (typeof value.tier !== "string" || !TIERS.has(value.tier)) throw new Error("unknown manifest tier");
  if (!Number.isInteger(value.routing_version) || (value.routing_version as number) < 0) throw new Error("invalid routing_version");
  if (!Array.isArray(value.skills) || value.skills.length === 0 || value.skills.length > MAX_SKILLS) {
    throw new Error("manifest must contain a bounded, non-empty skill list");
  }

  const names = new Set<string>();
  let totalBytes = 0;
  const skills: ManifestSkill[] = value.skills.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`invalid skill at index ${index}`);
    const skill = raw as Record<string, unknown>;
    if (typeof skill.name !== "string" || !SAFE_NAME.test(skill.name)) throw new Error(`invalid skill name at index ${index}`);
    const folded = skill.name.toLocaleLowerCase("en-US");
    if (names.has(folded)) throw new Error(`duplicate skill name: ${skill.name}`);
    names.add(folded);
    if (typeof skill.content !== "string" || !skill.content.trim()) throw new Error(`empty skill content: ${skill.name}`);
    if (typeof skill.digest !== "string" || !SHA256.test(skill.digest)) throw new Error(`invalid skill digest: ${skill.name}`);
    if (!Number.isInteger(skill.version) || (skill.version as number) < 0) throw new Error(`invalid skill version: ${skill.name}`);
    if (skill.source !== "database" && skill.source !== "filesystem") throw new Error(`invalid skill source: ${skill.name}`);
    const metadata = skill.metadata as Record<string, unknown> | undefined;
    if (!metadata || typeof metadata.protected !== "boolean" || !Number.isInteger(metadata.priority) ||
        !Array.isArray(metadata.categories) || metadata.categories.some((category) => typeof category !== "string" || !CATEGORIES.has(category))) {
      throw new Error(`invalid skill metadata: ${skill.name}`);
    }
    if (metadata.minimum_plan !== undefined && (typeof metadata.minimum_plan !== "string" || !TIERS.has(metadata.minimum_plan))) {
      throw new Error(`invalid skill minimum_plan: ${skill.name}`);
    }
    if (metadata.categories.includes("native") &&
        (metadata.minimum_plan === undefined || metadata.minimum_plan === "free")) {
      throw new Error(`native skill requires a paid minimum_plan: ${skill.name}`);
    }
    if (!skill.files || typeof skill.files !== "object" || Array.isArray(skill.files)) throw new Error(`missing skill files: ${skill.name}`);
    const fileEntries = Object.entries(skill.files as Record<string, unknown>);
    if (fileEntries.length === 0 || fileEntries.length > MAX_FILES_PER_SKILL) throw new Error(`invalid file count: ${skill.name}`);
    const files: Record<string, ManifestFile> = Object.create(null);
    const foldedPaths = new Set<string>();
    for (const [path, rawFile] of fileEntries) {
      validateRelativePath(path);
      const foldedPath = path.toLocaleLowerCase("en-US");
      if (foldedPaths.has(foldedPath)) throw new Error(`duplicate skill file path: ${skill.name}/${path}`);
      foldedPaths.add(foldedPath);
      if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) throw new Error(`invalid file: ${skill.name}/${path}`);
      const file = rawFile as Record<string, unknown>;
      if ((file.encoding !== "utf8" && file.encoding !== "base64") || typeof file.content !== "string" ||
          typeof file.digest !== "string" || !SHA256.test(file.digest)) throw new Error(`invalid file metadata: ${skill.name}/${path}`);
      const normalized = { content: file.content, digest: file.digest.toLowerCase(), encoding: file.encoding } as ManifestFile;
      const bytes = decodeFile(normalized);
      if (bytes.length > MAX_FILE_BYTES || sha256(bytes) !== normalized.digest) throw new Error(`file digest/size mismatch: ${skill.name}/${path}`);
      totalBytes += bytes.length;
      files[path] = normalized;
    }
    const sortedPaths = fileEntries.map(([path]) => path).sort();
    if (fileEntries.some(([path], fileIndex) => path !== sortedPaths[fileIndex])) throw new Error(`skill files are not canonically ordered: ${skill.name}`);
    const entry = files["SKILL.md"];
    if (!entry || entry.encoding !== "utf8" || entry.content !== skill.content || entry.digest !== skill.digest.toLowerCase()) {
      throw new Error(`SKILL.md compatibility fields mismatch: ${skill.name}`);
    }
    return {
      name: skill.name,
      content: skill.content,
      digest: skill.digest.toLowerCase(),
      version: skill.version as number,
      source: skill.source,
      metadata: {
        protected: metadata.protected as boolean,
        priority: metadata.priority as number,
        categories: metadata.categories as ManifestSkill["metadata"]["categories"],
        ...(metadata.minimum_plan === undefined
          ? {}
          : { minimum_plan: metadata.minimum_plan as ManifestSkill["metadata"]["minimum_plan"] }),
      },
      files,
    };
  });
  if (totalBytes > MAX_MANIFEST_BYTES) throw new Error("skill manifest exceeds size limit");
  for (const skill of skills) {
    for (const match of skill.content.matchAll(SIBLING_SKILL_LINK)) {
      const dependency = match[1].toLocaleLowerCase("en-US");
      if (!names.has(dependency)) {
        throw new Error(`unresolved skill dependency: ${skill.name} -> ${match[1]}`);
      }
    }
  }
  const requiredNames = new Set<string>(REQUIRED_NATIVE_SKILL_NAMES);
  for (const required of REQUIRED_NATIVE_SKILL_NAMES) {
    const requiredSkill = skills.find((skill) => skill.name === required);
    if (!requiredSkill) throw new Error(`manifest is missing required protected skill: ${required}`);
    if (!requiredSkill.metadata.protected || !requiredSkill.metadata.categories.includes("universal")) {
      throw new Error(`required skill is not protected universal: ${required}`);
    }
  }
  if (value.tier === "free" && (skills.length !== requiredNames.size || skills.some((skill) => !requiredNames.has(skill.name)))) {
    throw new Error("free manifest must contain exactly the protected skill floor");
  }
  const normalized: SkillManifest = {
    schema_version: 1,
    generation_algorithm: "sha256-json-v1",
    complete: true,
    generation: (value.generation as string).toLowerCase(),
    tier: value.tier as SkillManifest["tier"],
    routing_version: value.routing_version as number,
    skills,
  };
  const orderedSkills = [...skills].sort((a, b) => a.metadata.priority - b.metadata.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (skills.some((skill, index) => skill !== orderedSkills[index])) throw new Error("skills are not canonically ordered");
  if (computeSkillManifestGeneration(normalized) !== normalized.generation) throw new Error("manifest generation digest mismatch");
  return normalized;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, fsConstants.F_OK); return true; } catch { return false; }
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`managed skill contains symlink: ${relative(root, path)}`);
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile() && entry.name !== MARKER) files.push(relative(root, path).split(sep).join("/"));
    else if (!entry.isFile()) throw new Error(`managed skill contains unsupported entry: ${relative(root, path)}`);
  }
  return files.sort();
}

async function isPristineMarkedSkill(path: string, generation?: string): Promise<boolean> {
  const marker = await readJson<NativeMarker>(join(path, MARKER));
  if (!marker || marker.owner !== OWNER || (generation && marker.generation !== generation) ||
      !marker.files || typeof marker.files !== "object") return false;
  try {
    const actualFiles = await listFiles(path);
    const expectedFiles = Object.keys(marker.files).sort();
    if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, i) => file !== expectedFiles[i])) return false;
    for (const file of actualFiles) {
      if (!SHA256.test(marker.files[file]) || sha256(await readFile(join(path, file))) !== marker.files[file]) return false;
    }
    return true;
  } catch { return false; }
}

async function isPristineManagedSkill(path: string, indexed: boolean): Promise<boolean> {
  return indexed && isPristineMarkedSkill(path);
}

async function matchesIncomingSkill(path: string, skill: ManifestSkill): Promise<boolean> {
  const marker = await readJson<NativeMarker>(join(path, MARKER));
  if (!marker || marker.owner !== OWNER) return false;
  const incoming = Object.fromEntries(Object.entries(skill.files).map(([file, value]) => [file, value.digest]));
  const actual = Object.keys(marker.files).sort();
  const expected = Object.keys(incoming).sort();
  return actual.length === expected.length && actual.every((file, i) => file === expected[i] && marker.files[file] === incoming[file]);
}

async function stageSkill(root: string, skill: ManifestSkill, generation: string): Promise<string> {
  const target = join(root, skill.name);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const digests: Record<string, string> = Object.create(null);
  for (const [file, encoded] of Object.entries(skill.files)) {
    const path = resolve(target, file);
    if (!path.startsWith(`${target}${sep}`)) throw new Error(`unsafe resolved path: ${file}`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, decodeFile(encoded), { mode: 0o600 });
    digests[file] = encoded.digest;
  }
  const marker: NativeMarker = { owner: OWNER, generation, files: digests };
  await writeFile(join(target, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return target;
}

type NativeOperation =
  | { type: "install"; name: string; target: string }
  | { type: "update"; name: string; target: string; backup: string }
  | { type: "prune"; name: string; target: string; backup: string };

async function ensureRealDirectory(path: string): Promise<void> {
  if (!(await exists(path))) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`managed path must be a real directory: ${path}`);
}

async function removeExpiredTransactions(base: string): Promise<void> {
  const cutoff = Date.now() - TRANSACTION_RETENTION_MS;
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.name.startsWith("txn-") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(base, entry.name);
    const stat = await lstat(path);
    if (stat.mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
  }
}

async function quarantineLegacyDiscoveryArtifacts(agentsSkillsDir: string): Promise<void> {
  const legacy = (await readdir(agentsSkillsDir, { withFileTypes: true })).filter(
    (entry) => entry.name.startsWith(".prism-") && entry.isDirectory() && !entry.isSymbolicLink(),
  );
  if (legacy.length === 0) return;
  const quarantineBase = join(dirname(agentsSkillsDir), ".prism-skill-quarantine");
  await ensureRealDirectory(quarantineBase);
  for (const entry of legacy) {
    await rename(
      join(agentsSkillsDir, entry.name),
      join(quarantineBase, `legacy-${entry.name.slice(1)}-${Date.now()}-${randomUUID()}`),
    );
  }
}

async function quarantineManagedSkill(target: string, name: string, agentsSkillsDir: string): Promise<string> {
  const quarantineBase = join(dirname(agentsSkillsDir), ".prism-skill-quarantine");
  await ensureRealDirectory(quarantineBase);
  const quarantined = join(quarantineBase, `${name}-${Date.now()}-${randomUUID()}`);
  await rename(target, quarantined);
  return quarantined;
}

async function rollbackNativeOperations(operations: NativeOperation[], backupRoot: string): Promise<string[]> {
  const errors: string[] = [];
  await ensureRealDirectory(dirname(backupRoot));
  await ensureRealDirectory(backupRoot);
  for (const operation of [...operations].reverse()) {
    try {
      if (operation.type === "install") {
        if (await exists(operation.target)) {
          await rename(operation.target, join(backupRoot, `${operation.name}.rolled-back-new-${randomUUID()}`));
        }
      } else if (operation.type === "update") {
        if (await exists(operation.target)) {
          await rename(operation.target, join(backupRoot, `${operation.name}.failed-update-${randomUUID()}`));
        }
        if (await exists(operation.backup)) await rename(operation.backup, operation.target);
      } else {
        // DB entitlement is already committed. A downgraded skill must stay
        // quarantined outside the discovery root even when a later native
        // operation fails; successful cleanup deletes this transaction.
        continue;
      }
    } catch (error) {
      errors.push(`${operation.type}:${operation.name}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

async function enforceNativeEntitlements(incomingNames: Iterable<string>, agentsSkillsDir: string): Promise<void> {
  await ensureRealDirectory(agentsSkillsDir);
  await quarantineLegacyDiscoveryArtifacts(agentsSkillsDir);
  const incoming = new Set(incomingNames);
  const oldIndex = await readJson<NativeIndex>(join(agentsSkillsDir, INDEX));
  const candidates = new Set(
    oldIndex?.owner === OWNER && Array.isArray(oldIndex.skills)
      ? oldIndex.skills.filter((name) => typeof name === "string" && SAFE_NAME.test(name))
      : [],
  );
  for (const entry of await readdir(agentsSkillsDir, { withFileTypes: true })) {
    if (!SAFE_NAME.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const marker = await readJson<NativeMarker>(join(agentsSkillsDir, entry.name, MARKER));
    if (marker?.owner === OWNER) candidates.add(entry.name);
  }

  for (const name of candidates) {
    if (incoming.has(name)) continue;
    const target = join(agentsSkillsDir, name);
    if (!(await exists(target))) continue;
    if (await isPristineMarkedSkill(target)) {
      await rm(target, { recursive: true, force: true });
      continue;
    }
    await quarantineManagedSkill(target, name, agentsSkillsDir);
  }
}

async function resolveNativeSkillsDirs(options: SkillSyncOptions): Promise<string[]> {
  const userHome = options.homeDir ?? homedir();
  const canonical = options.agentsSkillsDir ?? join(userHome, ".agents", "skills");
  let claudeCode: string | null = null;
  let cursor: string | null = null;

  if (typeof options.claudeCodeSkillsDir === "string") {
    claudeCode = options.claudeCodeSkillsDir;
  } else if (options.claudeCodeSkillsDir !== false && options.agentsSkillsDir === undefined) {
    // Claude Code owns ~/.claude and ~/.claude.json. Claude Desktop uses its
    // platform application-support directory, so it does not trigger this
    // filesystem mirror. This is intentionally hook-free: connect creates the
    // MCP registration first, then this regular file sync makes skills visible.
    const claudeHome = join(userHome, ".claude");
    if (await exists(join(userHome, ".claude.json")) || await exists(claudeHome)) {
      claudeCode = join(claudeHome, "skills");
    }
  }

  if (typeof options.cursorSkillsDir === "string") {
    cursor = options.cursorSkillsDir;
  } else if (options.cursorSkillsDir !== false && options.agentsSkillsDir === undefined) {
    // Cursor's native Agent Skills discovery root is ~/.cursor/skills. Keep
    // ~/.agents/skills as the cross-host canonical copy and mirror only when a
    // Cursor home already exists, so installing Prism alone creates no host
    // configuration. This remains a regular, hook-free manifest transaction.
    const cursorHome = join(userHome, ".cursor");
    if (await exists(cursorHome)) cursor = join(cursorHome, "skills");
  }

  const candidates = [...new Set([canonical, claudeCode, cursor]
    .filter((path): path is string => Boolean(path))
    .map((path) => resolve(path)))];
  const canonicalPath = candidates[0];
  let canonicalTarget = canonicalPath;
  try {
    canonicalTarget = await realpath(canonicalPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }

  const deduplicated = [canonicalPath];
  for (const candidate of candidates.slice(1)) {
    let entry;
    try {
      entry = await lstat(candidate);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        deduplicated.push(candidate);
        continue;
      }
      throw error;
    }
    if (!entry.isSymbolicLink()) {
      deduplicated.push(candidate);
      continue;
    }

    // Cursor documents ~/.cursor/skills -> ~/.agents/skills as a compatible
    // discovery setup. Treat only that exact target as the canonical root,
    // including a temporarily dangling relative link. Every other symlink
    // fails before fetch or mutation so Prism never writes through a
    // user-owned path.
    let linkTarget = resolve(dirname(candidate), await readlink(candidate));
    try {
      linkTarget = await realpath(candidate);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    if (linkTarget !== canonicalPath && linkTarget !== canonicalTarget) {
      throw new Error(`native skill mirror is a user-owned symlink; preserved without changes: ${candidate}`);
    }
  }
  return deduplicated;
}

function mergeNativeResults(
  results: Array<Pick<SkillSyncResult, "installed" | "updated" | "pruned" | "conflicts">>,
): Pick<SkillSyncResult, "installed" | "updated" | "pruned" | "conflicts"> {
  const merge = (key: "installed" | "updated" | "pruned" | "conflicts") =>
    [...new Set(results.flatMap((result) => result[key]))].sort();
  return {
    installed: merge("installed"),
    updated: merge("updated"),
    pruned: merge("pruned"),
    conflicts: merge("conflicts"),
  };
}

async function readCommittedManifestNames(): Promise<string[] | null> {
  const owner = await getSetting("skill_manifest:owner", "");
  const generation = await getSetting("skill_manifest:generation", "");
  if (owner !== "prism" || !SHA256.test(generation)) return null;
  try {
    const value: unknown = JSON.parse(await getSetting("skill_manifest:names", "[]"));
    if (!Array.isArray(value) || value.length === 0) return null;
    const names = value.filter((name): name is string => typeof name === "string" && SAFE_NAME.test(name));
    if (names.length !== value.length || new Set(names).size !== names.length) return null;
    return names;
  } catch {
    return null;
  }
}

async function materializeNative(
  manifest: SkillManifest,
  agentsSkillsDir: string,
  hooks: Pick<SkillSyncOptions, "afterNativePrune" | "beforeNativeStage" | "beforeNativeCommit" | "beforeNativeCleanup">,
): Promise<Pick<SkillSyncResult, "installed" | "updated" | "pruned" | "conflicts">> {
  await mkdir(agentsSkillsDir, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(agentsSkillsDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("native skills root must be a real directory");
  await quarantineLegacyDiscoveryArtifacts(agentsSkillsDir);
  // Transaction content must remain outside the native discovery root: some
  // hosts recursively scan it and would otherwise discover staged/pruned paid
  // SKILL.md files after a crash.
  const transactionBase = join(dirname(agentsSkillsDir), ".prism-skill-transactions");
  await ensureRealDirectory(transactionBase);
  await removeExpiredTransactions(transactionBase);
  const transactionRoot = await mkdtemp(join(transactionBase, "txn-"));
  const stageRoot = join(transactionRoot, "stage");
  const backupRoot = join(transactionRoot, "backup");
  await ensureRealDirectory(stageRoot);
  const oldIndex = await readJson<NativeIndex>(join(agentsSkillsDir, INDEX));
  const indexed = new Set(
    oldIndex?.owner === OWNER && Array.isArray(oldIndex.skills)
      ? oldIndex.skills.filter((name) => typeof name === "string" && SAFE_NAME.test(name))
      : [],
  );
  const incoming = new Set(manifest.skills.map((skill) => skill.name));
  const nativeEntries = await readdir(agentsSkillsDir, { withFileTypes: true });
  const markerOwned = new Set<string>();
  for (const entry of nativeEntries) {
    if (!SAFE_NAME.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const marker = await readJson<NativeMarker>(join(agentsSkillsDir, entry.name, MARKER));
    if (marker?.owner === OWNER) markerOwned.add(entry.name);
  }
  // The marker is durable transaction provenance. Union it with the index so
  // a process crash between target rename and index rename remains recoverable,
  // including when the next portal generation removes that skill.
  const managedCandidates = new Set([...indexed, ...markerOwned]);
  const existingByFoldedName = new Map(
    nativeEntries
      .filter((entry) => !entry.name.startsWith(".prism-"))
      .map((entry) => [entry.name.toLocaleLowerCase("en-US"), entry.name]),
  );
  const installed: string[] = [];
  const updated: string[] = [];
  const pruned: string[] = [];
  const conflicts: string[] = [];
  const finalManaged = new Set<string>();
  const operations: NativeOperation[] = [];
  let tempIndex: string | null = null;
  let retainTransaction = false;
  let indexCommitted = false;

  try {
    // Enforce downgrades first. Once the DB snapshot is committed, obsolete
    // platform content must leave the discovery root before staging or
    // updating any still-entitled skill can fail.
    let pruneFailure: unknown = null;
    for (const name of managedCandidates) {
      if (incoming.has(name)) continue;
      const target = join(agentsSkillsDir, name);
      if (!(await exists(target))) continue;
      const stat = await lstat(target);
      const pristine = stat.isDirectory() && !stat.isSymbolicLink() && await isPristineManagedSkill(target, true);
      if (!pristine) {
        // Preserve locally modified managed content, but quarantine it outside
        // host discovery rather than retaining an entitlement bypass.
        conflicts.push(name);
        try {
          await quarantineManagedSkill(target, name, agentsSkillsDir);
          pruned.push(name);
          if (hooks.afterNativePrune) await hooks.afterNativePrune(name);
        } catch (error) {
          pruneFailure ??= error;
        }
        continue;
      }
      try {
        await ensureRealDirectory(backupRoot);
        const backup = join(backupRoot, `${name}-${randomUUID()}`);
        await rename(target, backup);
        operations.push({ type: "prune", name, target, backup });
        pruned.push(name);
        if (hooks.afterNativePrune) await hooks.afterNativePrune(name);
      } catch (error) {
        pruneFailure ??= error;
      }
    }
    if (pruneFailure) throw pruneFailure;

    if (hooks.beforeNativeStage) await hooks.beforeNativeStage();
    for (const skill of manifest.skills) await stageSkill(stageRoot, skill, manifest.generation);
    for (const skill of manifest.skills) {
      const target = join(agentsSkillsDir, skill.name);
      const staged = join(stageRoot, skill.name);
      const caseAlias = existingByFoldedName.get(skill.name.toLocaleLowerCase("en-US"));
      if (caseAlias && caseAlias !== skill.name) {
        conflicts.push(skill.name);
        if (managedCandidates.has(skill.name)) finalManaged.add(skill.name);
        continue;
      }
      if (!(await exists(target))) {
        await rename(staged, target);
        existingByFoldedName.set(skill.name.toLocaleLowerCase("en-US"), skill.name);
        operations.push({ type: "install", name: skill.name, target });
        installed.push(skill.name);
        finalManaged.add(skill.name);
        continue;
      }
      const stat = await lstat(target);
      const managedSkill = managedCandidates.has(skill.name);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !(await isPristineManagedSkill(target, managedSkill))) {
        conflicts.push(skill.name);
        if (managedSkill) finalManaged.add(skill.name);
        continue;
      }
      if (await matchesIncomingSkill(target, skill)) {
        finalManaged.add(skill.name);
        continue;
      }
      await ensureRealDirectory(backupRoot);
      const backup = join(backupRoot, skill.name);
      await rename(target, backup);
      try { await rename(staged, target); } catch (error) {
        await rename(backup, target);
        throw error;
      }
      operations.push({ type: "update", name: skill.name, target, backup });
      updated.push(skill.name);
      finalManaged.add(skill.name);
    }

    if (hooks.beforeNativeCommit) await hooks.beforeNativeCommit();
    const index: NativeIndex = { owner: OWNER, generation: manifest.generation, skills: [...finalManaged].sort() };
    tempIndex = join(agentsSkillsDir, `${INDEX}.${randomUUID()}.tmp`);
    await writeFile(tempIndex, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    await rename(tempIndex, join(agentsSkillsDir, INDEX));
    tempIndex = null;
    indexCommitted = true;
    if (hooks.beforeNativeCleanup) await hooks.beforeNativeCleanup();
    return { installed, updated, pruned, conflicts: [...new Set(conflicts)].sort() };
  } catch (error) {
    if (tempIndex) await rm(tempIndex, { force: true });
    if (indexCommitted) {
      retainTransaction = true;
      throw error;
    }
    const rollbackErrors = await rollbackNativeOperations(operations, backupRoot);
    retainTransaction = rollbackErrors.length > 0;
    const suffix = rollbackErrors.length > 0 ? `; rollback errors: ${rollbackErrors.join(", ")}` : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
  } finally {
    if (!retainTransaction) await rm(transactionRoot, { recursive: true, force: true });
    try {
      if ((await readdir(transactionBase)).length === 0) await rm(transactionBase, { recursive: true, force: true });
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
    }
  }
}

async function runtimeConfig(baseUrl?: string): Promise<{ baseUrl: string; credentialConfigured: boolean }> {
  const configuredUrl = baseUrl || process.env.PRISM_SYNALUX_BASE_URL?.trim() || process.env.SYNALUX_BASE_URL?.trim() ||
    (await getSetting("PRISM_SYNALUX_BASE_URL", "")).trim() || (await getSetting("SYNALUX_BASE_URL", "")).trim() || "https://synalux.ai";
  const key = process.env.PRISM_SYNALUX_API_KEY?.trim() || (await getSetting("PRISM_SYNALUX_API_KEY", "")).trim();
  if (!/^https?:\/\//i.test(configuredUrl)) throw new Error("invalid Synalux base URL");
  process.env.PRISM_SYNALUX_BASE_URL = configuredUrl.replace(/\/+$/, "");
  if (key) process.env.PRISM_SYNALUX_API_KEY = key;
  return { baseUrl: process.env.PRISM_SYNALUX_BASE_URL, credentialConfigured: Boolean(key || process.env.PRISM_SKILLS_TOKEN) };
}

async function fetchManifest(options: SkillSyncOptions): Promise<SkillManifest> {
  const config = await runtimeConfig(options.baseUrl);
  const credentialConfigured = options.configuredCredential ?? config.credentialConfigured;
  const headers: Record<string, string> = { Accept: "application/json", "X-Prism-Client": "prism-mcp-skill-sync" };
  const staticToken = process.env.PRISM_SKILLS_TOKEN?.trim();
  let usedJwt = false;
  if (staticToken) headers.Authorization = `Bearer ${staticToken}`;
  else if (credentialConfigured) {
    const jwt = await (options.getJwt ?? getSynaluxJwt)();
    if (!jwt) throw new Error("configured Synalux credentials could not authenticate");
    headers.Authorization = `Bearer ${jwt}`;
    usedJwt = true;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = () => fetchImpl(`${config.baseUrl}/api/v1/prism/skill-manifest`, {
    method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let response = await request();
  if (response.status === 401 && usedJwt) {
    (options.invalidateJwt ?? invalidateSynaluxJwt)();
    const fresh = await (options.getJwt ?? getSynaluxJwt)();
    if (!fresh) throw new Error("Synalux credential refresh failed");
    headers.Authorization = `Bearer ${fresh}`;
    response = await request();
  }
  if (!response.ok) throw new Error(`skill manifest HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > MAX_MANIFEST_BYTES) throw new Error("skill manifest response exceeds size limit");
  let payload: unknown;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response body");
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_MANIFEST_BYTES) {
        await reader.cancel();
        throw new Error("skill manifest response exceeds size limit");
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), received);
    payload = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.includes("size limit")) throw error;
    throw new Error("skill manifest returned invalid JSON");
  }
  const manifest = validateSkillManifest(payload);
  if (!headers.Authorization && manifest.tier !== "free") {
    throw new Error("unauthenticated skill manifest must be free tier");
  }
  return manifest;
}

async function acquireSyncLock(agentsSkillsDir: string, waitMs = LOCK_WAIT_MS): Promise<() => Promise<void>> {
  await mkdir(agentsSkillsDir, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(agentsSkillsDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("native skills root must be a real directory");
  const lockPath = join(agentsSkillsDir, ".prism-sync.lock");
  const deadline = Date.now() + Math.max(0, waitMs);
  const token = randomUUID();
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const prior = await readJson<Partial<SyncLockRecord>>(lockPath);
        const lockStat = await lstat(lockPath);
        const staleByAge = Date.now() - lockStat.mtimeMs > 10 * 60 * 1000;
        let stale = false;
        if (Number.isInteger(prior?.pid)) {
          try {
            process.kill(prior!.pid!, 0);
          } catch (killError: any) {
            stale = killError?.code === "ESRCH";
          }
        } else {
          stale = staleByAge;
        }
        if (stale) {
          const stalePath = `${lockPath}.stale-${randomUUID()}`;
          await rename(lockPath, stalePath);
          await rm(stalePath, { force: true });
          continue;
        }
      } catch (inspectError: any) {
        if (inspectError?.code === "ENOENT") continue;
        throw inspectError;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for another Prism skill sync");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now()))));
    }
  }
  const record: SyncLockRecord = {
    owner: OWNER,
    pid: process.pid,
    started_at: new Date().toISOString(),
    token,
  };
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
  } catch (error) {
    try { await handle.close(); } catch {}
    try { await rm(lockPath, { force: true }); } catch {}
    throw error;
  }
  return async () => {
    try { await handle.close(); } catch (error) {
      console.error(`[Prism Skill Sync] Failed to close native lock: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const current = await readJson<Partial<SyncLockRecord>>(lockPath);
      if (current?.owner === OWNER && current.token === token) await rm(lockPath, { force: true });
    } catch (error) {
      console.error(`[Prism Skill Sync] Failed to remove native lock: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

export async function synchronizeSkillManifest(options: SkillSyncOptions = {}): Promise<SkillSyncResult> {
  const empty = { installed: [], updated: [], pruned: [], conflicts: [] };
  let nativeSkillsDirs: string[] = [];
  let agentsSkillsDir = "";
  let releaseLock: (() => Promise<void>) | null = null;
  let manifest: SkillManifest | null = null;
  let dbApplied = false;
  try {
    nativeSkillsDirs = await resolveNativeSkillsDirs(options);
    agentsSkillsDir = nativeSkillsDirs[0];
    // Fetch only after acquiring the shared lock. A waiter therefore fetches
    // the portal's current generation after the preceding process completes,
    // and DB/native state advance as one serialized pair.
    releaseLock = await acquireSyncLock(agentsSkillsDir, options.lockWaitMs);
    await refreshConfigStorageCache();
    // Recover a hard exit after the DB commit but before native pruning. The
    // already-committed names are sufficient to remove obsolete native skills
    // even when the portal is offline on this restart.
    if (!options.applyManifest) {
      const committedNames = await readCommittedManifestNames();
      if (committedNames) {
        for (const nativeSkillsDir of nativeSkillsDirs) {
          await enforceNativeEntitlements(committedNames, nativeSkillsDir);
        }
      }
    }
    manifest = await fetchManifest(options);
    await (options.applyManifest ?? applyManagedSkillManifest)({
      generation: manifest.generation,
      tier: manifest.tier,
      routingVersion: manifest.routing_version,
      skills: manifest.skills.map(({ name, content, digest }) => ({ name, content, digest })),
    });
    dbApplied = true;
    const nativeResults: Array<Pick<SkillSyncResult, "installed" | "updated" | "pruned" | "conflicts">> = [];
    for (const nativeSkillsDir of nativeSkillsDirs) {
      nativeResults.push(await materializeNative(manifest, nativeSkillsDir, options));
    }
    const native = mergeNativeResults(nativeResults);
    const status = native.installed.length || native.updated.length || native.pruned.length ? "applied" : "unchanged";
    return {
      status,
      tier: manifest.tier,
      generation: manifest.generation,
      entitledNames: manifest.skills.map((skill) => skill.name),
      ...native,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (manifest) {
      const entitledNames = manifest.skills.map((skill) => skill.name);
      let enforcementError = "";
      const enforcementErrors: string[] = [];
      for (const nativeSkillsDir of nativeSkillsDirs) try {
        // A portal-validated downgrade is authoritative even when the local
        // config transaction fails. Leaving obsolete native directories in
        // discovery would turn a local DB fault into an entitlement bypass.
        await enforceNativeEntitlements(entitledNames, nativeSkillsDir);
      } catch (enforcement) {
        enforcementErrors.push(`${nativeSkillsDir}: ${enforcement instanceof Error ? enforcement.message : String(enforcement)}`);
      }
      enforcementError = enforcementErrors.length > 0
        ? `; entitlement cleanup failed: ${enforcementErrors.join(", ")}`
        : "";
      return {
        status: "partial", tier: manifest.tier, generation: manifest.generation,
        entitledNames,
        error: `${dbApplied ? "config DB applied; native materialization incomplete" : "authoritative manifest validated; config DB apply incomplete"}: ${detail}${enforcementError}`,
        ...empty,
      };
    }
    return {
      status: "failed",
      error: detail, ...empty,
    };
  } finally {
    if (releaseLock) await releaseLock();
  }
}

/** Single-flight automatic entry point used by startup and session loading. */
export function triggerSkillManifestSync(options: SkillSyncOptions = {}): Promise<SkillSyncResult> {
  if (process.env.PRISM_SKILL_SYNC_DISABLED === "true") {
    return Promise.resolve({ status: "disabled", installed: [], updated: [], pruned: [], conflicts: [] });
  }
  if (inFlight) return inFlight;
  const run = synchronizeSkillManifest(options);
  inFlight = run.then((result) => {
    lastResult = result;
    lastFinishedAt = Date.now();
    inFlight = null;
    return result;
  }, (error) => {
    inFlight = null;
    throw error;
  });
  return inFlight;
}

/** Await the startup run, or start one when a non-server caller loads context. */
export function awaitSkillManifestSync(options: SkillSyncOptions = {}): Promise<SkillSyncResult> {
  if (inFlight) return inFlight;
  if (!lastResult || lastResult.status === "failed" || lastResult.status === "partial" || Date.now() - lastFinishedAt > SUCCESS_TTL_MS) {
    return triggerSkillManifestSync(options);
  }
  return Promise.resolve(lastResult);
}

export function _resetSkillManifestSyncForTest(): void {
  inFlight = null;
  lastResult = null;
  lastFinishedAt = 0;
}
