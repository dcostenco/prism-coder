"""
CrewAI Memory Provider for Prism.

Provides Prism as a long-term memory backend for CrewAI agents,
enabling persistent memory across crew runs.

Usage:
    from prism_memory import PrismCrewAIMemory

    memory = PrismCrewAIMemory(project="my-crew")
    # Use with CrewAI's memory parameter
"""

from typing import Any, Dict, List, Optional
from .core import PrismMemory


class PrismCrewAIMemory:
    """
    CrewAI-compatible memory provider backed by Prism.

    CrewAI uses a simple memory interface:
    - save: store a memory entry
    - search: retrieve relevant memories
    - reset: clear memory state
    """

    def __init__(self, project: str, **kwargs: Any):
        self.prism = PrismMemory(project=project, **kwargs)

    def save(
        self, value: str, metadata: Optional[Dict[str, Any]] = None, agent: Optional[str] = None
    ) -> None:
        """Save a memory from a CrewAI agent."""
        decisions = []
        if metadata:
            if "task" in metadata:
                decisions.append(f"Task: {metadata['task']}")
            if "result" in metadata:
                decisions.append(f"Result: {metadata['result']}")

        self.prism.save(
            summary=value,
            decisions=decisions if decisions else None,
            conversation_id=f"crewai-{agent or 'default'}",
        )

    def search(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        """Search memories relevant to a CrewAI task."""
        results = self.prism.search(query, limit=limit)
        return [
            {
                "content": r.entry.summary,
                "score": r.score,
                "metadata": {
                    "decisions": r.entry.decisions,
                    "created_at": r.entry.created_at,
                },
            }
            for r in results
        ]

    def reset(self) -> None:
        """Reset is a no-op — Prism ledger is append-only by design."""
        pass

    def __repr__(self) -> str:
        return f"PrismCrewAIMemory(project='{self.prism.project}')"
