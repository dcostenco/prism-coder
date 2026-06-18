# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 15.x    | ✅ Active support   |
| 14.x    | ⚠️ Critical fixes only |
| < 14.0  | ❌ End of life      |

## Reporting a Vulnerability

If you discover a security vulnerability in Prism Coder, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **dcostenco@synalux.ai**

You can expect:
- **Acknowledgment** within 48 hours
- **Assessment** within 7 days
- **Fix or mitigation** for confirmed vulnerabilities within 30 days

## Security Architecture

Prism Coder is designed with a security-first mindset:

- **Local-first by default**: All data stays on your machine in SQLite. No telemetry, no phone-home.
- **Zero credential storage**: API keys are passed as environment variables, never persisted in the database.
- **Sandboxed code execution**: Code Mode transforms run in a QuickJS sandbox with no filesystem or network access.
- **GDPR compliance**: Full data export (`session_export_memory`) and deletion (`session_forget_memory`, `knowledge_forget`) tools built in.
- **Supabase RLS**: When using the cloud backend, all queries are scoped to the authenticated user via Row Level Security policies.

## Inference Telemetry — Data Inventory & Multi-User Gate

**Added:** 2026-06-17 | **Owner:** Dmitri Costenco | **Status:** Single-user approved, multi-user gated

### What is collected

Per-call inference metrics forwarded to the Synalux portal via `ddLog("prism_infer.usage")`:

| Field | Type | Sensitivity |
|-------|------|-------------|
| `backend` | string (`ollama-9b`, `synalux-27b`) | Low — model name |
| `model` | string | Low — model name |
| `used_cloud` | boolean | Low — routing decision |
| `prompt_tokens` | number | Low — count only, no content |
| `completion_tokens` | number | Low — count only, no content |
| `latency_ms` | number | Low — timing |

**Excluded by design:** prompt content, system prompts, model output, error stack traces, file paths, user credentials. Enforced by a static 15-field `CONTEXT_ALLOWLIST` in `ddLogger.ts` applied to both Supabase and Datadog sinks. Regression-tested.

**`message` field discipline:** The `message` parameter to `ddLog`/`ddError` bypasses the context allowlist and reaches both sinks verbatim (capped at 200 chars). Messages MUST be static event identifiers (e.g. `"prism_infer.usage"`, `"prism_infer.tier_enforcement"`). Never interpolate dynamic or user-derived content into the message string — put it in `context` where the allowlist governs it.

**Excluded from telemetry:** `safety_gate` intercepts (crisis/medical filter triggers are HIPAA-sensitive).

### Storage & retention

- **Supabase** `app_telemetry` table: 15-day retention (auto-cleaned by `cleanup_app_telemetry()`)
- **Datadog** (optional): Governed by org's DD retention policy
- **Keyed to:** `user_id` (currently client-asserted, see risk acceptance below)

### Behavioral metadata classification

Per-user `model` + `latency_ms` + token volume + call frequency constitutes behavioral metadata about AI usage patterns. In a clinical (BCBA/AAC) context this is PHI-adjacent. The allowlist reduces severity (no content/stacks), but the governance obligation remains.

**Retention justification:** 15 days enables session-spanning analytics and debugging without long-term behavioral profiling. Retention period should be re-evaluated if metrics are used for billing or compliance audit.

### Risk acceptance: forgeable `user_id`

**Current state:** The telemetry ingest (`POST /api/v1/telemetry`) authenticates with a shared `TELEMETRY_WRITE_TOKEN` and takes `user_id` from the request body. Any token holder can attribute events to any `user_id`.

**Accepted for:** Single-user local deployment where the token holder IS the user.

**Multi-user gate — ALL must be completed before multi-tenant deployment:**

- [ ] **JWT-derived `user_id` on ingest** — Portal extracts `user_id` from the JWT instead of trusting the body field. Write attribution must be as strong as read scoping.
- [ ] **Portal cross-user isolation test** — Regression test asserting user A's request never returns user B's rows (read leak was code-reviewed but not test-guarded).
- [ ] **Verify no downstream consumer** — Confirm billing, tier gating, and HIPAA audit do NOT query `app_telemetry` by `user_id`. If they do, forgeable attribution has audit/billing impact.
- [ ] **`since` filter clock-skew mitigation** — Currently uses prism's wall clock. Server-side `created_at` filtering would be more reliable for multi-client deployments.

### Known limitations (not blocking single-user ship)

- Offline/local-only users get no inference metrics (thin-client architecture requires portal connectivity)
- Cloud token estimates are char/4 heuristic (portal doesn't return token metadata)
- Per-IP rate limit on ingest may throttle NAT'd multi-clinician deployments

## Dependencies

We regularly audit dependencies with `npm audit`. The project has zero known vulnerabilities in its direct dependency tree as of the latest release.
