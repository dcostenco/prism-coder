/**
 * Agent Definition Sync — materializes portal-served agent definitions
 * (subagent routing policy: model tier, effort cap, tool surface) into
 * Claude Code's agent root (~/.claude/agents/<name>.md).
 *
 * Deliberately separate from skillManifestSync's directory-package engine:
 * agent definitions are SINGLE FILES, so this module implements file-level
 * semantics with the same two protective properties the skill engine pins:
 *
 *   1. A hand-edited or foreign file is NEVER overwritten or deleted — it is
 *      reported as a conflict and left byte-identical on disk.
 *   2. Ownership is provable, not assumed: a file is "ours" only when its
 *      current content digest matches the digest recorded in the sidecar
 *      index at the time we last wrote it.
 *
 * The server contract (portal /api/v1/prism/skill-manifest) ships agents
 * under separate `agents` + `agents_generation` fields precisely so that
 * clients which predate this module ignore them; `generation` remains a
 * skills-only hash. Do not fold agents into the skills generation on either
 * side.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirUsable, repairOwnerAccess } from "./utils/usableDirectory.js";
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const OWNER = "prism-mcp";
const INDEX = ".prism-agents.json";
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const MAX_AGENTS = 64;
const MAX_AGENT_BYTES = 256 * 1024;

export interface AgentDefinition {
  name: string;
  content: string;
  digest: string;
}

export interface AgentSection {
  agents: AgentDefinition[];
  generation: string;
}

export interface AgentSyncOutcome {
  installed: string[];
  updated: string[];
  pruned: string[];
  conflicts: string[];
}

/** A host-specific rendering of one canonical agent definition. */
export interface RenderedAgent {
  file: string;
  content: string;
}

export type AgentRenderer = (agent: AgentDefinition) => RenderedAgent | null;

interface AgentIndexEntry {
  digest: string;
  file: string;
}

interface AgentIndex {
  owner: typeof OWNER;
  generation: string;
  files: Record<string, AgentIndexEntry>;
}

/** Parsed canonical AGENT.md: Claude-style frontmatter plus prompt body. */
export interface ParsedAgentDefinition {
  fields: Record<string, string>;
  body: string;
}

export function parseAgentDefinition(content: string): ParsedAgentDefinition {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { fields: {}, body: content };
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const entry = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (entry) fields[entry[1]] = entry[2].trim();
  }
  return { fields, body: content.slice(match[0].length) };
}

// ─── Host renderers ──────────────────────────────────────────
//
// The canonical format is Claude Code's agent markdown; other hosts receive a
// translation of the universally-expressible subset. Model tier is
// DELIBERATELY not translated: model namespaces are host-specific and rotate
// (gpt-5.6-* today), so foreign hosts keep their own configured defaults
// (codex: default_subagent_model) and only the proven effort/tool-surface
// levers travel.

/** Claude Code: the canonical content verbatim. */
export const renderClaudeAgent: AgentRenderer = (agent) => ({
  file: `${agent.name}.md`,
  content: agent.content,
});

const CODEX_EFFORT: Record<string, string> = {
  low: "low", medium: "medium", high: "high", xhigh: "high", max: "high",
};

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function tomlMultiline(value: string): string {
  // Escaping every backslash and quote keeps any body (including """ runs)
  // valid inside a multiline basic string while preserving literal newlines.
  return `"""\n${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"""`;
}

/**
 * Codex: ~/.codex/agents/<name>.toml. Keys verified against codex 0.146.0:
 * name, description, developer_instructions, model_reasoning_effort,
 * sandbox_mode. A Bash-bearing tool surface implies the agent must execute
 * reproductions, so it gets workspace-write; otherwise read-only.
 */
export const renderCodexAgent: AgentRenderer = (agent) => {
  const { fields, body } = parseAgentDefinition(agent.content);
  const effort = CODEX_EFFORT[fields.effort ?? ""];
  const tools = (fields.tools ?? "").split(",").map((tool) => tool.trim());
  const sandbox = tools.includes("Bash") ? "workspace-write" : "read-only";
  const lines = [
    `name = ${tomlString(agent.name)}`,
    `description = ${tomlString(fields.description ?? agent.name)}`,
    ...(effort ? [`model_reasoning_effort = ${tomlString(effort)}`] : []),
    `sandbox_mode = ${tomlString(sandbox)}`,
    `developer_instructions = ${tomlMultiline(body)}`,
  ];
  return { file: `${agent.name}.toml`, content: `${lines.join("\n")}\n` };
};

