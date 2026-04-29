# Engineering Standards

See synalux-private/GEMINI.md for the full protocol. This file inherits those standards.
Additional Prism-specific rules:

1. **MCP Tool Testing:** When modifying tool handlers in src/tools/, run `npm test` before committing.
2. **Storage Backend Parity:** Changes to sqlite.ts must be mirrored in supabase.ts (and vice versa).
3. **Scheduler Safety:** backgroundScheduler.ts runs every 12h — never add blocking I/O to the sweep loop.
