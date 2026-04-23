#!/usr/bin/env python3
"""
GRPO (Group Relative Policy Optimization) for tool-use accuracy.
Uses deterministic reward function — no reward model needed.

v2.0 Fixes:
  - Normalized reward range to [-1.0, +1.0] to prevent gradient explosion
  - Reduced data repetition from 50x to 5x (anti-overfitting)
  - Added subprocess error handling with SFT fallback
  - Restored reward function verification block
  - Synthetic injection is now optional (use --synthetic flag)
  - Moderate learning rate (1e-5) to prevent catastrophic forgetting
"""
import json
import os
import sys
import subprocess
import re
import shutil

MODEL_PATH = "/Users/admin/prism/training/models/qwen-7b-mlx"
SFT_ADAPTER = "/Users/admin/prism/training/models/prism-sft-lora"
TOOL_SCHEMA = "/Users/admin/prism/training/data/tool_schema.json"
OUTPUT_ADAPTER = "/Users/admin/prism/training/models/prism-grpo-lora"
GRPO_DATA = "/Users/admin/prism/training/data/grpo_prompts.jsonl"

# Load valid tool names from schema
with open(TOOL_SCHEMA) as f:
    VALID_TOOLS = {t["name"] for t in json.load(f)["tools"]}

TOOL_PARAMS = {}
with open(TOOL_SCHEMA) as f:
    for t in json.load(f)["tools"]:
        TOOL_PARAMS[t["name"]] = {
            "required": set(t["parameters"].get("required", [])),
            "optional": set(t["parameters"]["properties"].keys()) - set(t["parameters"].get("required", []))
        }


def compute_reward(response_text: str) -> float:
    """
    Deterministic reward function for tool-use accuracy.
    Rewards <think> + <tool_call> structure with normalized output in [-1.0, +1.0].

    Scoring (raw, then normalized):
      Structure:
        +3.0  if response starts with <think>
        -1.0  if missing <think> opener
        +4.0  if <tool_call> + </tool_call> tags present
      Reasoning:
        +1.0  if <think> block >50 chars (substantive thought)
        +0.5  if think mentions "tool"/"requires" (strategy-oriented)
        -0.2  if <think> block >1000 chars (anti-thought-farming)
      Tool correctness:
        +1.0  if JSON parses correctly
        +2.0  if tool_name is valid
        -4.0  if tool_name is hallucinated
        +2.0  if all required params present
        -2.0  per missing required param
      No tool needed:
        +0.0  if response is >20 chars (reasonable prose)
        -0.5  if response is very short (<20 chars)

    Max raw = +13.5, min raw = -7.0. Normalized to [-1.0, +1.0].
    """
    RAW_MAX = 13.5
    RAW_MIN = -7.0

    reward = 0.0

    # ── Structural Reward ──
    if response_text.strip().startswith('<think>'):
        reward += 3.0
    else:
        reward -= 1.0

    if '<tool_call>' in response_text and '</tool_call>' in response_text:
        reward += 4.0

    # ── Format penalty: wrong tags (base model instinct leak) ──
    WRONG_TAGS = ['<search>', '<response>', '<result>', '<|im_start|>tool']
    for tag in WRONG_TAGS:
        if tag in response_text:
            reward -= 3.0  # Strong negative to override base model instinct

    # ── CoT reasoning reward ──
    think_match = re.search(r'<think>(.*?)</think>', response_text, re.DOTALL)
    if think_match:
        think_text = think_match.group(1).strip()
        if len(think_text) > 50:
            reward += 1.0  # Substantive reasoning
        if "tool" in think_text.lower() or "requires" in think_text.lower():
            reward += 0.5  # Strategy-oriented thought
        if len(think_text) > 1000:
            reward -= 0.2  # Anti-thought-farming

    # Check if response contains a tool call (multiple format support)
    tool_content = None
    # 1. <tool_call> tags (canonical)
    tool_match = re.search(r'<tool_call>\s*(.*?)\s*</tool_call>', response_text, re.DOTALL)
    if tool_match:
        tool_content = tool_match.group(1)
    # 2. <|im_start|>...<|im_end|> (Qwen native)
    if not tool_content:
        im_match = re.search(r'<\|im_start\|>\s*(\{.*?\})\s*<\|im_end\|>', response_text, re.DOTALL)
        if im_match:
            tool_content = im_match.group(1)

    if not tool_content:
        # No tool call — acceptable for reasoning-only prompts
        reward += (0.0 if len(response_text) > 20 else -0.5)
        return max(-1.0, min(1.0, (reward - RAW_MIN) / (RAW_MAX - RAW_MIN) * 2 - 1))

    try:
        tool_call = json.loads(tool_content)
        reward += 1.0  # Valid JSON
    except json.JSONDecodeError:
        reward -= 3.0
        return max(-1.0, min(1.0, (reward - RAW_MIN) / (RAW_MAX - RAW_MIN) * 2 - 1))

    tool_name = tool_call.get("name", "")
    if tool_name in VALID_TOOLS:
        reward += 2.0
    else:
        reward -= 4.0
        return max(-1.0, min(1.0, (reward - RAW_MIN) / (RAW_MAX - RAW_MIN) * 2 - 1))

    args = tool_call.get("arguments", {})
    params = TOOL_PARAMS.get(tool_name, {"required": set(), "optional": set()})

    missing_required = params["required"] - set(args.keys())
    if not missing_required:
        reward += 2.0
    else:
        reward -= 2.0 * len(missing_required)

    # Normalize to [-1.0, +1.0]
    return max(-1.0, min(1.0, (reward - RAW_MIN) / (RAW_MAX - RAW_MIN) * 2 - 1))


