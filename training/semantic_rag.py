#!/usr/bin/env python3
"""
Semantic RAG for Tool Selection (R5-4)

Generates and retrieves tool embeddings for Top-K injection.
Instead of passing ALL tools in the system prompt (2000+ tokens),
retrieve only the 5 most relevant tools per query (~300 tokens).

Usage:
    # Generate embeddings (one-time)
    python semantic_rag.py generate

    # Retrieve top-5 tools for a query
    python semantic_rag.py retrieve "Load my project context"

    # Test retrieval accuracy
    python semantic_rag.py test "Load context for my project"
"""
import json
import math
import os
import sys
import urllib.request

TOOL_SCHEMA_PATH = os.environ.get(
    "PRISM_TOOL_SCHEMA_PATH",
    os.path.join(os.path.dirname(__file__), "data", "tool_schema.json")
)
EMBEDDINGS_PATH = os.environ.get(
    "PRISM_EMBEDDINGS_PATH",
    os.path.join(os.path.dirname(__file__), "data", "tool_embeddings.json")
)
OLLAMA_EMBEDDING_MODEL = os.environ.get("PRISM_EMBED_MODEL", "nomic-embed-text")
OLLAMA_API = os.environ.get("OLLAMA_HOST", "http://localhost:11434")


def get_embedding(text: str) -> list:
    """Get embedding vector from Ollama nomic-embed-text."""
    req = urllib.request.Request(
        f"{OLLAMA_API}/api/embeddings",
        data=json.dumps({"model": OLLAMA_EMBEDDING_MODEL, "prompt": text}).encode('utf-8'),
        headers={'Content-Type': 'application/json'}
    )
    try:
        res = urllib.request.urlopen(req, timeout=30)
        return json.loads(res.read().decode('utf-8'))['embedding']
    except Exception as e:
        print(f"Error getting embedding: {e}")
        return None


