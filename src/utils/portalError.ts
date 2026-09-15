/**
 * Portal HTTP errors carry their status and body so a caller can tell a
 * PLAN refusal — the account is signed in, but its plan does not include
 * the feature — from an outage, a quota, or an expired login. Only the plan
 * refusal may be answered with the user's own provider key (braveApi.ts);
 * everything else stays inside the portal's privacy boundary.
 */
export class PortalHttpError extends Error {
  readonly portalPath: string;
  readonly portalStatus: number;
  readonly portalBody: string;

  constructor(path: string, status: number, body: string) {
    super(`[synaluxSearch] ${path} HTTP ${status}: ${body}`);
    this.name = "PortalHttpError";
    this.portalPath = path;
    this.portalStatus = status;
    this.portalBody = body;
  }
}

/**
 * True when the portal refused because of the account's plan: the
 * `auth.plan === 'free'` gate on the prism search routes answers 403 with
 * `{ error: "... requires Standard plan or higher.", upgrade_url: "/pricing" }`.
 * Either signal — the word "plan" in the body, or a structured
 * `upgrade_url` — is accepted, so a reworded message does not silently take
 * a free user's own key away again. A 403 with neither is not a plan
 * refusal, whatever else it may be.
 */
export function isPortalPlanRefusal(err: unknown): err is PortalHttpError {
  if (!(err instanceof PortalHttpError) || err.portalStatus !== 403) return false;
  if (/\bplan\b/i.test(err.portalBody)) return true;
  try {
    const body = JSON.parse(err.portalBody) as { upgrade_url?: unknown };
    return typeof body?.upgrade_url === "string";
  } catch {
    return false;
  }
}