# ─── System prompt (MUST match Modelfile exactly) ──────────────────────
SYSTEM_PROMPT = """You are Prism, an AI coding assistant with persistent memory across sessions.
You have access to MCP tools for session management, knowledge retrieval, and project context.
When users ask about project history, decisions, stored context, or need to save work, use the appropriate tool.
When users ask general coding questions, answer directly without using tools.

CRITICAL: You MUST use <tool_call> tags for ALL tool invocations. Do NOT use <search>, <response>, <result>, or any other tags. Only <tool_call> and </tool_call>.

Available MCP tools:
- session_load_context: Load full project context (required: project, optional: level)
- session_save: Save session summary with decisions/TODOs (required: project, summary)
- session_search: Search session history (required: query, optional: project, limit)
- session_list: List recent sessions (optional: project, limit)
- session_delete: Soft-delete a session (required: id, optional: reason)
- knowledge_save: Store a knowledge concept (required: project, concept, description)
- knowledge_search: Search knowledge base (required: query, optional: project)
- memory_link: Link memory entries (required: source_id, target_id, relation)
- session_handoff: Agent-to-agent handoff (required: project, from_agent, to_agent, summary)
- session_task_route: Route task to local/cloud (required: task_description)

Format tool calls EXACTLY as:
<think>
[your reasoning about which tool to use and why]
</think>

<tool_call>
{"name": "tool_name", "arguments": {"param": "value"}}
</tool_call>"""


