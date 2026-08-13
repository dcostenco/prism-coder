/**
 * npm postinstall — the upgrade path for the prism-route hook.
 *
 * `prism connect` is only typed once per machine, so an upgrade that adds or
 * fixes the hook would otherwise reach no one until they reconnect. Silent
 * and always-exit-0: a hook installer must never break `npm install`.
 */
import { ensurePromptRouteHook } from "./promptRouteHostHook.js";

try {
  const results = ensurePromptRouteHook({ mode: "auto" });
  if (process.env.PRISM_DEBUG) {
    for (const r of results) console.error(`[prism postinstall] ${r.host}: script=${r.script} config=${r.config}`);
  }
  // The ONE step install cannot do for the operator, said at the only moment
  // they are certainly watching. Codex's hook-trust gate exists so software
  // cannot approve its own execution — prism will never write that trust
  // state (a compromised release would otherwise gain silent
  // execute-on-every-prompt), so the honest maximum is to make the pending
  // approval impossible to miss. Approval is per hook-version, not per
  // release: it recurs only when the hook script itself changes.
  const codex = results.find((r) => r.host === "codex");
  if (codex && codex.codexApproval !== "detected") {
    console.error(
      "\n[prism] Codex hook installed but NOT yet trusted — Codex silently skips it until you approve it once:\n" +
      "[prism]   codex  ->  /hooks  ->  entry ending prism-route/on_prompt.py  ->  press t\n",
    );
  }
} catch {
  /* never fail an install */
}
