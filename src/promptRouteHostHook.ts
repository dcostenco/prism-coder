/**
 * prism-route — self-installing UserPromptSubmit hook for Claude Code + Codex.
 *
 * WHY A HOST HOOK. An MCP server never sees the user's prompt; the protocol
 * carries only what a tool call carries. session_route_prompt (the MCP tool)
 * therefore depends on the model deciding to call it — near-automatic at
 * best. A UserPromptSubmit hook is the only mechanism that fires on EVERY
 * prompt regardless of model behaviour, on both hosts, which is what the
 * operator requires ("i need automatic").
 *
 * WHY SELF-INSTALLING. The previous generation of prism hooks was provisioned
 * by a bootstrap script once, then hand-maintained per machine — which is why
 * this machine has them and the other team machines do not. This module is
 * called from three places so no machine can miss it:
 *   1. `prism connect`      — the explicit path,
 *   2. npm postinstall      — the upgrade path,
 *   3. MCP server startup   — the safety net for installs that skip scripts.
 * All three converge here and the operation is idempotent: same version →
 * no writes; registered → not re-registered; other people's hooks untouched.
 *
 * WHY THE HOOK SHELLS OUT TO `prism route-prompt` instead of matching in
 * Python: the trigger table, scoped-frontmatter triggers, entitlement and
 * caps live in the TypeScript matcher. A Python reimplementation would drift,
 * and a table that matches differently in the hook than in the server is
 * worse than no hook at all.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Bump to force the on-disk script to be rewritten on the next ensure. */
export const PROMPT_ROUTE_HOOK_VERSION = "3";

const MARKER_FILE = ".prism-managed.json";
const SCRIPT_FILE = "on_prompt.py";
const HOOK_DIR = "prism-route";
/** Substring that identifies our entry inside a host hooks config. */
const COMMAND_SIGNATURE = `${HOOK_DIR}/${SCRIPT_FILE}`;
/**
 * The command registered in the host config carries the version as an
 * argument (the script ignores argv — it reads stdin). This is a SECURITY
 * property, found by an external probe of Codex 0.146: Codex's hook-trust
 * hash covers the CONFIGURED DEFINITION, not the file the command points at.
 * With a stable command and a version-refreshed script, every prism upgrade
 * would silently swap the executable content behind an already-trusted hash —
 * exactly what the trust gate exists to prevent. Versioning the command
 * changes the definition on every script change, forcing Codex to re-prompt.
 * Cost: one approval per release, which is Codex's consent model working.
 */
function hookCommand(scriptPath: string): string {
  return `python3 ${scriptPath} --v${PROMPT_ROUTE_HOOK_VERSION}`;
}

/**
 * The hook script. Python because both hosts' existing hook fleets are
 * Python and the runtime is guaranteed present on macOS.
 *
 * Contract notes:
 *  - stdin carries the host's JSON payload; `prompt` is the Claude Code key
 *    and the fallbacks cover Codex's Claude-compatible hook payloads.
 *  - It must NEVER fail the turn: every path ends in continue:true, and an
 *    unexpected exception exits 0 with a pass-through.
 *  - Per-session dedupe lives HERE (state/<session>.json), because the hook
 *    is the only party that knows what it already injected. `loaded` is
 *    passed to the CLI so the matcher never returns the same skill twice.
 */
export const PROMPT_ROUTE_HOOK_SCRIPT = `#!/usr/bin/env python3
"""Prism-managed hook (prism-route v${PROMPT_ROUTE_HOOK_VERSION}).

Routes every user prompt through the on-device skill matcher via
'prism route-prompt'. Injects newly matched skill bodies as context.
Managed by prism; edits are overwritten on version bumps.
"""
import json
import os
import re
import shutil
import subprocess
import sys


def emit(extra=None):
    out = {"continue": True, "suppressOutput": True}
    if extra:
        out["hookSpecificOutput"] = {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": extra,
        }
    print(json.dumps(out))


def find_cli():
    override = os.environ.get("PRISM_ROUTE_CLI")
    if override and os.path.exists(override):
        return override
    found = shutil.which("prism")
    if found:
        return found
    home = os.path.expanduser("~")
    for candidate in (
        os.path.join(home, ".npm-global", "bin", "prism"),
        "/opt/homebrew/bin/prism",
        "/usr/local/bin/prism",
        os.path.join(home, "bin", "prism"),
    ):
        if os.path.exists(candidate):
            return candidate
    return None


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        payload = {}

    prompt = str(
        payload.get("prompt")
        or payload.get("message")
        or payload.get("user_prompt")
        or ""
    ).strip()
    # Slash commands and micro-prompts ("ok", "merge") never route; skipping
    # them keeps the common turn free.
    if len(prompt) < 6 or prompt.startswith("/"):
        emit()
        return
    # A pasted log can be megabytes; triggers live in the first human-sized
    # stretch, and the CLI caps identically on its side.
    prompt = prompt[:100_000]

    session = str(
        payload.get("session_id")
        or payload.get("sessionId")
        or payload.get("conversation_id")
        or "default"
    )
    session = re.sub(r"[^A-Za-z0-9._-]", "_", session).lstrip(".")[:80] or "default"

    state_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")
    state_path = os.path.join(state_dir, session + ".json")
    loaded = []
    try:
        with open(state_path) as fh:
            data = json.load(fh)
            if isinstance(data, list):
                loaded = [n for n in data if isinstance(n, str)]
    except Exception:
        pass

    cli = find_cli()
    if not cli:
        emit()
        return

    try:
        result = subprocess.run(
            [cli, "route-prompt", "--loaded", ",".join(loaded)],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        emit()
        return
    if result.returncode != 0:
        emit()
        return

    # Parse the LAST line that is JSON: wrappers hooked into node via
    # NODE_OPTIONS (dotenv banners and the like) print to stdout BEFORE the
    # CLI's own output, and one polluted line must not kill routing.
    data = None
    for line in reversed(result.stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                data = json.loads(line)
                break
            except Exception:
                continue
    if not isinstance(data, dict):
        emit()
        return
    names = [n for n in (data.get("names") or []) if isinstance(n, str)]
    text = data.get("text") or ""
    if not names or not text:
        emit()
        return

    try:
        os.makedirs(state_dir, exist_ok=True)
        merged = loaded + [n for n in names if n not in loaded]
        with open(state_path, "w") as fh:
            json.dump(merged, fh)
    except Exception:
        pass  # dedupe degrades, injection still happens

    emit(text)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"continue": True, "suppressOutput": True}))
        sys.exit(0)
`;