def generate_grpo_prompts():
    """Generate 150 diverse prompts for GRPO training — 10 tools + reasoning + edges."""
    prompts = [
        # ── session_load_context (15 prompts) ──
        "Load the full context for the prism-mcp project",
        "Initialize a deep session for project synalux-docs",
        "What's the current state of the bcba-private project?",
        "Restore context for synalux-portal",
        "Open the prism project and show me what we were working on",
        "Boot up the session for project synalux-elite",
        "Give me a quick overview of the prism-mcp project state",
        "Start a new session for synalux-portal with full context",
        "Load shallow context for bcba-private to check TODOs",
        "Resume where we left off on synalux-docs",
        "Pull up the project state for prism-mcp",
        "I need the latest context for the portal project",
        "What were we doing last time on synalux-elite?",
        "Fetch the deep session state for bcba-private",
        "Show project context for synalux-portal at the standard level",

        # ── session_save (15 prompts) ──
        "Save this session: implemented RBAC roles",
        "Record this work: migrated Stripe webhooks to v2 API",
        "Log work: fixed the abortPipeline syntax error in dashboard",
        "Save progress: added form validation to intake flow",
        "Commit this session: refactored billing page to use server actions",
        "Record what we did: upgraded Next.js to v15 and fixed hydration errors",
        "Save this: implemented the multi-tenant RLS policies for Supabase",
        "Log session: debugged OAuth2 token refresh race condition",
        "Save work: created the GRPO training pipeline for prism-coder",
        "Record progress on synalux-portal: fixed the team invitation workflow",
        "Save this session: resolved the streaming memory leak in Prism agent",
        "Log this: added CSS animations for form transitions",
        "Save progress: deployed edge functions for real-time notifications",
        "Persist this work: migrated database schema from v9 to v10",
        "Record this session: built the automated test suite for billing",

        # ── session_search (12 prompts) ──
        "Search for sessions about JWT authentication in synalux-private",
        "Find past work on the schema migration in v9.4",
        "Search session history for OAuth refresh token implementations",
        "Find sessions where we worked on Supabase RLS policies",
        "Look through session history for database migration work",
        "Search for any work done on the billing integration",
        "Find sessions related to the HIPAA compliance audit",
        "Search past sessions for Stripe webhook debugging",
        "Look up sessions about the WebSocket connection issues",
        "Find work related to the team management feature",
        "Search for sessions mentioning the deployment pipeline",
        "Find past debugging sessions for the memory leak",

        # ── session_list (12 prompts) ──
        "List all sessions for project bcba-private",
        "Show all sessions for synalux-docs project",
        "Show me the recent sessions for prism-mcp",
        "List the last 5 sessions for synalux-portal",
        "What sessions do we have for the bcba-private project?",
        "Show session history for synalux-elite",
        "Display all recent sessions across all projects",
        "List the latest 10 sessions for prism-mcp",
        "What work has been logged for synalux-portal recently?",
        "Show me the session log for bcba-private",
        "List recent activity on the synalux-docs project",
        "Get the session timeline for prism-mcp",

        # ── session_delete (12 prompts) ──
        "Delete the session from yesterday about the billing bug",
        "Remove the last session for synalux-portal, it was a test",
        "Delete session abc-123-def, it has incorrect information",
        "Remove the duplicate session from the prism-mcp project",
        "Clean up the test session I created earlier",
        "Delete the session about the failed experiment with Redis",
        "Remove session xyz-789, it was saved by mistake",
        "Delete the outdated session about the old API endpoints",
        "Clean up the abandoned session from last week",
        "Remove the incorrect session about the database rollback",
        "Delete session id e4f5a6b7, the information is wrong",
        "Purge the old test sessions from bcba-private",

        # ── knowledge_save (12 prompts) ──
        "Store this knowledge: The ACT-R decay rate is 0.5 for rollup nodes",
        "Remember this: Supabase RLS requires a JWT with the role claim",
        "Save this fact: The Prism agent uses a 3-tier search strategy",
        "Store: Edge functions have a 10-second timeout on the free plan",
        "Remember: The billing module requires Stripe API v2023-10-16",
        "Save this knowledge: GGUF Q4_K_M is the optimal quantization for 7B models on Apple Silicon",
        "Store the principle: Always use session_search before session_load_context for targeted lookups",
        "Remember this pattern: Use CRDT merge for concurrent handoff updates",
        "Save this: The TurboQuant compressed embeddings maintain 95%+ search accuracy",
        "Store: MCP tool calls must use <tool_call> tags, never <search> tags",
        "Remember: The ollama run context window is 8192 tokens for prism-coder",
        "Save this knowledge: Synalux forms use dynamic routing at /module/form and /team/project/form",

        # ── knowledge_search (12 prompts) ──
        "What do we know about the Zero-Search architecture in prism?",
        "What do we know about edge function cold starts?",
        "Search knowledge for patterns about memory consolidation",
        "What principles have we stored about database indexing?",
        "Find knowledge about the GRPO training parameters",
        "What do we know about the Supabase RLS setup?",
        "Search for stored knowledge about billing integration",
        "What patterns do we have for error handling?",
        "Look up knowledge about the agent handoff protocol",
        "What do we know about the TurboQuant embedding system?",
        "Search knowledge base for OAuth2 best practices",
        "Find stored principles about API rate limiting",

        # ── memory_link (12 prompts) ──
        "Connect the RBAC session to the auth session as related",
        "Link the billing fix session to the Stripe webhook session",
        "Connect memory entry abc-123 to def-456 as a dependency",
        "Create a link between the schema migration and the RLS policy sessions",
        "Associate the GRPO training session with the benchmark results session",
        "Link the OAuth session to the JWT knowledge entry as reference",
        "Connect the deployment session to the CI/CD pipeline session",
        "Create a causal link from the database migration to the schema fix",
        "Link the error handling pattern to the edge function timeout session",
        "Associate entry id-111 with entry id-222 as related work",
        "Connect the agent architecture session to the handoff protocol session",
        "Create a reference link between the billing module and payment processor sessions",

        # ── session_handoff (12 prompts) ──
        "Hand off the billing task from dev to security: payment logic is ready",
        "Transfer the frontend task from the dev agent to the QA agent",
        "Pass the API review from the backend agent to the security agent",
        "Hand off the deployment to the DevOps agent: code is merged and tested",
        "Transfer the database migration task from dev to DBA agent",
        "Hand off CSS styling work from the dev agent to the design agent",
        "Pass the unit testing work from dev to the QA agent for review",
        "Transfer the documentation task from dev to the docs agent",
        "Hand off the performance optimization from dev to the infrastructure agent",
        "Transfer the auth module from the security agent back to the dev agent",
        "Pass the billing integration from dev to the finance agent for validation",
        "Hand off the completed API endpoints from backend to frontend agent",

        # ── session_task_route (12 prompts) ──
        "Should the local agent or the cloud agent handle this CSS fix?",
        "Route this task: refactor the authentication middleware",
        "Where should we run the benchmark suite — local or cloud?",
        "Route: implement a new form validation component",
        "Should I handle this TypeScript compilation error locally?",
        "Route this: add dark mode toggle to the settings page",
        "Where should we process the large dataset migration?",
        "Route: fix the responsive layout issue on mobile",
        "Should the local model handle this code review?",
        "Route this task: write unit tests for the billing module",
        "Where should we run the full integration test suite?",
        "Route: generate API documentation from TypeScript types",

        # ── Reasoning (no tool) — 20 prompts ──
        "Explain how React Server Components work",
        "Write a hello world in Python",
        "What is the difference between REST and GraphQL?",
        "How does garbage collection work in Go?",
        "Explain the CAP theorem in simple terms",
        "Write a bash one-liner to find large files",
        "What are the trade-offs between SQL and NoSQL databases?",
        "Explain how JWT tokens work",
        "What is the difference between async and await in JavaScript?",
        "How does CSS grid differ from flexbox?",
        "Explain the SOLID principles in software engineering",
        "What are the pros and cons of microservices?",
        "How does HTTP/2 differ from HTTP/1.1?",
        "Explain what a closure is in JavaScript",
        "How does React's virtual DOM work?",
        "What is the difference between TCP and UDP?",
        "Explain how database indexing improves query performance",
        "What is the difference between a stack and a queue?",
        "How does HTTPS/TLS encryption work?",
        "Explain the observer pattern with an example",

        # ── Edge / Adversarial — 10 prompts ──
        "What is the status of the HIPAA security audit?",
        "Can you search for... actually, just explain what Prism does",
        "Save this and also search for related sessions about billing",
        "I was thinking about searching but I just want to know about React hooks",
        "Load context and then save a summary of what you find",
        "Tell me about the project",
        "Search",
        "Save",
        "What tools do you have?",
        "Help me with my code",
    ]

    with open(GRPO_DATA, "w") as f:
        for prompt in prompts:
            f.write(json.dumps({
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt}
                ]
            }) + "\n")

    print(f"  Generated {len(prompts)} GRPO prompts → {GRPO_DATA}")
    return prompts


