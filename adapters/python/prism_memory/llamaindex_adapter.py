"""
LlamaIndex Memory Provider for Prism.

Integrates Prism as a chat memory store for LlamaIndex agents and chat engines.

Usage:
    from prism_memory import PrismLlamaIndexMemory

    memory = PrismLlamaIndexMemory(project="my-llama-project")
"""

from typing import Any, Dict, List, Optional
from .core import PrismMemory


class PrismLlamaIndexMemory:
    """
    LlamaIndex-compatible chat memory store.

    Supports LlamaIndex's ChatMemoryBuffer pattern:
    - put: store a chat message
    - get: retrieve recent messages
    - get_all: retrieve all messages
    - reset: clear buffer (append-only in Prism)
    """

    def __init__(self, project: str, token_limit: int = 3000, **kwargs: Any):
        self.prism = PrismMemory(project=project, **kwargs)
        self.token_limit = token_limit
        self._messages: List[Dict[str, str]] = []

    def put(self, message: Dict[str, str]) -> None:
        """Store a chat message. Auto-saves to Prism every 5 messages."""
        self._messages.append(message)
        if len(self._messages) % 5 == 0:
            content = message.get("content", "")[:200]
            self.prism.save(
                summary=f"Chat turn {len(self._messages)}: {content}",
                conversation_id=f"llamaindex-{self.prism.project}",
            )

    def get(self, limit: Optional[int] = None) -> List[Dict[str, str]]:
        """Get recent messages from buffer."""
        if limit:
            return self._messages[-limit:]
        # Estimate token count (rough: 4 chars per token)
        result = []
        total_chars = 0
        for msg in reversed(self._messages):
            msg_chars = len(msg.get("content", ""))
            if total_chars + msg_chars > self.token_limit * 4:
                break
            result.insert(0, msg)
            total_chars += msg_chars
        return result

    def get_all(self) -> List[Dict[str, str]]:
        """Get all messages in buffer."""
        return list(self._messages)

    def search(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        """Search Prism memories relevant to a query."""
        results = self.prism.search(query, limit=limit)
        return [
            {"content": r.entry.summary, "score": r.score, "created_at": r.entry.created_at}
            for r in results
        ]

    def reset(self) -> None:
        """Clear buffer. Prism entries persist."""
        self._messages.clear()

    def __repr__(self) -> str:
        return f"PrismLlamaIndexMemory(project='{self.prism.project}', buffer_size={len(self._messages)})"