def cosine_similarity(a: list, b: list) -> float:
    """Compute cosine similarity between two vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a < 1e-8 or norm_b < 1e-8:
        return 0.0
    return dot / (norm_a * norm_b)


def generate_embeddings():
    """Generate and save Nomic embeddings for all MCP tools."""
    print("Generating Nomic embeddings for MCP tools...")

    if not os.path.exists(TOOL_SCHEMA_PATH):
        print(f"ERROR: Tool schema not found at {TOOL_SCHEMA_PATH}")
        print("Create data/tool_schema.json with your tool definitions first.")
        return

    with open(TOOL_SCHEMA_PATH, "r") as f:
        schema = json.load(f)

    tools = schema.get("tools", [])
    print(f"Found {len(tools)} tools.")

    embeddings = {}
    for t in tools:
        name = t["name"]
        desc = t.get("description", "")
        # Include param names in embedding text for better matching
        params = t.get("parameters", {}).get("properties", {})
        param_text = ", ".join(params.keys()) if params else ""
        embed_text = f"{name}: {desc}. Parameters: {param_text}"

        print(f"  Embedding: {name}")
        emb = get_embedding(embed_text)
        if emb:
            embeddings[name] = {
                "schema": t,
                "embedding": emb,
                "embed_text": embed_text,
            }

    os.makedirs(os.path.dirname(EMBEDDINGS_PATH), exist_ok=True)
    with open(EMBEDDINGS_PATH, "w") as f:
        json.dump(embeddings, f, indent=2)

    print(f"Saved {len(embeddings)} embeddings to {EMBEDDINGS_PATH}")


# =============================================================================
# R6-4: HyDE (Hypothetical Document Embeddings) for Tool RAG
# =============================================================================

# Precomputed hypothetical user queries per tool (no LLM needed at runtime)
HYDE_QUERIES = {
    # Session management
    "session_load_context": [
        "load my project", "show me where I left off", "resume previous work",
        "what was I doing last time", "get my session context", "start from last save",
    ],
    "session_save_ledger": [
        "save what I did today", "log this session", "record my work",
        "write a session summary", "commit progress notes",
    ],
    "session_save_handoff": [
        "create handoff for next session", "save state for later",
        "write handoff notes", "prepare for next agent session",
    ],
    # Memory / Knowledge
    "knowledge_search": [
        "find past insights", "search curated knowledge", "look up graduated memories",
        "what do I know about this topic", "search accumulated wisdom",
        "search documentation", "search knowledge base", "what do we know about",
        "accumulated documentation", "institutional knowledge about",
        "best practices for", "search our docs",
    ],
    "session_search_memory": [
        "search my memories", "find similar sessions", "semantic memory search",
        "look for related past work", "find sessions about this",
        "search past sessions", "what did we work on", "find the session where",
        "look up past work", "what was decided about", "search session history",
    ],
    "knowledge_forget": [
        "delete old memories", "forget irrelevant entries", "clean up knowledge base",
        "remove outdated information", "prune stale sessions",
        "clear out knowledge entries", "purge stale knowledge", "wipe knowledge",
        "forget all knowledge entries", "clear old knowledge",
    ],
    "session_compact_ledger": [
        "my session history is too long", "clean up old logs",
        "archive older entries", "compact the ledger", "summarize old sessions",
    ],
    # Search (R6.1-fix: keys must match V4_API_SCHEMAS in config.py)
    "web_search": [
        "search the internet", "google this for me", "find information online",
        "web search for", "look this up on the web",
    ],
    "web_scrape": [
        "scrape this page", "extract content from URL",
        "get the text from this website", "read this web page",
    ],
    # Memory operations
    "knowledge_upvote": [
        "mark this as important", "upvote this memory", "promote this insight",
        "this was really useful", "increase importance of this entry",
    ],
    "knowledge_downvote": [
        "this isn't useful", "downvote this memory", "decrease importance",
        "this entry is wrong", "demote this insight",
        "downvote the stale entry", "mark as not useful",
    ],
    "session_forget_memory": [
        "delete this specific memory", "remove this entry", "erase this record",
        "forget this particular session", "GDPR delete request",
        "delete memory entry", "remove memory by ID", "purge this memory",
        "get rid of that memory", "delete that specific memory entry",
    ],
    "session_save_experience": [
        "record a successful experience", "log this learning",
        "save this experience", "record a lesson learned",
        "log a success event", "save what I learned",
        "record this outcome", "log experience",
    ],
    "knowledge_set_retention": [
        "set retention policy", "configure retention days",
        "set knowledge expiry", "retention period for knowledge",
        "how long to keep knowledge", "set TTL for knowledge",
    ],
    # Health & maintenance
    "session_health_check": [
        "check memory health", "run diagnostics", "is my database okay",
        "check for problems", "scan for issues in memory",
        "health check", "run a health check", "health check on the memory backend",
        "is the memory system healthy", "verify the memory backend is working",
        "memory health", "system health check", "status check",
    ],
    "session_export_memory": [
        "export my data", "download my memories", "backup everything",
        "data portability export", "save all data to file",
        "export memory", "export all memory", "export memories to file",
        "dump session data", "back up memory", "export to JSON",
        "export the project memory", "backup memory to disk",
    ],
    # Task routing
    "session_task_route": [
        "should I use local or cloud model", "route this task",
        "which model should handle this", "analyze task complexity",
    ],
}

HYDE_EMBEDDINGS_PATH = os.environ.get(
    "PRISM_HYDE_EMBEDDINGS_PATH",
    os.path.join(os.path.dirname(__file__), "data", "hyde_embeddings.json")
)


def generate_hyde_embeddings():
    """R6-4: Generate HyDE embeddings for all tools.
    
    For each tool, embeds the tool description AND all hypothetical user queries.
    At retrieval time, matching against hypothetical queries dramatically
    improves recall when users describe problems, not tool names.
    """
    print("Generating HyDE embeddings for MCP tools...")
    
    if not os.path.exists(TOOL_SCHEMA_PATH):
        print(f"ERROR: Tool schema not found at {TOOL_SCHEMA_PATH}")
        return
    
    with open(TOOL_SCHEMA_PATH, "r") as f:
        schema = json.load(f)
    
    tools = schema.get("tools", [])
    print(f"Found {len(tools)} tools, {len(HYDE_QUERIES)} have HyDE queries.")
    
    embeddings = {}
    for t in tools:
        name = t["name"]
        desc = t.get("description", "")
        params = t.get("parameters", {}).get("properties", {})
        param_text = ", ".join(params.keys()) if params else ""
        
        # Standard tool description embedding
        embed_text = f"{name}: {desc}. Parameters: {param_text}"
        tool_emb = get_embedding(embed_text)
        if not tool_emb:
            continue
        
        # HyDE: Embed all hypothetical queries
        hyde_embs = []
        if name in HYDE_QUERIES:
            for hq in HYDE_QUERIES[name]:
                hq_emb = get_embedding(hq)
                if hq_emb:
                    hyde_embs.append(hq_emb)
        
        embeddings[name] = {
            "schema": t,
            "embedding": tool_emb,
            "embed_text": embed_text,
            "hyde_embeddings": hyde_embs,
        }
        
        print(f"  {name}: description + {len(hyde_embs)} HyDE queries")
    
    os.makedirs(os.path.dirname(HYDE_EMBEDDINGS_PATH), exist_ok=True)
    with open(HYDE_EMBEDDINGS_PATH, "w") as f:
        json.dump(embeddings, f, indent=2)
    
    print(f"Saved {len(embeddings)} HyDE embeddings to {HYDE_EMBEDDINGS_PATH}")


KEYWORD_BOOST = {
    "health check": ["session_health_check"],
    "health": ["session_health_check"],
    "diagnostics": ["session_health_check"],
    "status check": ["session_health_check"],
    "export": ["session_export_memory"],
    "backup": ["session_export_memory"],
    "dump": ["session_export_memory"],
    "retention": ["knowledge_set_retention"],
    "ttl": ["knowledge_set_retention"],
    "experience": ["session_save_experience"],
    "lesson": ["session_save_experience"],
    "learning": ["session_save_experience"],
    "downvote": ["knowledge_downvote"],
    "upvote": ["knowledge_upvote"],
    "compact": ["session_compact_ledger"],
    "purge knowledge": ["knowledge_forget"],
    "clear knowledge": ["knowledge_forget"],
    "forget knowledge": ["knowledge_forget"],
    "record this": ["session_save_ledger"],
    "record this session": ["session_save_ledger"],
    "log this session": ["session_save_ledger"],
    "log today": ["session_save_ledger"],
    "save the handoff": ["session_save_handoff"],
    "handoff": ["session_save_handoff"],
    "search for what": ["session_search_memory"],
    "search for past": ["session_search_memory"],
    "what we decided": ["session_search_memory"],
    "save": ["session_save_ledger"],
    "search for": ["session_search_memory", "knowledge_search"],
    "then search": ["session_search_memory"],
    "then log": ["session_save_experience"],
    "successfully": ["session_save_experience"],
    "deployed": ["session_save_experience"],
    "then save a handoff": ["session_save_handoff"],
    "then save the handoff": ["session_save_handoff"],
}


def retrieve_top_k_hyde(query: str, k: int = 7) -> list:
    """R6-4: HyDE-enhanced retrieval — matches against hypothetical user queries.

    For each tool, computes similarity against BOTH the tool description
    AND all hypothetical user queries, taking the MAX score.
    This bridges the vocabulary gap between user problems and tool names.

    R8-fix: Keyword boost injects tools that MUST appear when trigger words match.
    """
    # Try HyDE embeddings first, fall back to standard
    hyde_path = HYDE_EMBEDDINGS_PATH
    if os.path.exists(hyde_path):
        with open(hyde_path, "r") as f:
            embeddings = json.load(f)
    else:
        return retrieve_top_k(query, k)

    query_emb = get_embedding(query)
    if not query_emb:
        return []

    # Keyword boost: identify tools that MUST appear in results
    query_lower = query.lower()
    boosted_tools = set()
    for keyword, tools in KEYWORD_BOOST.items():
        if keyword in query_lower:
            boosted_tools.update(tools)

    scores = []
    for tool_name, data in embeddings.items():
        # Score against tool description
        desc_sim = cosine_similarity(query_emb, data["embedding"])

        # Score against all HyDE queries, take MAX
        hyde_sims = [
            cosine_similarity(query_emb, he)
            for he in data.get("hyde_embeddings", [])
        ]
        max_hyde = max(hyde_sims) if hyde_sims else 0.0

        # Combined score: max of description and HyDE queries
        best_sim = max(desc_sim, max_hyde)

        # Keyword boost: push boosted tools to top
        if tool_name in boosted_tools:
            best_sim = max(best_sim, 0.95)

        scores.append((best_sim, tool_name, data["schema"]))

    scores.sort(key=lambda x: x[0], reverse=True)

    results = []
    for sim, name, schema in scores[:k]:
        results.append(schema)
        print(f"  HyDE-RAG: {name} (sim={sim:.4f})")

    return results


def load_embeddings() -> dict:
    """Load precomputed tool embeddings."""
    if not os.path.exists(EMBEDDINGS_PATH):
        print(f"WARNING: No embeddings at {EMBEDDINGS_PATH}. Run 'python semantic_rag.py generate' first.")
        return {}
    with open(EMBEDDINGS_PATH, "r") as f:
        return json.load(f)


def retrieve_top_k(query: str, k: int = 5) -> list:
    """R5-4: Retrieve the top-k most relevant tools for a query.

    Args:
        query: User's natural language query.
        k: Number of tools to return (default 5).

    Returns:
        List of tool schema dicts sorted by relevance (highest first).
    """
    embeddings = load_embeddings()
    if not embeddings:
        return []

    query_emb = get_embedding(query)
    if not query_emb:
        return []

    # Score all tools
    scores = []
    for tool_name, data in embeddings.items():
        sim = cosine_similarity(query_emb, data["embedding"])
        scores.append((sim, tool_name, data["schema"]))

    # Sort by similarity descending
    scores.sort(key=lambda x: x[0], reverse=True)

    # Return top-k schemas
    results = []
    for sim, name, schema in scores[:k]:
        results.append(schema)
        print(f"  RAG: {name} (sim={sim:.4f})")

    return results


# R6.4-fix: Module-level cache for fallback schema (avoids 80+ disk reads)
_FALLBACK_SCHEMA_CACHE = None

def build_rag_system_prompt(query: str, k: int = 7, use_hyde: bool = True, **kwargs) -> str:
    """Build a system prompt with only the top-k relevant tools.

    R6-4: Prefers HyDE retrieval for better accuracy.
    Falls back to standard retrieval if HyDE embeddings unavailable.
    R6.4-fix: Forwards **kwargs (e.g. bfcl_eval_mode=True) to format_system_prompt.
    """
    global _FALLBACK_SCHEMA_CACHE
    from config import format_system_prompt

    # R9-fix: Dual-RAG for multi-step queries — split on "then"/"and then" and
    # union tools from both halves to ensure step-2 tools are available
    import re
    multi_step_split = re.split(r'\b(?:then|and then|after that)\b', query, maxsplit=1)
    if len(multi_step_split) == 2 and len(multi_step_split[1].strip()) > 5:
        step1_query = multi_step_split[0].strip()
        step2_query = multi_step_split[1].strip()
        if use_hyde:
            tools_1 = retrieve_top_k_hyde(step1_query, k=k)
            tools_2 = retrieve_top_k_hyde(step2_query, k=4)
        else:
            tools_1 = retrieve_top_k(step1_query, k=k)
            tools_2 = retrieve_top_k(step2_query, k=4)
        seen = {t['name'] for t in tools_1}
        tools = list(tools_1)
        for t in tools_2:
            if t['name'] not in seen:
                tools.append(t)
                seen.add(t['name'])
    elif use_hyde:
        tools = retrieve_top_k_hyde(query, k=k)
    else:
        tools = retrieve_top_k(query, k=k)
    if not tools:
        # R6.3-fix: Fallback to full tool registry loaded from schema file
        # R6.4-fix: Cached to avoid repeated disk I/O (80+ calls per eval run)
        print("WARNING: RAG retrieval returned no tools. Falling back to full tool registry.")
        if _FALLBACK_SCHEMA_CACHE is None:
            try:
                _schema_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "tool_schema.json")
                with open(_schema_path) as _sf:
                    _FALLBACK_SCHEMA_CACHE = json.load(_sf).get("tools", [])
            except (FileNotFoundError, json.JSONDecodeError):
                _FALLBACK_SCHEMA_CACHE = []
        tools = _FALLBACK_SCHEMA_CACHE
    return format_system_prompt(tools, **kwargs)


def test_retrieval(query: str):
    """Test retrieval accuracy for a query."""
    print(f"\nQuery: {query}")
    print("-" * 50)
    tools = retrieve_top_k(query, k=5)
    print(f"\nRetrieved {len(tools)} tools:")
    for i, t in enumerate(tools):
        print(f"  {i+1}. {t['name']}: {t.get('description', '')[:80]}...")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python semantic_rag.py generate       # Generate standard embeddings")
        print("  python semantic_rag.py hyde            # Generate HyDE embeddings (R6-4)")
        print("  python semantic_rag.py retrieve 'query'  # Retrieve top-5 tools")
        print("  python semantic_rag.py hyde-retrieve 'query'  # HyDE-enhanced retrieval")
        print("  python semantic_rag.py test 'query'      # Test retrieval")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "generate":
        generate_embeddings()
    elif cmd == "hyde":
        generate_hyde_embeddings()
    elif cmd in ("retrieve", "test", "hyde-retrieve"):
        if len(sys.argv) < 3:
            print("ERROR: Provide a query string.")
            sys.exit(1)
        query = " ".join(sys.argv[2:])
        if cmd == "retrieve":
            tools = retrieve_top_k(query)
            print(json.dumps([t["name"] for t in tools], indent=2))
        elif cmd == "hyde-retrieve":
            tools = retrieve_top_k_hyde(query)
            print(json.dumps([t["name"] for t in tools], indent=2))
        else:
            test_retrieval(query)
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