export interface EnsureHookHostResult {
  host: "claude" | "codex";
  script: "installed" | "refreshed" | "unchanged" | "disabled";
  config: "registered" | "updated" | "unchanged";
  /** Codex only: its trust gate silently skips unapproved hooks. We can
   *  DETECT approval only coarsely (a [hooks.state] section naming our hook);
   *  "pending-or-unknown" means the operator must run /hooks and trust it. */
  codexApproval?: "detected" | "pending-or-unknown" | "state-present-unverifiable";
  scriptPath: string;
  configPath: string;
}

export interface EnsureHookOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Restrict to specific hosts; default is both. */
  hosts?: Array<"claude" | "codex">;
  /** Only ensure for hosts whose root directory already exists (default true
   *  — a machine without ~/.codex should not grow one). */
  onlyExistingRoots?: boolean;
  /**
   * "explicit" — the user ran `prism connect`; that command IS the consent
   *   to manage host configuration, so install unconditionally.
   * "auto" (postinstall, server startup) — this package is PUBLIC npm, and
   *   silently rewriting a stranger's ~/.claude/settings.json because they
   *   installed an MCP server is consent they never gave. Auto paths
   *   therefore only act on hosts that show PRIOR prism integration: our
   *   own managed marker (upgrade/refresh) or a prism MCP registration in
   *   that host's config (the machine was connected at some point).
   */
  mode?: "explicit" | "auto";
}

/** Evidence that this host was already prism-integrated by explicit action. */
function hostShowsPriorConsent(spec: HostSpec, homeDir: string): boolean {
  if (existsSync(join(spec.root, "hooks", HOOK_DIR, MARKER_FILE))) return true;
  const evidenceFiles = spec.host === "claude"
    ? [join(homeDir, ".claude.json"), spec.configPath]
    : [join(spec.root, "config.toml"), spec.configPath];
  for (const file of evidenceFiles) {
    try {
      if (/prism/i.test(readFileSync(file, "utf8"))) return true;
    } catch { /* unreadable = no evidence */ }
  }
  return false;
}

interface HostSpec {
  host: "claude" | "codex";
  root: string;
  configPath: string;
}

function hostSpecs(homeDir: string, env: NodeJS.ProcessEnv): HostSpec[] {
  const codexHome = env.CODEX_HOME?.trim() ? resolve(env.CODEX_HOME.trim()) : join(homeDir, ".codex");
  return [
    { host: "claude", root: join(homeDir, ".claude"), configPath: join(homeDir, ".claude", "settings.json") },
    // Codex keeps hooks in hooks.json, not settings.json — same schema.
    { host: "codex", root: codexHome, configPath: join(codexHome, "hooks.json") },
  ];
}

/**
 * Coarse Codex approval detection. Codex persists hook approvals as a
 * [hooks.state] table in config.toml keyed by definition hash; the hashing
 * algorithm is not public, so the only honest signals are "a state section
 * exists and mentions our hook path" (detected) or anything else
 * (pending-or-unknown). Never treat unknown as approved.
 */
