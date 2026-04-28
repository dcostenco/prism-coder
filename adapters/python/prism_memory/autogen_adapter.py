"""
AutoGen Memory Provider for Prism.

Integrates Prism as a teachable memory backend for Microsoft AutoGen agents.

Usage:
    from prism_memory import PrismAutoGenMemory

    memory = PrismAutoGenMemory(project="my-autogen-project")
"""

from typing import Any, Dict, List, Optional
from .core import PrismMemory


class PrismAutoGenMemory:
    """
    AutoGen-compatible memory backend.

    AutoGen's teachability pattern uses:
    - add: store a learned fact
    - get_relevant: retrieve facts relevant to a message
    """

    def __init__(self, project: str, **kwargs: Any):
        self.prism = PrismMemory(project=project, **kwargs)

    def add(self, input_text: str, output_text: str, agent: Optional[str] = None) -> None:
        """Store a learned input→output pair."""
        summary = f"Learned: {input_text[:200]} → {output_text[:200]}"
        self.prism.save(
            summary=summary,
            decisions=[f"Input: {input_text[:100]}", f"Output: {output_text[:100]}"],
            conversation_id=f"autogen-{agent or 'default'}",
        )

    def get_relevant(self, query: str, n_results: int = 5) -> List[str]:
        """Retrieve relevant learned facts for context injection."""
        results = self.prism.search(query, limit=n_results)
        return [r.entry.summary for r in results]

    def clear(self) -> None:
        """No-op — Prism is append-only."""
        pass

    def __repr__(self) -> str:
        return f"PrismAutoGenMemory(project='{self.prism.project}')"
