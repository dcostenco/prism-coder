/**
 * Prism Project Resolver — Local Storage Variant
 * ================================================
 *
 * Same contract as the Synalux portal resolver but
 * sources the project registry from local prism-config.db settings
 * (`repo_path:<project>` keys) instead of the `prism_projects`
 * Supabase table.
 *
 * Used when prism-mcp is in direct-Supabase mode (legacy / pre-thin-
 * client). When the user migrates to PRISM_STORAGE=synalux, the
 * portal resolver becomes authoritative and this one becomes a noop
 * for the same write.
 *
 * Background: thin-client architecture directive 2026-04-30 — the prism-aac
 * Azure-leak memory-loss bug was caused by the absence of this
 * validation.
 */

import { getAllSettings, setSetting } from "../storage/configStorage.js";
import { debugLog } from "./logger.js";

export interface ResolveOk {
  ok: true;
  project: string;
  autoCreated?: boolean;
  /** Set when the registry disagrees with the declaration. Advisory only —
   *  the write proceeds under the DECLARED project. */
  warning?: string;
}

/** The resolver never refuses a write (see 2026-08-13 note below); the
 *  error shape exists only for source compatibility and is never returned. */
export type ResolveResult = ResolveOk;

const REPO_PATH_PREFIX = "repo_path:";

export function commonPathPrefix(paths: string[]): string {
  if (!paths || paths.length === 0) return "";
  const normalized = paths.map((p) => p.replace(/\\/g, "/"));

  if (normalized.length === 1) {
    const lastSlash = normalized[0].lastIndexOf("/");
    if (lastSlash <= 0) return "";
    const dir = normalized[0].slice(0, lastSlash);
    return dir.split("/").filter(Boolean).length >= 2 ? dir : "";
  }

  let prefix = normalized[0];
  for (let i = 1; i < normalized.length; i++) {
    while (prefix && !normalized[i].startsWith(prefix)) {
      prefix = prefix.slice(0, prefix.lastIndexOf("/"));
    }
    if (!prefix) return "";
  }
  prefix = prefix.replace(/\/+$/, "");
  if (prefix.split("/").filter(Boolean).length < 2) return "";
  return prefix;
}

function isUnder(path: string, repoPath: string): boolean {
  const p = path.replace(/\\/g, "/");
  const r = repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return p === r || p.startsWith(r + "/");
}

interface RegistryEntry {
  name: string;
  repo_path: string;
}

async function loadRegistry(): Promise<RegistryEntry[]> {
  const all = await getAllSettings();
  const rows: RegistryEntry[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(REPO_PATH_PREFIX) && value && value.trim()) {
      rows.push({
        name: key.slice(REPO_PATH_PREFIX.length),
        repo_path: value.trim(),
      });
    }
  }
  return rows;
}

function pickFromRegistry(
  registry: RegistryEntry[],
  filesChanged: string[]
): string | null {
  const candidates = registry
    .filter((r) => filesChanged.every((f) => isUnder(f, r.repo_path)))
    .sort((a, b) => b.repo_path.length - a.repo_path.length);
  return candidates.length ? candidates[0].name : null;
}

/**
 * Validates the declared project against the local registry of
 * `repo_path:*` settings. Auto-creates a registry entry on first
 * save when files_changed has a clear common prefix.
 *
 * Returns ok=false when there's evidence of a project-name mismatch
 * (declared X but files clearly belong to Y).
 */
export async function resolveProject(
  declaredProject: string,
  filesChanged: string[] | undefined | null
): Promise<ResolveResult> {
  if (!filesChanged || filesChanged.length === 0) {
    return { ok: true, project: declaredProject };
  }

  const registry = await loadRegistry();
  const derivedProject = pickFromRegistry(registry, filesChanged);

  // 2026-08-13: this used to HARD-REJECT on mismatch — and the registry it
  // trusted was auto-created junk (a live machine carried a repo_path entry
  // pointing at the HOME DIRECTORY, which contains every absolute path, plus
  // five relative-path rows). Agents got contradictory rejections, ping-ponged
  // by the hint, and sessions ended UNSAVED — a memory product dropping data to
  // enforce taxonomy. The declaration now always wins; the derivation is an
  // advisory warning. (The wrong-project class this gate was built for —
  // a 2026-04-30 memory-loss incident — is still surfaced, as a warning
  // the agent sees at save time instead of a refusal the user never does.)
  if (derivedProject && derivedProject !== declaredProject) {
    return {
      ok: true,
      project: declaredProject,
      warning:
        `Registry suggests these files belong to "${derivedProject}", but the entry was saved under ` +
        `"${declaredProject}" as declared. If "${derivedProject}" is correct, re-save with that project; ` +
        `if the registry is wrong, its repo_path for "${derivedProject}" needs repair.`,
    };
  }

  if (derivedProject && derivedProject === declaredProject) {
    return { ok: true, project: declaredProject };
  }

  if (registry.some((r) => r.name === declaredProject)) {
    return { ok: true, project: declaredProject };
  }

  const prefix = commonPathPrefix(filesChanged);
  if (prefix && isRegistrablePrefix(prefix, registry)) {
    try {
      await setSetting(`${REPO_PATH_PREFIX}${declaredProject}`, prefix);
      debugLog(
        `[projectResolver] auto-created repo_path:${declaredProject} = ${prefix}`
      );
    } catch (err) {
      debugLog(
        `[projectResolver] auto-create failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return { ok: true, project: declaredProject, autoCreated: true };
  }

  return { ok: true, project: declaredProject };
}

/**
 * Auto-create hygiene, added 2026-08-13. Every class rejected here was FOUND
 * in a live registry, where it poisoned later saves:
 *  - relative prefixes ("Tests/UITests") match or miss depending on the path
 *    style a later save happens to use;
 *  - short prefixes (a 2-segment home directory) contain every absolute
 *    path on the machine;
 *  - an ancestor of an existing entry re-creates the same containment bomb
 *    one level down.
 * Refusing to register is safe: the save proceeds either way, and the next
 * save with a cleaner file list can still register the project.
 */
function isRegistrablePrefix(prefix: string, registry: RegistryEntry[]): boolean {
  if (!prefix.startsWith("/")) return false;
  if (prefix.split("/").filter(Boolean).length < 3) return false;
  for (const entry of registry) {
    if (isUnder(entry.repo_path, prefix)) return false; // ancestor of an existing entry
  }
  return true;
}
