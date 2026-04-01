# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 6.x     | ✅ Active support   |
| 5.x     | ⚠️ Critical fixes only |
| < 5.0   | ❌ End of life      |

## Reporting a Vulnerability

If you discover a security vulnerability in Prism MCP, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **security@dcostenco.com**

You can expect:
- **Acknowledgment** within 48 hours
- **Assessment** within 7 days
- **Fix or mitigation** for confirmed vulnerabilities within 30 days

## Security Architecture

Prism MCP is designed with a security-first mindset:

- **Local-first by default**: All data stays on your machine in SQLite. No telemetry, no phone-home.
- **Zero credential storage**: API keys are passed as environment variables, never persisted in the database.
- **Sandboxed code execution**: Code Mode transforms run in a QuickJS sandbox with no filesystem or network access.
- **GDPR compliance**: Full data export (`session_export_memory`) and deletion (`session_forget_memory`, `knowledge_forget`) tools built in.
- **Supabase RLS**: When using the cloud backend, all queries are scoped to the authenticated user via Row Level Security policies.

## Dependencies

We regularly audit dependencies with `npm audit`. The project has zero known vulnerabilities in its direct dependency tree as of the latest release.
