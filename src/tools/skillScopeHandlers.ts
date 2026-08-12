/**
 * skill_save / skill_manage — scoped skill management.
 *
 * A skill can live at three scopes:
 *   local — a plain file on this machine only (works signed-out; local-first)
 *   user  — the signed-in account; follows the user to every machine
 *   team  — a workspace; delivered to its members (admins may target a subset)
 *
 * Classification policy: an explicit scope always wins. Signed in without a
 * scope → `user` (private, reversible; the result says so and how to share).
 * Signed out → `local`. `team` is never a default: writing to shared state is
 * an explicit act, and the server enforces the owner/admin role.
 *
 * skill_manage covers the recall paths: `release` excludes a PLATFORM skill
 * from your (or your team's) delivery to free host catalog budget — fully
 * reversible with `restore` because platform content never leaves the bundle.
 * `delete` removes a scoped skill everywhere; because the stored row IS the
 * content, the handler archives the final content locally before anything is
 * discarded.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSetting } from "../storage/configStorage.js";
import { getSynaluxJwt } from "../utils/synaluxJwt.js";
import { triggerSkillManifestSync } from "../skillManifestSync.js";
import { mkdirUsable } from "../utils/usableDirectory.js";

const STRICT_SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/;
// Mirrors the platform's context-fit bar so a save refused by the server is
// refused here first, with the same explanation.
const MAX_CONTENT_BYTES = 25_000;
const MAX_DESCRIPTION_CHARS = 500;
const API_PATH = "/api/v1/prism/user-skills";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Structured data is SERIALIZED INTO the text, never returned as
 * `structuredContent`. A host may surface structuredContent and drop the text
 * block — Claude Code does — which silently discarded every explanation this
 * tool produced ("saved as YOUR account skill", the floor-guard refusal, the
 * how-to-share hint), leaving raw JSON. See buildSessionFactsLine in
 * ledgerHandlers.ts for the measurements behind this rule.
 */
function text(message: string, extra?: Record<string, unknown>, isError = false): ToolResult {
  const body = extra
    ? `${message}\n\n\`\`\`json\n${JSON.stringify(extra, null, 2)}\n\`\`\``
    : message;
  return { content: [{ type: "text", text: body }], ...(isError ? { isError } : {}) };
}

async function synaluxBaseUrl(): Promise<string> {
  const configured = process.env.PRISM_SYNALUX_BASE_URL?.trim() || process.env.SYNALUX_BASE_URL?.trim() ||
    (await getSetting("PRISM_SYNALUX_BASE_URL", "")).trim() || (await getSetting("SYNALUX_BASE_URL", "")).trim() ||
    "https://synalux.ai";
  if (!/^https?:\/\//i.test(configured)) throw new Error("invalid Synalux base URL");
  return configured.replace(/\/+$/, "");
}

function frontmatterProblems(name: string, content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return "content must open with YAML frontmatter (---) carrying name and description";
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!field) continue;
    const raw = field[2].trim();
    const quoted = raw.match(/^"(.*)"$/) ?? raw.match(/^'(.*)'$/);
    fields[field[1]] = quoted ? quoted[1] : raw;
  }
  if (fields.name !== name) return "frontmatter name must match the skill name";
  if (!fields.description) return "frontmatter must carry a non-empty description";
  if (fields.description.length > MAX_DESCRIPTION_CHARS) {
    return `frontmatter description exceeds ${MAX_DESCRIPTION_CHARS} chars (hosts budget catalog space by description length)`;
  }
  return null;
}

function validateSkillInput(name: unknown, content: unknown): string | null {
  if (typeof name !== "string" || !STRICT_SKILL_NAME.test(name)) {
    return "invalid skill name: lowercase letters, digits, - and _ only (max 128 chars)";
  }
  if (typeof content !== "string" || !content.trim()) return "content is required";
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    return `content exceeds the ${MAX_CONTENT_BYTES}-byte context-fit limit shared by every delivered skill; move reference material out or split it`;
  }
  return frontmatterProblems(name as string, content as string);
}

/** Local skill roots that hosts read natively. Never Prism-managed dirs. */
function localSkillRoots(): string[] {
  return [join(homedir(), ".agents", "skills"), join(homedir(), ".claude", "skills")];
}

function archiveDir(): string {
  return join(homedir(), ".prism-mcp", "skill-archive");
}

