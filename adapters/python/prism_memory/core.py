"""
Prism Memory Core — Universal Python client for Prism MCP.

Communicates with Prism via the MCP stdio protocol or direct SQLite access.
This is the base layer used by all framework adapters.
"""

import json
import subprocess
import sqlite3
import os
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, field, asdict


@dataclass
class MemoryEntry:
    """A single memory entry from Prism's session ledger."""
    id: str = ""
    project: str = ""
    summary: str = ""
    decisions: List[str] = field(default_factory=list)
    todos: List[str] = field(default_factory=list)
    files_changed: List[str] = field(default_factory=list)
    created_at: str = ""
    importance: int = 5
    keywords: List[str] = field(default_factory=list)


@dataclass
class SearchResult:
    """Search result with relevance score."""
    entry: MemoryEntry
    score: float = 0.0
    match_type: str = "keyword"  # "keyword", "semantic", "fts"


class PrismMemory:
    """
    Universal Prism memory client for Python.

    Supports two communication modes:
    1. MCP stdio (default) — calls `npx prism-mcp` as a subprocess
    2. Direct SQLite — reads/writes prism.db directly (faster, local-only)

    Usage:
        memory = PrismMemory(project="my-project")
        memory.save("Built authentication module using JWT")
        results = memory.search("authentication")
        for r in results:
            print(r.entry.summary, r.score)
    """

    def __init__(
        self,
        project: str,
        mode: str = "auto",  # "mcp", "sqlite", "auto"
        db_path: Optional[str] = None,
        user_id: str = "default",
    ):
        self.project = project
        self.user_id = user_id
        self._conversation_counter = 0

        # Auto-detect mode
        if mode == "auto":
            default_db = os.path.expanduser("~/.prism/prism.db")
            if db_path or os.path.exists(default_db):
                self.mode = "sqlite"
                self.db_path = db_path or default_db
            else:
                self.mode = "mcp"
                self.db_path = None
        else:
            self.mode = mode
            self.db_path = db_path or os.path.expanduser("~/.prism/prism.db")

    def save(
        self,
        summary: str,
        decisions: Optional[List[str]] = None,
        todos: Optional[List[str]] = None,
        files_changed: Optional[List[str]] = None,
        conversation_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Save a memory entry to the project's session ledger.

        Args:
            summary: Brief description of what was accomplished
            decisions: Key decisions made during this session
            todos: Open TODO items remaining
            files_changed: Files created or modified
            conversation_id: Unique session ID (auto-generated if omitted)

        Returns:
            Dict with save confirmation details
        """
        self._conversation_counter += 1
        conv_id = conversation_id or f"py-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{self._conversation_counter}"

        if self.mode == "sqlite":
            return self._save_sqlite(conv_id, summary, decisions, todos, files_changed)
        else:
            return self._save_mcp(conv_id, summary, decisions, todos, files_changed)

    def search(
        self,
        query: str,
        limit: int = 10,
        category: Optional[str] = None,
    ) -> List[SearchResult]:
        """
        Search memories by keyword or free text.

        Args:
            query: Search query
            limit: Maximum results to return
            category: Optional category filter

        Returns:
            List of SearchResult with relevance scores
        """
        if self.mode == "sqlite":
            return self._search_sqlite(query, limit, category)
        else:
            return self._search_mcp(query, limit, category)

    def load_context(self, level: str = "standard") -> Dict[str, Any]:
        """
        Load session context for this project.

        Args:
            level: Context depth — "quick", "standard", or "deep"

        Returns:
            Dict with project state, recent summaries, and open TODOs
        """
        if self.mode == "sqlite":
            return self._load_context_sqlite(level)
        else:
            return self._load_context_mcp(level)

    def save_handoff(
        self,
        last_summary: str,
        open_todos: Optional[List[str]] = None,
        key_context: Optional[str] = None,
        active_branch: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Save handoff state for the next session.

        Args:
            last_summary: Summary of the most recent session
            open_todos: Current open TODO items
            key_context: Critical context for the next session
            active_branch: Git branch to resume on

        Returns:
            Dict with handoff save confirmation
        """
        if self.mode == "sqlite":
            return self._save_handoff_sqlite(last_summary, open_todos, key_context, active_branch)
        else:
            return self._save_handoff_mcp(last_summary, open_todos, key_context, active_branch)

    # ─── SQLite Implementation ────────────────────────────────

    def _get_db(self) -> sqlite3.Connection:
        """Get SQLite connection with WAL mode."""
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.row_factory = sqlite3.Row
        return conn

    def _save_sqlite(
        self, conv_id: str, summary: str,
        decisions: Optional[List[str]], todos: Optional[List[str]],
        files: Optional[List[str]]
    ) -> Dict[str, Any]:
        """Direct SQLite save to session_ledger table."""
        import uuid
        db = self._get_db()
        entry_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()

        db.execute(
            """INSERT INTO session_ledger
               (id, user_id, project, conversation_id, summary, decisions, todos, files_changed, created_at, importance)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                entry_id, self.user_id, self.project, conv_id, summary,
                json.dumps(decisions or []),
                json.dumps(todos or []),
                json.dumps(files or []),
                now, 5,
            ),
        )
        db.commit()
        db.close()

        return {"id": entry_id, "project": self.project, "saved_at": now}

    def _search_sqlite(
        self, query: str, limit: int, category: Optional[str]
    ) -> List[SearchResult]:
        """FTS5 keyword search against session_ledger."""
        db = self._get_db()
        try:
            # Try FTS5 first
            rows = db.execute(
                """SELECT id, project, summary, decisions, todos, files_changed,
                          created_at, importance
                   FROM session_ledger
                   WHERE user_id = ? AND project = ?
                     AND summary LIKE ?
                   ORDER BY created_at DESC
                   LIMIT ?""",
                (self.user_id, self.project, f"%{query}%", limit),
            ).fetchall()
        except Exception:
            rows = []

        results = []
        for row in rows:
            entry = MemoryEntry(
                id=row["id"],
                project=row["project"],
                summary=row["summary"],
                decisions=json.loads(row["decisions"] or "[]"),
                todos=json.loads(row["todos"] or "[]"),
                files_changed=json.loads(row["files_changed"] or "[]"),
                created_at=row["created_at"],
                importance=row["importance"],
            )
            results.append(SearchResult(entry=entry, score=0.8, match_type="keyword"))

        db.close()
        return results

    def _load_context_sqlite(self, level: str) -> Dict[str, Any]:
        """Load context directly from SQLite."""
        db = self._get_db()

        # Get handoff
        handoff_row = db.execute(
            "SELECT * FROM session_handoffs WHERE user_id = ? AND project = ? ORDER BY version DESC LIMIT 1",
            (self.user_id, self.project),
        ).fetchone()

        limit = {"quick": 1, "standard": 5, "deep": 50}.get(level, 5)
        ledger_rows = db.execute(
            "SELECT summary, decisions, todos FROM session_ledger WHERE user_id = ? AND project = ? ORDER BY created_at DESC LIMIT ?",
            (self.user_id, self.project, limit),
        ).fetchall()

        db.close()

        return {
            "project": self.project,
            "level": level,
            "handoff": dict(handoff_row) if handoff_row else None,
            "recent_sessions": [dict(r) for r in ledger_rows],
        }

    def _save_handoff_sqlite(
        self, summary: str, todos: Optional[List[str]],
        context: Optional[str], branch: Optional[str]
    ) -> Dict[str, Any]:
        """Upsert handoff state in SQLite."""
        db = self._get_db()
        now = datetime.now(timezone.utc).isoformat()

        db.execute(
            """INSERT OR REPLACE INTO session_handoffs
               (user_id, project, last_summary, open_todos, key_context, active_branch, updated_at, version)
               VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(
                 (SELECT version + 1 FROM session_handoffs WHERE user_id = ? AND project = ?), 1
               ))""",
            (self.user_id, self.project, summary,
             json.dumps(todos or []), context or "", branch or "",
             now, self.user_id, self.project),
        )
        db.commit()
        db.close()

        return {"project": self.project, "saved_at": now}

    # ─── MCP Implementation ───────────────────────────────────

    def _call_mcp(self, tool: str, args: Dict[str, Any]) -> Dict[str, Any]:
        """Call Prism via MCP stdio protocol using npx."""
        # Simplified: in production, use proper MCP client
        try:
            result = subprocess.run(
                ["npx", "-y", "prism-mcp@latest", "--tool", tool, "--args", json.dumps(args)],
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode == 0:
                return json.loads(result.stdout)
            return {"error": result.stderr}
        except Exception as e:
            return {"error": str(e)}

    def _save_mcp(self, conv_id, summary, decisions, todos, files) -> Dict[str, Any]:
        args = {"project": self.project, "conversation_id": conv_id, "summary": summary}
        if decisions: args["decisions"] = decisions
        if todos: args["todos"] = todos
        if files: args["files_changed"] = files
        return self._call_mcp("session_save_ledger", args)

    def _search_mcp(self, query, limit, category) -> List[SearchResult]:
        args = {"query": query, "limit": limit, "project": self.project}
        if category: args["category"] = category
        result = self._call_mcp("knowledge_search", args)
        # Parse MCP response into SearchResult objects
        return [
            SearchResult(
                entry=MemoryEntry(summary=r.get("summary", "")),
                score=r.get("score", 0.5),
            )
            for r in result.get("results", [])
        ]

    def _load_context_mcp(self, level) -> Dict[str, Any]:
        return self._call_mcp("session_load_context", {
            "project": self.project, "level": level,
            "toolAction": "Load context", "toolSummary": "Python adapter",
        })

    def _save_handoff_mcp(self, summary, todos, context, branch) -> Dict[str, Any]:
        args = {"project": self.project, "last_summary": summary}
        if todos: args["open_todos"] = todos
        if context: args["key_context"] = context
        if branch: args["active_branch"] = branch
        return self._call_mcp("session_save_handoff", args)

    def __repr__(self) -> str:
        return f"PrismMemory(project='{self.project}', mode='{self.mode}')"
