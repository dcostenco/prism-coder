---
description: Auto-load Prism session memory at conversation start
alwaysApply: true
---

# Startup: Load Prism Context

At the START of every conversation, your FIRST action must be this tool call:

mcp_prism-mcp_session_load_context(project="prism-mcp", level="deep")

Do not generate any text before making this call.
After success, echo: agent identity, last summary, open TODOs, session version.