/**
 * Gemini CLI: ~/.gemini/agents/<name>.md (verified loadAgentsFromDirectory:
 * .md files, "_"-prefixed skipped). Frontmatter is reduced to the fields
 * gemini understands; Claude-specific keys (tools/model/effort) are dropped
 * rather than risked against a stricter parser. Coexists with the
 * prism-connect agent policy that owns ~/.gemini/settings.json overrides.
 */
export const renderGeminiAgent: AgentRenderer = (agent) => {
  const { fields, body } = parseAgentDefinition(agent.content);
  const frontmatter = [
    "---",
    `name: ${agent.name}`,
    `description: ${fields.description ?? agent.name}`,
    "---",
  ].join("\n");
  return { file: `${agent.name}.md`, content: `${frontmatter}\n\n${body}` };
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Parse the optional agents section of a skill-manifest payload.
 * Returns null when the server predates agents (fields absent).
 * Throws on a malformed section — the caller decides whether that is fatal;
 * it must never be silently treated as "no agents", because that would turn
 * contract drift into an invisible prune signal.
 */
export function validateAgentSection(payload: unknown): AgentSection | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (value.agents === undefined && value.agents_generation === undefined) return null;
  if (!Array.isArray(value.agents) || typeof value.agents_generation !== "string" ||
      !SHA256.test(value.agents_generation)) {
    throw new Error("invalid agent section");
  }
  if (value.agents.length > MAX_AGENTS) throw new Error("agent section exceeds bounds");
  const names = new Set<string>();
  const agents: AgentDefinition[] = value.agents.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`invalid agent at index ${index}`);
    const agent = raw as Record<string, unknown>;
    if (typeof agent.name !== "string" || !SAFE_NAME.test(agent.name)) throw new Error(`invalid agent name at index ${index}`);
    const folded = agent.name.toLocaleLowerCase("en-US");
    if (names.has(folded)) throw new Error(`duplicate agent name: ${agent.name}`);
    names.add(folded);
    if (typeof agent.content !== "string" || !agent.content.trim()) throw new Error(`empty agent content: ${agent.name}`);
    if (Buffer.byteLength(agent.content, "utf8") > MAX_AGENT_BYTES) throw new Error(`agent definition too large: ${agent.name}`);
    if (typeof agent.digest !== "string" || !SHA256.test(agent.digest) ||
        sha256(Buffer.from(agent.content, "utf8")) !== agent.digest.toLowerCase()) {
      throw new Error(`agent digest mismatch: ${agent.name}`);
    }
    return { name: agent.name, content: agent.content, digest: agent.digest.toLowerCase() };
  });
  return { agents, generation: value.agents_generation.toLowerCase() };
}

/**
 * Claude Code's agent-definition root, mirroring the skill sync's detection
 * guard: auto-detect only in the production default configuration so tests
 * and custom-root callers stay isolated.
 */
