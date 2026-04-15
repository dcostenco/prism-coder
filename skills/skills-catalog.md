# Prism MCP — Skills Catalog (Filtered + Tool-Wired)
#
# Skills that ACTUALLY work via MCP tools. Each skill maps to real
# tool names the agent can call. Agent-only infrastructure skills
# (browser automation, CI, VSIX packaging) are excluded.
#
# Usage: Load as a role skill via `getSetting('skill:<role>')` or
# reference from session_load_context for agent awareness.
#
# Last updated: 2026-04-15

## 🧠 Session Memory
- **Save Progress** → `session_save_ledger`: Log completed work, decisions, file changes
- **Save State** → `session_save_handoff`: Preserve key context, TODOs, branch for next session
- **Load Context** → `session_load_context`: Recover previous work state (quick/standard/deep)
- **Search Memory** → `session_search_memory`, `knowledge_search`: Find past work by keyword or meaning
- **Compact History** → `session_compact_ledger`: Merge old entries into rollup summaries
- **Time Travel** → `memory_history`, `memory_checkout`: Browse and restore past states

## 📊 Behavioral Learning
- **Track Experience** → `session_save_experience`: Record corrections, successes, failures, learnings
- **Graduate Insights** → `knowledge_upvote`, `knowledge_downvote`: Promote/demote memory importance
- **Sync IDE Rules** → `knowledge_sync_rules`: Auto-write graduated insights to .cursorrules
- **Intuitive Recall** → `session_intuitive_recall`: SDM pattern matching for latent connections

## 🔗 Knowledge Graph
- **Discover Connections** → `session_synthesize_edges`: Find semantic links between disconnected memories
- **Cognitive Routing** → `session_cognitive_route`: Resolve state→concept with policy gates
- **Task Delegation** → `session_task_route`: Route tasks to host or local agent

## 🖼️ Visual Memory
- **Save Screenshot** → `session_save_image`: Store reference images with descriptions
- **View Screenshot** → `session_view_image`: Retrieve stored images with VLM captions

## 🔒 GDPR & Data Management
- **Delete Memory** → `session_forget_memory`: Soft or hard delete individual entries
- **Export Data** → `session_export_memory`: JSON/Markdown/Vault export (Article 20)
- **Set Retention** → `knowledge_set_retention`: Auto-expire entries older than N days
- **Purge Vectors** → `deep_storage_purge`: Reclaim storage from old embeddings
- **Vacuum DB** → `maintenance_vacuum`: Reclaim disk space after purges

## 🔬 Research & Search
- **Web Search** → `brave_web_search`: Brave Search API with pagination
- **Local Search** → `brave_local_search`: Business/place lookup
- **AI Answers** → `brave_answers`: Grounded answers via Brave AI
- **Paper Analysis** → `gemini_research_paper_analysis`: Academic paper review via Gemini
- **Code Transform** → `code_mode_transform`: Extract fields from any tool output via JS sandbox
