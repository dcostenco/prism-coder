"""
Prism Memory — Python adapter for LangChain, CrewAI, AutoGen, and LlamaIndex.

This package provides framework integrations that bridge Prism's MCP-native
memory system with popular AI agent frameworks, closing the #1 competitive
gap identified vs mem0 and Zep.

Installation:
    pip install prism-memory

Quick Start:
    from prism_memory import PrismMemory

    memory = PrismMemory(project="my-project")
    memory.save("Implemented auth using JWT tokens")
    results = memory.search("authentication")
"""

__version__ = "0.1.0"
__all__ = [
    "PrismMemory",
    "PrismLangChainMemory",
    "PrismCrewAIMemory",
    "PrismAutoGenMemory",
    "PrismLlamaIndexMemory",
]

from .core import PrismMemory
from .langchain_adapter import PrismLangChainMemory
from .crewai_adapter import PrismCrewAIMemory
from .autogen_adapter import PrismAutoGenMemory
from .llamaindex_adapter import PrismLlamaIndexMemory
