# Prism MCP — Skills Catalog (22 Skills + 30 MCP Tools)
#
# Skills are synced from ~/.agent/skills/ into Prism's config DB
# via `scripts/sync-skills.sh`. Auto-loaded during session_load_context
# when the agent's role matches a skill name.
#
# Run: bash scripts/sync-skills.sh
# Last synced: 2026-05-02

## Core Skills (5)
- **ask-first** — Ask before critical changes
- **command_verification** — Verify shell commands before/after execution
- **feature-preservation** — Never remove features without explicit approval
- **critical_resolution_memory** — Capture resolved issues as reusable guidance
- **gmail_oauth** — Gmail OAuth credential/token handling

## Clinical (1)
- **bcba_ai_assistant** — ABA clinical standards, FBA/BIP, BACB ethics

## Security (1)
- **military-code-review** — 5-phase security audit protocol, 16 test categories

## Synalux-Specific (2)
- **synalux-customers** — Production DB queries, user/workspace reports
- **i18n-tts** — 14 languages, 4-tier TTS, translation services

## Development (2)
- **dev-engineering-super-skill** — Full-stack architecture, testing, DevOps
- **code-mode-skill** — Add sandbox code execution to MCP servers

## Business (8)
- **pm-super-skill** — Product management, roadmaps, sprints
- **marketing-super-skill** — Campaigns, SEO, content, analytics
- **sales-super-skill** — Prospecting, outreach, competitive intel
- **finance-super-skill** — Accounting, forecasting, audit
- **legal-super-skill** — Contracts, compliance, NDA
- **operations-cx-super-skill** — Support, ticketing, KB
- **research-knowledge-super-skill** — Deep research, knowledge graphs
- **content-creative-super-skill** — Video, design, brand, content

## Agents & Memory (2)
- **ai-agent-super-skill** — Multi-agent orchestration, MCP servers, RAG
- **session-memory** — Session persistence, handoffs, context loading

## Social (1)
- **social-media-posting** — Reddit/X/LinkedIn via browse.py

---

## MCP Tool Categories (30 tools)

### Session Memory
- `session_save_ledger`, `session_save_handoff`, `session_load_context`
- `session_search_memory`, `session_compact_ledger`
- `memory_history`, `memory_checkout`

### Behavioral Learning
- `session_save_experience`, `knowledge_upvote`, `knowledge_downvote`
- `knowledge_sync_rules`, `session_cognitive_route`

### Knowledge Graph
- `session_synthesize_edges`, `session_task_route`, `session_backfill_links`

### Visual Memory
- `session_save_image`, `session_view_image`

### GDPR & Data
- `session_forget_memory`, `session_export_memory`
- `knowledge_set_retention`, `deep_storage_purge`, `maintenance_vacuum`

### Research & Search
- `brave_web_search`, `brave_local_search`, `brave_answers`
- `gemini_research_paper_analysis`, `code_mode_transform`

### Admin
- `api_analytics`, `backup_database`, `configure_notifications`
- `onboarding_wizard`, `extract_entities`, `query_memory_natural`