# ─── Synthetic Gold Responses ───────────────────────────────────────────

_GOLD_TEMPLATES = {
    "session_load_context": {
        "think": 'The user wants to load project context for "{project}". I should use session_load_context with the project name.',
        "args": lambda p, kw: {"project": kw.get("project", "prism-mcp"), "level": kw.get("level", "standard")},
    },
    "session_save": {
        "think": 'The user wants to save a work session. This is a write operation to the session ledger. I should use session_save with the project and summary.',
        "args": lambda p, kw: {"project": kw.get("project", "prism-mcp"), "summary": kw.get("summary", p)},
    },
    "session_search": {
        "think": 'The user wants to search past sessions. I should use session_search with the relevant query.',
        "args": lambda p, kw: {"query": kw.get("query", p)},
    },
    "session_list": {
        "think": 'The user wants to see a list of recent sessions. I should use session_list.',
        "args": lambda p, kw: {"project": kw.get("project", None), "limit": kw.get("limit", 10)},
    },
    "session_delete": {
        "think": 'The user wants to delete a session. I should use session_delete with the session ID.',
        "args": lambda p, kw: {"id": kw.get("id", "unknown"), "reason": kw.get("reason", "User requested deletion")},
    },
    "knowledge_save": {
        "think": 'The user wants to store a piece of knowledge for future reference. I should use knowledge_save.',
        "args": lambda p, kw: {"project": kw.get("project", "prism"), "concept": kw.get("concept", "stored concept"), "description": kw.get("description", p)},
    },
    "knowledge_search": {
        "think": 'The user wants to find stored knowledge. I should use knowledge_search with the query.',
        "args": lambda p, kw: {"query": kw.get("query", p)},
    },
    "memory_link": {
        "think": 'The user wants to connect two memory entries. I should use memory_link with source and target IDs.',
        "args": lambda p, kw: {"source_id": kw.get("source", "src-id"), "target_id": kw.get("target", "tgt-id"), "relation": kw.get("relation", "related")},
    },
    "session_handoff": {
        "think": 'The user wants to hand off a task from one agent to another. I should use session_handoff with the project, agents, and summary.',
        "args": lambda p, kw: {"project": kw.get("project", "prism-mcp"), "from_agent": kw.get("from", "dev"), "to_agent": kw.get("to", "qa"), "summary": kw.get("summary", p)},
    },
    "session_task_route": {
        "think": 'The user wants to decide whether to run a task locally or in the cloud. I should use session_task_route to evaluate.',
        "args": lambda p, kw: {"task_description": p},
    },
}

