"""
LangChain Memory Adapter for Prism.

Implements LangChain's BaseMemory interface so Prism can be used
as the memory backend for any LangChain chain or agent.

Usage:
    from prism_memory import PrismLangChainMemory
    from langchain.chains import ConversationChain

    memory = PrismLangChainMemory(project="my-project")
    chain = ConversationChain(llm=llm, memory=memory)
"""

from typing import Any, Dict, List, Optional
from .core import PrismMemory


class PrismLangChainMemory:
    """
    LangChain-compatible memory backed by Prism.

    Implements the BaseMemory interface pattern:
    - memory_variables: list of keys injected into prompts
    - load_memory_variables: retrieves relevant context
    - save_context: persists conversation turns
    - clear: resets memory state

    Can be used with ConversationChain, AgentExecutor, or any
    LangChain component that accepts a memory parameter.
    """

    memory_key: str = "history"
    input_key: str = "input"
    output_key: str = "output"
    return_messages: bool = False

    def __init__(
        self,
        project: str,
        session_id: Optional[str] = None,
        k: int = 5,
        **kwargs: Any,
    ):
        """
        Args:
            project: Prism project identifier
            session_id: Optional conversation session ID
            k: Number of recent memories to load for context
        """
        self.prism = PrismMemory(project=project, **kwargs)
        self.session_id = session_id or f"langchain-{project}"
        self.k = k
        self._buffer: List[Dict[str, str]] = []

    @property
    def memory_variables(self) -> List[str]:
        """Keys this memory injects into the prompt."""
        return [self.memory_key]

    def load_memory_variables(self, inputs: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Load relevant memories for the current conversation context.

        If inputs contain a query, search semantically. Otherwise,
        return recent conversation history from the buffer.
        """
        if inputs and self.input_key in inputs:
            query = inputs[self.input_key]
            results = self.prism.search(query, limit=self.k)
            summaries = [r.entry.summary for r in results if r.entry.summary]

            if self.return_messages:
                return {self.memory_key: [
                    {"role": "system", "content": s} for s in summaries
                ]}
            return {self.memory_key: "\n\n".join(summaries)}

        # Fallback: return buffer
        if self.return_messages:
            return {self.memory_key: list(self._buffer[-self.k:])}
        buffer_text = "\n".join(
            f"Human: {m.get('input', '')}\nAI: {m.get('output', '')}"
            for m in self._buffer[-self.k:]
        )
        return {self.memory_key: buffer_text}

    def save_context(self, inputs: Dict[str, Any], outputs: Dict[str, str]) -> None:
        """
        Save a conversation turn to both local buffer and Prism.
        """
        human_input = inputs.get(self.input_key, "")
        ai_output = outputs.get(self.output_key, "")

        self._buffer.append({"input": human_input, "output": ai_output})

        # Auto-save to Prism every 5 turns or on significant content
        if len(self._buffer) % 5 == 0 or len(ai_output) > 500:
            summary = f"Conversation turn {len(self._buffer)}: {human_input[:100]}"
            self.prism.save(
                summary=summary,
                conversation_id=self.session_id,
            )

    def clear(self) -> None:
        """Clear the conversation buffer. Prism ledger entries persist."""
        self._buffer.clear()

    def save_session_summary(self, summary: str, **kwargs: Any) -> None:
        """
        Explicitly save a session summary to Prism.
        Useful at the end of a conversation chain.
        """
        self.prism.save(
            summary=summary,
            conversation_id=self.session_id,
            **kwargs,
        )

    def __repr__(self) -> str:
        return f"PrismLangChainMemory(project='{self.prism.project}', buffer_size={len(self._buffer)})"