function detectCodexApproval(codexRoot: string): "detected" | "pending-or-unknown" | "state-present-unverifiable" {
  try {
    const toml = readFileSync(join(codexRoot, "config.toml"), "utf8");
    const hasState = /\[hooks\.state/.test(toml);
    if (hasState && toml.includes(COMMAND_SIGNATURE)) return "detected";
    // Approvals are keyed by definition hash (algorithm not public). Once ANY
    // trust state exists we cannot distinguish ours from here — and claiming
    // AWAITING TRUST after the operator pressed t would be a false alarm
    // against their own action. Distinct state, distinct wording.
    if (hasState) return "state-present-unverifiable";
  } catch { /* unreadable = no evidence */ }
  return "pending-or-unknown";
}

function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.prism-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function ensureScript(hookDir: string): "installed" | "refreshed" | "unchanged" | "disabled" {
  const markerPath = join(hookDir, MARKER_FILE);
  const scriptPath = join(hookDir, SCRIPT_FILE);
  let existingVersion: string | undefined;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { version?: string; disabled?: boolean };
    // The durable off switch. Without it, an operator who deletes the entry
    // or edits the script gets silently re-enabled by the next upgrade —
    // self-healing becomes self-reinfecting. {"disabled": true} in the
    // marker survives every ensure path, including version bumps.
    if (marker.disabled === true) return "disabled";
    existingVersion = marker.version;
  } catch {
    /* no marker — install */
  }
  const scriptExists = existsSync(scriptPath);
  if (scriptExists && existingVersion === PROMPT_ROUTE_HOOK_VERSION) return "unchanged";

  writeAtomically(scriptPath, PROMPT_ROUTE_HOOK_SCRIPT);
  chmodSync(scriptPath, 0o755);
  mkdirSync(join(hookDir, "state"), { recursive: true });
  writeAtomically(
    markerPath,
    `${JSON.stringify({ managedBy: "prism", feature: "prism-route", version: PROMPT_ROUTE_HOOK_VERSION }, null, 2)}\n`,
  );
  return scriptExists ? "refreshed" : "installed";
}

function ensureRegistered(configPath: string, scriptPath: string): "registered" | "updated" | "unchanged" {
  let config: Record<string, unknown> = {};
  let originalText: string | undefined;
  try {
    originalText = readFileSync(configPath, "utf8");
    const parsed: unknown = JSON.parse(originalText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    /* missing or unreadable — create minimal */
  }

  const hooks = (config.hooks && typeof config.hooks === "object" && !Array.isArray(config.hooks)
    ? config.hooks
    : {}) as Record<string, unknown>;
  const entries = Array.isArray(hooks.UserPromptSubmit) ? (hooks.UserPromptSubmit as unknown[]) : [];

  const wanted = hookCommand(scriptPath);
  let stale = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const inner = (entry as { hooks?: unknown }).hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (!h || typeof h !== "object") continue;
      // Normalize separators: on Windows join() registers a backslash path,
      // and a forward-slash signature would never match — so every ensure
      // would re-register a duplicate entry.
      const command = String((h as { command?: unknown }).command ?? "");
      if (!command.replace(/\\/g, "/").includes(COMMAND_SIGNATURE)) continue;
      if (command === wanted) return "unchanged";
      // Same hook, older version: UPDATE the definition in place. This is
      // what makes a script refresh visible to Codex's definition-hash —
      // and on Claude it is a harmless argv change.
      (h as { command: string }).command = wanted;
      stale = true;
    }
  }
  if (!stale) {
    entries.push({
      matcher: "*",
      hooks: [{ type: "command", command: wanted, timeout: 15 }],
    });
  }
  hooks.UserPromptSubmit = entries;
  config.hooks = hooks;
  writeAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return stale ? "updated" : "registered";
}

/**
 * Idempotently install the prism-route hook for both hosts.
 * Never throws for a single host's failure — the other host still gets it.
 */
export function ensurePromptRouteHook(options: EnsureHookOptions = {}): EnsureHookHostResult[] {
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const wanted = new Set(options.hosts ?? ["claude", "codex"]);
  const onlyExisting = options.onlyExistingRoots ?? true;

  const results: EnsureHookHostResult[] = [];
  for (const spec of hostSpecs(homeDir, env)) {
    if (!wanted.has(spec.host)) continue;
    if (onlyExisting && !existsSync(spec.root)) continue;
    if ((options.mode ?? "explicit") === "auto" && !hostShowsPriorConsent(spec, homeDir)) continue;
    try {
      const hookDir = join(spec.root, "hooks", HOOK_DIR);
      const script = ensureScript(hookDir);
      if (script === "disabled") continue; // operator opt-out — do not re-register either
      const config = ensureRegistered(spec.configPath, join(hookDir, SCRIPT_FILE));
      const result: EnsureHookHostResult = { host: spec.host, script, config, scriptPath: join(hookDir, SCRIPT_FILE), configPath: spec.configPath };
      if (spec.host === "codex") {
        // Never report a green "registered" as if it were active: Codex
        // SILENTLY SKIPS untrusted hooks, and "installed but inert" is the
        // exact failure class this feature exists to end.
        result.codexApproval = detectCodexApproval(spec.root);
      }
      results.push(result);
    } catch {
      // One host failing (permissions, odd config) must not block the other.
    }
  }
  return results;
}