# Mapping from prompt keywords → (tool_name, kwargs_overrides)
_PROMPT_TOOL_MAP = [
    # session_load_context
    (["Load", "context", "prism-mcp"], "session_load_context", {"project": "prism-mcp"}),
    (["Initialize", "deep", "synalux-docs"], "session_load_context", {"project": "synalux-docs", "level": "deep"}),
    (["current state", "bcba-private"], "session_load_context", {"project": "bcba-private"}),
    (["Restore", "synalux-portal"], "session_load_context", {"project": "synalux-portal"}),
    (["Open", "prism project"], "session_load_context", {"project": "prism"}),
    (["Boot up", "synalux-elite"], "session_load_context", {"project": "synalux-elite"}),
    (["quick overview", "prism-mcp"], "session_load_context", {"project": "prism-mcp", "level": "quick"}),
    (["Start a new session", "synalux-portal"], "session_load_context", {"project": "synalux-portal"}),
    (["shallow", "bcba-private"], "session_load_context", {"project": "bcba-private", "level": "shallow"}),
    (["Resume", "synalux-docs"], "session_load_context", {"project": "synalux-docs"}),
    (["Pull up", "prism-mcp"], "session_load_context", {"project": "prism-mcp"}),
    (["latest context", "portal"], "session_load_context", {"project": "synalux-portal"}),
    (["last time", "synalux-elite"], "session_load_context", {"project": "synalux-elite"}),
    (["Fetch", "deep", "bcba-private"], "session_load_context", {"project": "bcba-private", "level": "deep"}),
    (["project context", "synalux-portal", "standard"], "session_load_context", {"project": "synalux-portal", "level": "standard"}),

    # session_save
    (["Save", "RBAC"], "session_save", {"project": "prism-mcp", "summary": "implemented RBAC roles"}),
    (["Record", "Stripe webhooks"], "session_save", {"project": "synalux-portal", "summary": "migrated Stripe webhooks to v2 API"}),
    (["Log", "abortPipeline"], "session_save", {"project": "synalux-portal", "summary": "fixed the abortPipeline syntax error in dashboard"}),
    (["Save progress", "form validation"], "session_save", {"project": "synalux-portal", "summary": "added form validation to intake flow"}),
    (["Commit", "billing page"], "session_save", {"project": "synalux-portal", "summary": "refactored billing page to use server actions"}),
    (["Record", "Next.js"], "session_save", {"project": "synalux-portal", "summary": "upgraded Next.js to v15 and fixed hydration errors"}),
    (["Save", "multi-tenant RLS"], "session_save", {"project": "synalux-portal", "summary": "implemented the multi-tenant RLS policies for Supabase"}),
    (["Log session", "OAuth2"], "session_save", {"project": "prism-mcp", "summary": "debugged OAuth2 token refresh race condition"}),
    (["Save work", "GRPO"], "session_save", {"project": "prism-mcp", "summary": "created the GRPO training pipeline for prism-coder"}),
    (["Record progress", "team invitation"], "session_save", {"project": "synalux-portal", "summary": "fixed the team invitation workflow"}),
    (["Save", "streaming memory leak"], "session_save", {"project": "prism-mcp", "summary": "resolved the streaming memory leak in Prism agent"}),
    (["Log", "CSS animations"], "session_save", {"project": "synalux-portal", "summary": "added CSS animations for form transitions"}),
    (["Save progress", "edge functions"], "session_save", {"project": "synalux-portal", "summary": "deployed edge functions for real-time notifications"}),
    (["Persist", "database schema"], "session_save", {"project": "synalux-portal", "summary": "migrated database schema from v9 to v10"}),
    (["Record", "test suite", "billing"], "session_save", {"project": "synalux-portal", "summary": "built the automated test suite for billing"}),

    # session_search
    (["Search", "JWT"], "session_search", {"query": "JWT authentication", "project": "synalux-private"}),
    (["Find", "schema migration", "v9.4"], "session_search", {"query": "schema migration v9.4"}),
    (["Search", "OAuth refresh"], "session_search", {"query": "OAuth refresh token"}),
    (["Find", "Supabase RLS"], "session_search", {"query": "Supabase RLS policies"}),
    (["Look through", "database migration"], "session_search", {"query": "database migration"}),
    (["Search", "billing integration"], "session_search", {"query": "billing integration"}),
    (["Find", "HIPAA compliance"], "session_search", {"query": "HIPAA compliance audit"}),
    (["Search", "Stripe webhook"], "session_search", {"query": "Stripe webhook debugging"}),
    (["Look up", "WebSocket"], "session_search", {"query": "WebSocket connection issues"}),
    (["Find", "team management"], "session_search", {"query": "team management feature"}),
    (["Search", "deployment pipeline"], "session_search", {"query": "deployment pipeline"}),
    (["Find", "memory leak"], "session_search", {"query": "memory leak debugging"}),

    # session_list
    (["List", "bcba-private"], "session_list", {"project": "bcba-private"}),
    (["Show all sessions", "synalux-docs"], "session_list", {"project": "synalux-docs"}),
    (["recent sessions", "prism-mcp"], "session_list", {"project": "prism-mcp"}),
    (["last 5", "synalux-portal"], "session_list", {"project": "synalux-portal", "limit": 5}),
    (["sessions", "bcba-private"], "session_list", {"project": "bcba-private"}),
    (["session history", "synalux-elite"], "session_list", {"project": "synalux-elite"}),
    (["recent sessions", "across all"], "session_list", {}),
    (["latest 10", "prism-mcp"], "session_list", {"project": "prism-mcp", "limit": 10}),
    (["work", "logged", "synalux-portal"], "session_list", {"project": "synalux-portal"}),
    (["session log", "bcba-private"], "session_list", {"project": "bcba-private"}),
    (["recent activity", "synalux-docs"], "session_list", {"project": "synalux-docs"}),
    (["session timeline", "prism-mcp"], "session_list", {"project": "prism-mcp"}),

    # session_delete
    (["Delete", "billing bug"], "session_delete", {"id": "billing-bug-session", "reason": "outdated"}),
    (["Remove", "last session", "test"], "session_delete", {"id": "test-session", "reason": "was a test"}),
    (["Delete session", "abc-123"], "session_delete", {"id": "abc-123-def", "reason": "incorrect information"}),
    (["Remove", "duplicate"], "session_delete", {"id": "duplicate-session", "reason": "duplicate"}),
    (["Clean up", "test session"], "session_delete", {"id": "test-session", "reason": "test cleanup"}),
    (["Delete", "failed experiment", "Redis"], "session_delete", {"id": "redis-experiment", "reason": "failed experiment"}),
    (["Remove session", "xyz-789"], "session_delete", {"id": "xyz-789", "reason": "saved by mistake"}),
    (["Delete", "outdated", "old API"], "session_delete", {"id": "old-api-session", "reason": "outdated"}),
    (["Clean up", "abandoned"], "session_delete", {"id": "abandoned-session", "reason": "abandoned"}),
    (["Remove", "incorrect", "database rollback"], "session_delete", {"id": "rollback-session", "reason": "incorrect info"}),
    (["Delete session", "e4f5a6b7"], "session_delete", {"id": "e4f5a6b7", "reason": "wrong information"}),
    (["Purge", "old test"], "session_delete", {"id": "old-tests", "reason": "cleanup old tests"}),

    # knowledge_save
    (["Store this knowledge", "ACT-R"], "knowledge_save", {"project": "prism", "concept": "ACT-R Decay Rate", "description": "The ACT-R decay rate is 0.5 for rollup nodes"}),
    (["Remember this", "Supabase RLS"], "knowledge_save", {"project": "synalux", "concept": "Supabase RLS JWT", "description": "Supabase RLS requires a JWT with the role claim"}),
    (["Save this fact", "3-tier"], "knowledge_save", {"project": "prism", "concept": "Search Strategy", "description": "The Prism agent uses a 3-tier search strategy"}),
    (["Store", "Edge functions", "10-second"], "knowledge_save", {"project": "synalux", "concept": "Edge Function Timeout", "description": "Edge functions have a 10-second timeout on the free plan"}),
    (["Remember", "billing module", "Stripe"], "knowledge_save", {"project": "synalux", "concept": "Stripe API Version", "description": "The billing module requires Stripe API v2023-10-16"}),
    (["Save", "GGUF", "Q4_K_M"], "knowledge_save", {"project": "prism", "concept": "GGUF Quantization", "description": "GGUF Q4_K_M is the optimal quantization for 7B models on Apple Silicon"}),
    (["Store", "principle", "session_search"], "knowledge_save", {"project": "prism", "concept": "Search Priority", "description": "Always use session_search before session_load_context for targeted lookups"}),
    (["Remember", "CRDT merge"], "knowledge_save", {"project": "prism", "concept": "CRDT Handoff", "description": "Use CRDT merge for concurrent handoff updates"}),
    (["Save", "TurboQuant"], "knowledge_save", {"project": "prism", "concept": "TurboQuant Accuracy", "description": "The TurboQuant compressed embeddings maintain 95%+ search accuracy"}),
    (["Store", "MCP tool", "tool_call"], "knowledge_save", {"project": "prism", "concept": "Tool Call Format", "description": "MCP tool calls must use <tool_call> tags, never <search> tags"}),
    (["Remember", "ollama", "8192"], "knowledge_save", {"project": "prism", "concept": "Context Window", "description": "The ollama run context window is 8192 tokens for prism-coder"}),
    (["Save", "Synalux forms", "dynamic"], "knowledge_save", {"project": "synalux", "concept": "Form Routing", "description": "Synalux forms use dynamic routing at /module/form and /team/project/form"}),

    # knowledge_search
    (["know about", "Zero-Search"], "knowledge_search", {"query": "Zero-Search architecture"}),
    (["know about", "edge function cold"], "knowledge_search", {"query": "edge function cold starts"}),
    (["Search knowledge", "memory consolidation"], "knowledge_search", {"query": "memory consolidation patterns"}),
    (["principles", "database indexing"], "knowledge_search", {"query": "database indexing"}),
    (["knowledge", "GRPO"], "knowledge_search", {"query": "GRPO training parameters"}),
    (["know about", "Supabase RLS"], "knowledge_search", {"query": "Supabase RLS setup"}),
    (["Search", "stored knowledge", "billing"], "knowledge_search", {"query": "billing integration"}),
    (["patterns", "error handling"], "knowledge_search", {"query": "error handling patterns"}),
    (["Look up knowledge", "handoff"], "knowledge_search", {"query": "agent handoff protocol"}),
    (["know about", "TurboQuant"], "knowledge_search", {"query": "TurboQuant embedding system"}),
    (["Search knowledge", "OAuth2"], "knowledge_search", {"query": "OAuth2 best practices"}),
    (["Find", "principles", "rate limiting"], "knowledge_search", {"query": "API rate limiting"}),

    # memory_link
    (["Connect", "RBAC", "auth"], "memory_link", {"source": "rbac-session", "target": "auth-session", "relation": "related"}),
    (["Link", "billing", "Stripe webhook"], "memory_link", {"source": "billing-fix", "target": "stripe-webhook", "relation": "related"}),
    (["Connect", "abc-123", "def-456"], "memory_link", {"source": "abc-123", "target": "def-456", "relation": "dependency"}),
    (["link", "schema migration", "RLS policy"], "memory_link", {"source": "schema-migration", "target": "rls-policy", "relation": "related"}),
    (["Associate", "GRPO", "benchmark"], "memory_link", {"source": "grpo-training", "target": "benchmark-results", "relation": "related"}),
    (["Link", "OAuth", "JWT"], "memory_link", {"source": "oauth-session", "target": "jwt-knowledge", "relation": "reference"}),
    (["Connect", "deployment", "CI/CD"], "memory_link", {"source": "deployment-session", "target": "cicd-session", "relation": "related"}),
    (["causal link", "database migration", "schema fix"], "memory_link", {"source": "db-migration", "target": "schema-fix", "relation": "caused"}),
    (["Link", "error handling", "edge function timeout"], "memory_link", {"source": "error-pattern", "target": "edge-timeout", "relation": "reference"}),
    (["Associate", "id-111", "id-222"], "memory_link", {"source": "id-111", "target": "id-222", "relation": "related"}),
    (["Connect", "agent architecture", "handoff protocol"], "memory_link", {"source": "agent-arch", "target": "handoff-protocol", "relation": "related"}),
    (["reference link", "billing module", "payment processor"], "memory_link", {"source": "billing-module", "target": "payment-processor", "relation": "reference"}),

    # session_handoff
    (["Hand off", "billing", "dev", "security"], "session_handoff", {"project": "synalux-portal", "from": "dev", "to": "security", "summary": "payment logic is ready for security review"}),
    (["Transfer", "frontend", "dev", "QA"], "session_handoff", {"project": "synalux-portal", "from": "dev", "to": "qa", "summary": "frontend task ready for QA testing"}),
    (["Pass", "API review", "backend", "security"], "session_handoff", {"project": "prism-mcp", "from": "backend", "to": "security", "summary": "API review for security audit"}),
    (["Hand off", "deployment", "DevOps"], "session_handoff", {"project": "synalux-portal", "from": "dev", "to": "devops", "summary": "code is merged and tested, ready to deploy"}),
    (["Transfer", "database migration", "DBA"], "session_handoff", {"project": "synalux-portal", "from": "dev", "to": "dba", "summary": "database migration task"}),
    (["Hand off", "CSS styling", "design"], "session_handoff", {"project": "synalux-portal", "from": "dev", "to": "design", "summary": "CSS styling work"}),
    (["Pass", "unit testing", "QA"], "session_handoff", {"project": "prism-mcp", "from": "dev", "to": "qa", "summary": "unit testing ready for review"}),
    (["Transfer", "documentation", "docs"], "session_handoff", {"project": "prism-mcp", "from": "dev", "to": "docs", "summary": "documentation task"}),
    (["Hand off", "performance", "infrastructure"], "session_handoff", {"project": "prism-mcp", "from": "dev", "to": "infra", "summary": "performance optimization"}),
    (["Transfer", "auth module", "security", "dev"], "session_handoff", {"project": "synalux-portal", "from": "security", "to": "dev", "summary": "auth module reviewed, back to dev"}),
    (["Pass", "billing integration", "finance"], "session_handoff", {"project": "synalux-portal", "from": "dev", "to": "finance", "summary": "billing integration for finance validation"}),
    (["Hand off", "API endpoints", "frontend"], "session_handoff", {"project": "prism-mcp", "from": "backend", "to": "frontend", "summary": "completed API endpoints ready for frontend"}),

    # session_task_route
    (["local", "cloud", "CSS fix"], "session_task_route", {}),
    (["Route", "refactor", "authentication"], "session_task_route", {}),
    (["Where", "benchmark suite"], "session_task_route", {}),
    (["Route", "form validation"], "session_task_route", {}),
    (["handle", "TypeScript", "locally"], "session_task_route", {}),
    (["Route", "dark mode"], "session_task_route", {}),
    (["Where", "dataset migration"], "session_task_route", {}),
    (["Route", "responsive layout"], "session_task_route", {}),
    (["local model", "code review"], "session_task_route", {}),
    (["Route", "unit tests", "billing"], "session_task_route", {}),
    (["Where", "integration test"], "session_task_route", {}),
    (["Route", "API documentation"], "session_task_route", {}),
]


