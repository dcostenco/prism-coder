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
} catch {
  /* never fail an install */
}