export async function resolveClaudeAgentsDir(options: {
  homeDir?: string;
  claudeCodeAgentsDir?: string | false;
  agentsSkillsDir?: string;
} = {}): Promise<string | null> {
  if (options.claudeCodeAgentsDir === false) return null;
  if (typeof options.claudeCodeAgentsDir === "string") return options.claudeCodeAgentsDir;
  if (options.agentsSkillsDir !== undefined) return null;
  const claudeHome = join(options.homeDir ?? homedir(), ".claude");
  try {
    const stat = await lstat(claudeHome);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return join(claudeHome, "agents");
}

async function detectHostAgentsDir(hostHome: string): Promise<string | null> {
  try {
    const stat = await lstat(hostHome);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return join(hostHome, "agents");
}

/** Codex agent root (~/.codex/agents or $CODEX_HOME/agents), same guards. */
export async function resolveCodexAgentsDir(options: {
  homeDir?: string;
  codexAgentsDir?: string | false;
  agentsSkillsDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<string | null> {
  if (options.codexAgentsDir === false) return null;
  if (typeof options.codexAgentsDir === "string") return options.codexAgentsDir;
  if (options.agentsSkillsDir !== undefined) return null;
  const configured = (options.env ?? process.env).CODEX_HOME?.trim();
  const codexHome = configured || join(options.homeDir ?? homedir(), ".codex");
  return detectHostAgentsDir(codexHome);
}

/** Gemini CLI agent root (~/.gemini/agents), same guards. */
export async function resolveGeminiAgentsDir(options: {
  homeDir?: string;
  geminiAgentsDir?: string | false;
  agentsSkillsDir?: string;
} = {}): Promise<string | null> {
  if (options.geminiAgentsDir === false) return null;
  if (typeof options.geminiAgentsDir === "string") return options.geminiAgentsDir;
  if (options.agentsSkillsDir !== undefined) return null;
  return detectHostAgentsDir(join(options.homeDir ?? homedir(), ".gemini"));
}

const SAFE_FILE = /^[A-Za-z0-9_-]+\.(md|toml)$/;

async function readIndex(path: string): Promise<AgentIndex | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AgentIndex>;
    if (parsed?.owner !== OWNER || typeof parsed.files !== "object" || !parsed.files) return null;
    const files: Record<string, AgentIndexEntry> = {};
    for (const [name, entry] of Object.entries(parsed.files)) {
      if (!SAFE_NAME.test(name) || !entry || typeof entry !== "object") continue;
      const { digest, file } = entry as Partial<AgentIndexEntry>;
      if (typeof digest === "string" && SHA256.test(digest) && typeof file === "string" && SAFE_FILE.test(file)) {
        files[name] = { digest: digest.toLowerCase(), file };
      }
    }
    return { owner: OWNER, generation: typeof parsed.generation === "string" ? parsed.generation : "", files };
  } catch {
    return null;
  }
}

async function currentDigest(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

/**
 * Exclusive install: hard-link the temp file into place. Unlike rename(2),
 * link(2) fails with EEXIST instead of overwriting, so a file that appears
 * between our existence check and the install cannot be clobbered (TOCTOU).
 * Returns false when the target already exists.
 */
async function installExclusive(dir: string, target: string, content: string): Promise<boolean> {
  const temp = join(dir, `.prism-agent-${randomUUID()}.tmp`);
  await writeFile(temp, content, { mode: 0o600 });
  try {
    await link(temp, target);
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    // Filesystems without hard-link support (exFAT/FAT32, several SMB and
    // container-volume mounts) reject link(2) outright. Without this fallback
    // those users receive ZERO agent definitions and only a stderr line —
    // the exclusivity hardening would have silently disabled the feature.
    // rename(2) is marginally weaker against a concurrent writer inside the
    // check→act window; delivering nothing is strictly worse.
    if (isErrno(error, "EPERM") || isErrno(error, "ENOTSUP") ||
        isErrno(error, "EOPNOTSUPP") || isErrno(error, "EXDEV")) {
      if (await currentDigest(target) !== null) return false;
      await rename(temp, target);
      return true;
    }
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Claim-then-verify mutation: atomically rename the target out of the root,
 * re-hash the CLAIMED bytes, and only act when they still match the recorded
 * digest. A mismatch (someone edited the file inside the check→act window)
 * restores the file byte-identical and reports a conflict. This closes the
 * check-then-act race CodeQL flags (js/file-system-race): after the rename we
 * operate on a path no other writer targets, and the decision digest is
 * computed from those exact bytes.
 */
async function claimVerified(
  dir: string,
  target: string,
  expectedDigest: string,
): Promise<{ claimed: string } | "gone" | "mismatch"> {
  const claimPath = join(dir, `.prism-agent-claim-${randomUUID()}.tmp`);
  try {
    await rename(target, claimPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "gone";
    throw error;
  }
  const bytes = await readFile(claimPath);
  if (sha256(bytes) !== expectedDigest) {
    await rename(claimPath, target); // restore byte-identical
    return "mismatch";
  }
  return { claimed: claimPath };
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

/**
 * Apply the agent section to a host agent root. Every write is an atomic
 * tmp+rename of a single small file; the index commits last, so a crash
 * mid-run leaves files that the next run re-proves ownership of by digest.
 */
export async function materializeAgentDefinitions(
  section: AgentSection,
  targetDir: string,
  render: AgentRenderer = renderClaudeAgent,
): Promise<AgentSyncOutcome> {
  // Same umask trap as the skill roots: a masked mkdir leaves a directory
  // nothing can enter, and every write below it then fails.
  await mkdirUsable(targetDir);
  const rootStat = await lstat(targetDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("agent root must be a real directory");
  }
  await repairOwnerAccess(targetDir, rootStat.mode);
  const indexPath = join(targetDir, INDEX);
  const index = await readIndex(indexPath);
  const owned = index?.files ?? {};
  const incoming = new Map<string, RenderedAgent>();
  for (const agent of section.agents) {
    const rendered = render(agent);
    if (rendered === null) continue;
    if (!SAFE_FILE.test(rendered.file)) throw new Error(`unsafe rendered agent file: ${rendered.file}`);
    incoming.set(agent.name, rendered);
  }

  const installed: string[] = [];
  const updated: string[] = [];
  const pruned: string[] = [];
  const conflicts: string[] = [];
  const finalFiles: Record<string, AgentIndexEntry> = {};

  // Downgrades first, mirroring the skill engine's ordering: entitlement
  // removal must not depend on the success of later installs. Deletion is
  // claim-then-verify: the digest that authorizes the rm is computed from the
  // bytes AFTER they leave the discovery root, so an edit racing the check
  // can never be destroyed.
  for (const [name, entry] of Object.entries(owned)) {
    if (incoming.has(name)) continue;
    const target = join(targetDir, entry.file);
    const claim = await claimVerified(targetDir, target, entry.digest);
    if (claim === "gone") continue; // already gone
    if (claim === "mismatch") {
      // Hand-edited content survives; we merely stop claiming it.
      conflicts.push(name);
      continue;
    }
    await rm(claim.claimed, { force: true });
    pruned.push(name);
  }

  for (const [name, rendered] of incoming) {
    const target = join(targetDir, rendered.file);
    const renderedDigest = sha256(Buffer.from(rendered.content, "utf8"));
    const digestOnDisk = await currentDigest(target);
    if (digestOnDisk === null) {
      // Exclusive install: a file appearing inside the window makes link()
      // fail instead of being overwritten; re-judge it as foreign content.
      if (await installExclusive(targetDir, target, rendered.content)) {
        installed.push(name);
        finalFiles[name] = { digest: renderedDigest, file: rendered.file };
      } else if (await currentDigest(target) === renderedDigest) {
        finalFiles[name] = { digest: renderedDigest, file: rendered.file };
      } else {
        conflicts.push(name);
      }
      continue;
    }
    const record = owned[name];
    const pristine = record !== undefined && record.file === rendered.file && digestOnDisk === record.digest;
    if (!pristine) {
      if (digestOnDisk === renderedDigest) {
        // Byte-identical foreign file: adopt without writing. Content equality
        // is the strongest ownership evidence available for a single file.
        finalFiles[name] = { digest: renderedDigest, file: rendered.file };
      } else {
        conflicts.push(name);
      }
      continue;
    }
    if (digestOnDisk === renderedDigest) {
      finalFiles[name] = { digest: renderedDigest, file: rendered.file };
      continue;
    }
    // Update = claim the old version out (verifying the recorded digest on
    // the claimed bytes), then exclusively install the new render. A racer
    // in either window wins the file and we report a conflict instead of
    // clobbering; the claimed old version is ours and safe to discard.
    const claim = await claimVerified(targetDir, target, record.digest);
    if (claim === "mismatch") {
      conflicts.push(name);
      continue;
    }
    const installedNow = await installExclusive(targetDir, target, rendered.content);
    if (claim !== "gone") await rm(claim.claimed, { force: true });
    if (installedNow) {
      updated.push(name);
      finalFiles[name] = { digest: renderedDigest, file: rendered.file };
    } else {
      conflicts.push(name);
    }
  }

  const nextIndex: AgentIndex = { owner: OWNER, generation: section.generation, files: finalFiles };
  const tempIndex = join(targetDir, `${INDEX}.${randomUUID()}.tmp`);
  await writeFile(tempIndex, `${JSON.stringify(nextIndex, null, 2)}\n`, { mode: 0o600 });
  await rename(tempIndex, indexPath);

  return {
    installed: installed.sort(),
    updated: updated.sort(),
    pruned: pruned.sort(),
    conflicts: [...new Set(conflicts)].sort(),
  };
}
