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
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

interface AgentIndex {
  owner: typeof OWNER;
  generation: string;
  files: Record<string, string>;
}

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

async function readIndex(path: string): Promise<AgentIndex | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AgentIndex>;
    if (parsed?.owner !== OWNER || typeof parsed.files !== "object" || !parsed.files) return null;
    const files: Record<string, string> = {};
    for (const [name, digest] of Object.entries(parsed.files)) {
      if (SAFE_NAME.test(name) && typeof digest === "string" && SHA256.test(digest)) {
        files[name] = digest.toLowerCase();
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

async function writeAtomic(dir: string, target: string, content: string): Promise<void> {
  const temp = join(dir, `.prism-agent-${randomUUID()}.tmp`);
  await writeFile(temp, content, { mode: 0o600 });
  try {
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Apply the agent section to a host agent root. Every write is an atomic
 * tmp+rename of a single small file; the index commits last, so a crash
 * mid-run leaves files that the next run re-proves ownership of by digest.
 */
export async function materializeAgentDefinitions(
  section: AgentSection,
  targetDir: string,
): Promise<AgentSyncOutcome> {
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(targetDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("agent root must be a real directory");
  }
  const indexPath = join(targetDir, INDEX);
  const index = await readIndex(indexPath);
  const owned = index?.files ?? {};
  const incoming = new Map(section.agents.map((agent) => [agent.name, agent]));

  const installed: string[] = [];
  const updated: string[] = [];
  const pruned: string[] = [];
  const conflicts: string[] = [];
  const finalFiles: Record<string, string> = {};

  // Downgrades first, mirroring the skill engine's ordering: entitlement
  // removal must not depend on the success of later installs.
  for (const [name, recordedDigest] of Object.entries(owned)) {
    if (incoming.has(name)) continue;
    const target = join(targetDir, `${name}.md`);
    const digestOnDisk = await currentDigest(target);
    if (digestOnDisk === null) continue; // already gone
    if (digestOnDisk === recordedDigest) {
      await rm(target, { force: true });
      pruned.push(name);
    } else {
      // Hand-edited content survives; we merely stop claiming it.
      conflicts.push(name);
    }
  }

  for (const agent of section.agents) {
    const target = join(targetDir, `${agent.name}.md`);
    const digestOnDisk = await currentDigest(target);
    if (digestOnDisk === null) {
      await writeAtomic(targetDir, target, agent.content);
      installed.push(agent.name);
      finalFiles[agent.name] = agent.digest;
      continue;
    }
    const pristine = owned[agent.name] !== undefined && digestOnDisk === owned[agent.name];
    if (!pristine) {
      if (digestOnDisk === agent.digest) {
        // Byte-identical foreign file: adopt without writing. Content equality
        // is the strongest ownership evidence available for a single file.
        finalFiles[agent.name] = agent.digest;
      } else {
        conflicts.push(agent.name);
      }
      continue;
    }
    if (digestOnDisk === agent.digest) {
      finalFiles[agent.name] = agent.digest;
      continue;
    }
    await writeAtomic(targetDir, target, agent.content);
    updated.push(agent.name);
    finalFiles[agent.name] = agent.digest;
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