async function archiveContent(name: string, content: string): Promise<string> {
  const dir = archiveDir();
  await mkdirUsable(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${name}-${stamp}.md`);
  await writeFile(path, content, { mode: 0o600 });
  return path;
}

async function saveLocal(name: string, content: string): Promise<ToolResult> {
  const written: string[] = [];
  for (const root of localSkillRoots()) {
    const dir = join(root, name);
    await mkdirUsable(dir);
    await writeFile(join(dir, "SKILL.md"), content, { mode: 0o600 });
    written.push(dir);
  }
  return text(
    `Saved LOCALLY (this machine only): ${written.join(", ")}. ` +
    `Not uploaded anywhere. Sign in and re-save with scope "user" to make it follow your account, ` +
    `or scope "team" (workspace admins) to share it.`,
    { scope: "local", name, paths: written },
  );
}

interface ApiAuth { baseUrl: string; jwt: string }

async function apiAuth(): Promise<ApiAuth | null> {
  const jwt = await getSynaluxJwt().catch(() => null);
  if (!jwt) return null;
  return { baseUrl: await synaluxBaseUrl(), jwt };
}

async function callApi(auth: ApiAuth, method: string, body?: Record<string, unknown>, query = ""): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${auth.baseUrl}${API_PATH}${query}`, {
    method,
    headers: { Authorization: `Bearer ${auth.jwt}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let parsed: Record<string, unknown> = {};
  try { parsed = await response.json() as Record<string, unknown>; } catch { /* non-JSON error body */ }
  return { status: response.status, body: parsed };
}

/**
 * A sync started BEFORE the save cannot contain it; joining one would report
 * success while delivering nothing. Trigger has no TTL cache (single-flight
 * only), so run-then-verify: if the saved name did not arrive, run once more —
 * the second call cannot join a pre-save run because the first one completed.
 */
async function syncUntilDelivered(name: string): Promise<string> {
  const first = await triggerSkillManifestSync().catch(error => ({ status: "failed", installed: [], updated: [], pruned: [], conflicts: [], error: String(error) } as const));
  const delivered = (result: { installed: string[]; updated: string[] }) =>
    result.installed.includes(name) || result.updated.includes(name);
  if (first.status !== "failed" && delivered(first)) return "delivered to this machine now; other machines receive it at their next sync";
  const second = await triggerSkillManifestSync().catch(() => null);
  if (second && second.status !== "failed" && delivered(second)) return "delivered to this machine now; other machines receive it at their next sync";
  if (second && (second.status === "unchanged" || second.status === "applied")) {
    return "saved server-side; local delivery reported no change (it may already be current) — verify with your host's skill list";
  }
  return "saved server-side; local sync did not complete — it will arrive on the next successful sync";
}

export const SKILL_SAVE_TOOL = {
  name: "skill_save",
  description:
    "Save a skill at one of three scopes: local (this machine only, works signed out), " +
    "user (your account — follows you to every machine), or team (a workspace — delivered to its members; " +
    "owner/admin only, optionally targeted with assign_to). Default when signed in is USER; team is never " +
    "a default. Content must be a SKILL.md body with frontmatter (name, description).",
  inputSchema: {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Skill name (lowercase letters, digits, - and _)" },
      content: { type: "string", description: "Full SKILL.md content including frontmatter" },
      scope: { type: "string", enum: ["local", "user", "team"], description: "Where the skill lives. Omit to default: user when signed in, local otherwise." },
      workspace_id: { type: "string", description: "Required for team scope" },
      assign_to: { type: "array", items: { type: "string" }, description: "Team scope only (admin): deliver ONLY to these member user ids; omit for all members" },
    },
    required: ["name", "content"],
  },
};

export async function skillSaveHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const { name, content, scope, workspace_id: workspaceId, assign_to: assignTo } = args;
  const problem = validateSkillInput(name, content);
  if (problem) return text(`Not saved: ${problem}`, undefined, true);
  const skillName = name as string;
  const skillContent = content as string;

  if (scope !== undefined && scope !== "local" && scope !== "user" && scope !== "team") {
    return text("Not saved: scope must be local, user, or team", undefined, true);
  }
  if (scope === "local") return saveLocal(skillName, skillContent);

  const auth = await apiAuth();
  if (!auth) {
    if (scope === "user" || scope === "team") {
      return text("Not saved: this scope needs a signed-in Synalux account, and no credential is configured. Save with scope \"local\" to keep it on this machine.", undefined, true);
    }
    return saveLocal(skillName, skillContent);
  }

  const effectiveScope = scope ?? "user";
  if (effectiveScope === "team" && (typeof workspaceId !== "string" || !workspaceId)) {
    return text("Not saved: team scope requires workspace_id", undefined, true);
  }
  const { status, body } = await callApi(auth, "PUT", {
    scope: effectiveScope,
    ...(effectiveScope === "team" ? { workspace_id: workspaceId } : {}),
    ...(assignTo !== undefined ? { assign_to: assignTo } : {}),
    name: skillName,
    content: skillContent,
  });
  if (status !== 200) {
    return text(`Not saved (server ${status}): ${String(body.error ?? "unknown error")}`, undefined, true);
  }
  const delivery = await syncUntilDelivered(skillName);
  const where = effectiveScope === "user"
    ? `saved as YOUR account skill (version ${String(body.version)}) — say "make it a team skill" to share it with a workspace`
    : `saved as a TEAM skill for workspace ${String(workspaceId)} (version ${String(body.version)})${Array.isArray(assignTo) && assignTo.length > 0 ? `, targeted to ${assignTo.length} member(s)` : ", delivered to all members"}`;
  return text(`${where}. Delivery: ${delivery}.`, { scope: effectiveScope, name: skillName, version: body.version });
}

export const SKILL_MANAGE_TOOL = {
  name: "skill_manage",
  description:
    "Manage scoped skills and platform-skill activation. Actions: list (your skills, team skills, releases); " +
    "delete (remove a user/team/local skill — the final content is archived locally first); " +
    "release (deactivate a PLATFORM skill you never use, freeing host catalog budget — per user, or per team by admins); " +
    "restore (re-activate a released platform skill; lossless).",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "delete", "release", "restore"] },
      name: { type: "string", description: "Skill name (all actions except list)" },
      scope: { type: "string", enum: ["local", "user", "team"], description: "delete: where the skill lives; release/restore: user (yourself) or team (admin)" },
      workspace_id: { type: "string", description: "Required for team scope" },
    },
    required: ["action"],
  },
};

export async function skillManageHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const { action, name, scope, workspace_id: workspaceId } = args;

  if (action === "list") {
    const localEntries: string[] = [];
    for (const root of localSkillRoots()) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) localEntries.push(`${entry.name} (${root})`);
      }
    }
    const auth = await apiAuth();
    if (!auth) {
      return text(`Signed out — local skill directories only:\n${localEntries.join("\n") || "(none)"}`, { local: localEntries });
    }
    const { status, body } = await callApi(auth, "GET");
    if (status !== 200) return text(`Listing failed (server ${status}): ${String(body.error ?? "unknown")}`, undefined, true);
    return text(
      `Account skills: ${JSON.stringify(body.user_skills)}\nTeam skills: ${JSON.stringify(body.team_skills)}\nReleased platform skills: ${JSON.stringify(body.released)}\nLocal-only dirs: ${localEntries.length}`,
      { ...body, local: localEntries },
    );
  }

  if (typeof name !== "string" || !STRICT_SKILL_NAME.test(name)) {
    return text("Invalid skill name", undefined, true);
  }

  if (action === "delete") {
    if (scope === "local") {
      const archived: string[] = [];
      for (const root of localSkillRoots()) {
        const path = join(root, name, "SKILL.md");
        const body = await readFile(path, "utf8").catch(() => null);
        if (body !== null) {
          archived.push(await archiveContent(name, body));
          await rm(join(root, name), { recursive: true, force: true });
        }
      }
      if (archived.length === 0) return text(`No local skill named ${name} found`, undefined, true);
      return text(`Deleted local skill ${name}. Final content archived at: ${archived[0]} — re-save from there to recall it.`, { archived });
    }
    const auth = await apiAuth();
    if (!auth) return text("Deleting account/team skills needs a signed-in Synalux account", undefined, true);
    const query = `?name=${encodeURIComponent(name)}&scope=${scope === "team" ? "team" : "user"}` +
      (scope === "team" && typeof workspaceId === "string" ? `&workspace_id=${encodeURIComponent(workspaceId)}` : "");
    const { status, body } = await callApi(auth, "DELETE", undefined, query);
    if (status !== 200) return text(`Not deleted (server ${status}): ${String(body.error ?? "unknown")}`, undefined, true);
    const deleted = body.deleted as { content?: string } | undefined;
    let archivedAt = "server returned no content";
    if (deleted?.content) archivedAt = await archiveContent(name, deleted.content);
    await triggerSkillManifestSync().catch(() => null); // prune from this machine
    return text(`Deleted ${scope === "team" ? "team" : "account"} skill ${name}; it prunes from every machine at next sync. Final content archived at: ${archivedAt} — re-save from there to recall it.`, { archived: archivedAt });
  }

  if (action === "release" || action === "restore") {
    const auth = await apiAuth();
    if (!auth) return text("Releasing platform skills needs a signed-in Synalux account (local installs are managed by deleting the local copy)", undefined, true);
    const { status, body } = await callApi(auth, "PATCH", {
      action,
      scope: scope === "team" ? "team" : "user",
      ...(scope === "team" ? { workspace_id: workspaceId } : {}),
      name,
    });
    if (status !== 200) return text(`${action} failed (server ${status}): ${String(body.error ?? "unknown")}`, undefined, true);
    await triggerSkillManifestSync().catch(() => null);
    return text(action === "release"
      ? `Released ${name}: it leaves your delivered set and prunes from your machines at next sync, freeing host catalog budget. Fully reversible with action "restore".`
      : `Restored ${name}: it returns with your next sync on every machine.`,
      { action, name });
  }

  return text("action must be list, delete, release, or restore", undefined, true);
}
