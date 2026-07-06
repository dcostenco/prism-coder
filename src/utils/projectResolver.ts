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
}

export interface ResolveErr {
  ok: false;
  error: string;
  hint?: string;
}

export type ResolveResult = ResolveOk | ResolveErr;

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

  if (derivedProject && derivedProject !== declaredProject) {
    return {
      ok: false,
      error:
        `Project mismatch: declared "${declaredProject}" but files_changed indicate "${derivedProject}".`,
      hint:
        `Re-issue the request with project="${derivedProject}". ` +
        `If you genuinely intended "${declaredProject}", first add it to the registry with a non-overlapping repo_path.`,
    };
  }

  if (derivedProject && derivedProject === declaredProject) {
    return { ok: true, project: declaredProject };
  }

  if (registry.some((r) => r.name === declaredProject)) {
    return { ok: true, project: declaredProject };
  }

  const prefix = commonPathPrefix(filesChanged);
  if (prefix) {
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