def generate_synthetic_chosen(prompt: str) -> str:
    """Generate a perfect gold-standard response for any prompt using template matching."""
    prompt_lower = prompt.lower()

    for keywords, tool_name, kwargs in _PROMPT_TOOL_MAP:
        # Check if ALL keywords appear in the prompt (case-insensitive)
        if all(kw.lower() in prompt_lower for kw in keywords):
            template = _GOLD_TEMPLATES[tool_name]
            think_text = template["think"].format(**{k: v for k, v in kwargs.items() if isinstance(v, str)})
            args = template["args"](prompt, kwargs)
            # Remove None values from args
            args = {k: v for k, v in args.items() if v is not None}
            return f'<think>{think_text}</think>\n\n<tool_call>\n{json.dumps({"name": tool_name, "arguments": args})}\n</tool_call>'

    # Reasoning prompts → no tool call, just a direct answer
    reasoning_indicators = [
        "explain", "what is the difference", "how does", "write a",
        "what are the", "pros and cons", "hello world", "differ from",
        "principles", "pattern with", "encryption", "one-liner", "simple terms"
    ]
    if any(ind in prompt_lower for ind in reasoning_indicators):
        return None  # No gold response for reasoning — model learns to NOT call tools

    return None




def verify_reward_function():
    """Self-test the reward function with known inputs."""
    print("\n" + "=" * 60)
    print("Reward Function Verification:")
    print("=" * 60)

    test_cases = [
        ('<think>The user wants to save a session for project prism-mcp. This is a write operation. The correct tool is session_save which requires project and summary parameters. I have both values from the request.</think>\n\nI\'ll save this.\n\n<tool_call>\n{"name": "session_save", "arguments": {"project": "test", "summary": "test"}}\n</tool_call>', "Valid save WITH think (best case)"),
        ('I\'ll save this.\n\n<tool_call>\n{"name": "session_save", "arguments": {"project": "test", "summary": "test"}}\n</tool_call>', "Valid save (no think)"),
        ('<tool_call>\n{"name": "fake_tool", "arguments": {}}\n</tool_call>', "Hallucinated tool"),
        ('<tool_call>\n{invalid json}\n</tool_call>', "Invalid JSON"),
        ('Python is a programming language used for web development and data science.', "No tool (correct for reasoning)"),
        ('<tool_call>\n{"name": "session_save", "arguments": {}}\n</tool_call>', "Missing required params"),
        ('<think>Short.</think>\n\nJust explaining code.', "Short think + no tool (neutral)"),
        ('<think>Let me think about this question. ' + 'I need to reason carefully. ' * 80 + '</think>\n\n<tool_call>\n{"name": "session_save", "arguments": {"project": "test", "summary": "test"}}\n</tool_call>', "Thought farming (>1000 chars)"),
    ]

    for response, desc in test_cases:
        reward = compute_reward(response)
        print(f"  [{reward:+.3f}] {desc}")

    print("=" * 60)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="GRPO Alignment for Tool-Use Accuracy")
    parser.add_argument("--synthetic", action="store_true", help="Inject synthetic gold-standard responses as chosen side")
    parser.add_argument("--repeat", type=int, default=5, help="Data repetition factor (default: 5)")
    parser.add_argument("--iters", type=int, default=300, help="Training iterations (default: 300)")
    parser.add_argument("--lr", type=float, default=1e-5, help="Learning rate (default: 1e-5)")
    parser.add_argument("--verify-only", action="store_true", help="Only run reward function verification, no training")
    args = parser.parse_args()

    # Always verify reward function first
    verify_reward_function()

    if args.verify_only:
        return

    print("\n" + "=" * 60)
    print("GRPO Alignment for Tool-Use Accuracy")
    print(f"  Synthetic injection: {'ON' if args.synthetic else 'OFF (true GRPO)'}")
    print(f"  Data repetition: {args.repeat}x")
    print(f"  Iterations: {args.iters}")
    print(f"  Learning rate: {args.lr}")
    print("=" * 60)

    prompts = generate_grpo_prompts()
    dpo_data = []

    try:
        from mlx_lm import load, generate
        print("\nLoading SFT model + adapter...")
        model, tokenizer = load(MODEL_PATH, adapter_path=SFT_ADAPTER)

        for i, prompt in enumerate(prompts):
            sys_msg = "You are Prism, an AI coding assistant with persistent memory. Use MCP tools when appropriate."
            full_prompt = f"<|im_start|>system\n{sys_msg}<|im_end|>\n<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n"

            completions = []
            for j in range(4):
                try:
                    response = generate(model, tokenizer, prompt=full_prompt, max_tokens=256)
                    reward = compute_reward(response)
                    print(f"    [Prompt {i+1} Gen {j+1}] Reward: {reward:+.3f} | Response: {response[:60].replace(chr(10), ' ')}...")
                    completions.append((response, reward))
                except Exception as e:
                    print(f"  Warning: Generation failed: {e}")
                    continue

            if len(completions) >= 2:
                completions.sort(key=lambda x: x[1], reverse=True)
                best = completions[0]
                worst = completions[-1]

                if args.synthetic:
                    # Synthetic injection mode: use handcrafted "perfect" responses
                    synthetic_chosen = generate_synthetic_chosen(prompt)
                    if synthetic_chosen:
                        dpo_data.append({
                            "prompt": prompt,
                            "chosen": synthetic_chosen,
                            "rejected": worst[0],
                        })
                        continue

                # True GRPO: use model's own best vs worst
                if best[1] > worst[1]:
                    dpo_data.append({
                        "prompt": prompt,
                        "chosen": best[0],
                        "rejected": worst[0],
                    })

            if (i + 1) % 5 == 0:
                print(f"  Processed {i+1}/{len(prompts)} prompts, {len(dpo_data)} preference pairs")

        print(f"\nGenerated {len(dpo_data)} preference pairs")

        if len(dpo_data) >= 1:
            dpo_train_path = "/Users/admin/prism/training/data/dpo_train.jsonl"
            with open(dpo_train_path, "w") as f:
                for _ in range(args.repeat):
                    for d in dpo_data:
                        entry = {
                            "chosen": [
                                {"role": "user", "content": d["prompt"]},
                                {"role": "assistant", "content": d["chosen"]}
                            ],
                            "rejected": [
                                {"role": "user", "content": d["prompt"]},
                                {"role": "assistant", "content": d["rejected"]}
                            ]
                        }
                        f.write(json.dumps(entry) + "\n")

            total_examples = len(dpo_data) * args.repeat
            print(f"  Training data: {len(dpo_data)} unique pairs × {args.repeat} = {total_examples} examples")

            print(f"\nRunning DPO alignment training...")
            cmd = [
                sys.executable, "-m", "mlx_lm.lora",
                "--model", MODEL_PATH,
                "--train",
                "--data", os.path.dirname(dpo_train_path),
                "--adapter-path", OUTPUT_ADAPTER,
                "--num-layers", "12",
                "--batch-size", "1",
                "--iters", str(args.iters),
                "--max-seq-length", "1024",
                "--learning-rate", str(args.lr),
                "--steps-per-report", "50",
                "--save-every", "150",
                "--resume-adapter-file", os.path.join(SFT_ADAPTER, "adapters.safetensors"),
            ]

            print(f"Command: {' '.join(cmd)}")
            result = subprocess.run(cmd)

            if result.returncode == 0:
                print(f"\nGRPO alignment complete! Adapter: {OUTPUT_ADAPTER}")
            else:
                print(f"\nDPO training returned code {result.returncode}")
                print("Falling back to SFT adapter only")
                os.makedirs(OUTPUT_ADAPTER, exist_ok=True)
                for fname in os.listdir(SFT_ADAPTER):
                    shutil.copy2(os.path.join(SFT_ADAPTER, fname), os.path.join(OUTPUT_ADAPTER, fname))
        else:
            print(f"\nNot enough preference pairs ({len(dpo_data)}) for DPO. Using SFT adapter.")
            os.makedirs(OUTPUT_ADAPTER, exist_ok=True)
            for fname in os.listdir(SFT_ADAPTER):
                shutil.copy2(os.path.join(SFT_ADAPTER, fname), os.path.join(OUTPUT_ADAPTER, fname))

    except ImportError:
        print("ERROR: mlx_lm not installed. Run: pip3 install mlx mlx-lm")
        sys.exit(1)
    except Exception as e:
        print(f"GRPO failed: {e}")
        print("Falling back to SFT-only adapter")
        os.makedirs(OUTPUT_ADAPTER, exist_ok=True)
        if os.path.exists(SFT_ADAPTER):
            for fname in os.listdir(SFT_ADAPTER):
                shutil.copy2(os.path.join(SFT_ADAPTER, fname), os.path.join(OUTPUT_ADAPTER, fname))


if __name__ == "__main__":
    main()
