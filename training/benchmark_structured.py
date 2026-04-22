#!/usr/bin/env python3
"""
Prism-Coder Benchmark v6.0 — Hybrid Approach
Stage 1: Structured output to classify intent (tool vs direct_answer)
Stage 2: If tool selected, it's already in the structured JSON with args

Key insight: Use structured output with "direct_answer" as a valid action.
The trick is adding stronger system prompt guidance for when NOT to use tools.
"""
import json, requests, time

OLLAMA_URL = "http://localhost:11434/api/chat"
RESULTS_FILE = "/tmp/hybrid_bench_results.txt"

# JSON schema — same as v5 but with stronger direct_answer guidance
TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {
            "type": "string",
            "enum": [
                "session_load_context", "session_save", "session_search",
                "session_list", "session_delete", "knowledge_save",
                "knowledge_search", "memory_link", "session_handoff",
                "session_task_route", "direct_answer"
            ]
        },
        "arguments": {
            "type": "object"
        },
        "reasoning": {
            "type": "string"
        }
    },
    "required": ["action", "reasoning"]
}

# Key change: Much stronger guidance about when to use direct_answer
SYS_MSG = """You are Prism, an AI coding assistant with persistent memory.
Given a user message, decide which action to take.

CRITICAL RULE — use "direct_answer" for any of these:
- General coding questions (REST vs GraphQL, design patterns, algorithms)
- Requests to write code, explain concepts, or give advice
- Questions about technologies, languages, frameworks
- Any question that does NOT explicitly reference project history, sessions, or stored knowledge
- Questions about what Prism IS or how it works (these are self-referential, not memory lookups)

ONLY use a tool when the user EXPLICITLY asks about:
- Their project context/history (session_load_context, session_search, session_list)
- Saving their work or a note about work done (session_save)
- Storing a fact with "remember this" (knowledge_save)
- What they've stored: "what do we know about X" (knowledge_search)
- Deleting/removing sessions (session_delete)
- Connecting entries (memory_link)
- Transferring between agents (session_handoff)
- Local vs cloud routing (session_task_route)

Tools:
- session_load_context: Load project context
- session_save: Record work done
- session_search: Search past sessions
- session_list: List recent sessions
- session_delete: Delete a session
- knowledge_save: Store a fact/rule  
- knowledge_search: Search knowledge base
- memory_link: Link two entries
- session_handoff: Transfer task between agents
- session_task_route: Route to local/cloud
- direct_answer: Answer directly (DEFAULT for general questions)"""

TESTS = [
    ("Show me the context for synalux-portal", "session_load_context", "tool_call"),
    ("Record this work: migrated Stripe webhooks to v2 API", "session_save", "tool_call"),
    ("Search past sessions for work on the OAuth2 refresh flow", "session_search", "retrieval"),
    ("Show all sessions for synalux-docs project", "session_list", "retrieval"),
    ("Remove the session about the failed deploy last Friday", "session_delete", "tool_call"),
    ("Remember this: Supabase RLS requires a JWT with the role claim", "knowledge_save", "tool_call"),
    ("What do we know about edge function cold starts?", "knowledge_search", "retrieval"),
    ("Connect the RBAC session to the auth session as related", "memory_link", "tool_call"),
    ("Transfer the frontend task from the dev agent to the QA agent", "session_handoff", "tool_call"),
    ("Should the local agent or the cloud agent handle this CSS fix?", "session_task_route", "tool_call"),
    ("What is the difference between REST and GraphQL?", None, "reasoning"),
    ("How does garbage collection work in Go?", None, "reasoning"),
    ("Explain the CAP theorem in simple terms", None, "reasoning"),
    ("What are the pros and cons of microservices?", None, "reasoning"),
    ("Write a bash one-liner to find large files", None, "reasoning"),
    ("Load context for synalux-portal and also save this session", "session_load_context", "edge"),
    ("What is Prism?", None, "edge"),
    ("Search for résumé templates in the knowledge base", "knowledge_search", "edge"),
    ("List sessions", "session_list", "edge"),
    ("I need to save a note about how we set up the CI/CD pipeline with GitHub Actions, Docker multi-stage builds, and Kubernetes deployment manifests", "session_save", "edge"),
]

out = []
correct = 0
valid_json = 0
categories = {}

for i, (prompt, expected, cat) in enumerate(TESTS):
    try:
        r = requests.post(OLLAMA_URL, json={
            "model": "prism-coder:7b",
            "messages": [
                {"role": "system", "content": SYS_MSG},
                {"role": "user", "content": prompt},
            ],
            "format": TOOL_SCHEMA,
            "stream": False,
            "options": {"num_predict": 256, "temperature": 0.1},
        }, timeout=90)
        data = r.json()
        content = data.get("message", {}).get("content", "")
        
        try:
            result = json.loads(content)
            valid_json += 1
            got_action = result.get("action")
            reasoning = result.get("reasoning", "")[:80]
        except json.JSONDecodeError:
            got_action = None
            reasoning = content[:80]
            
    except Exception as e:
        got_action = None
        reasoning = f"ERROR: {e}"

    if expected is None:
        ok = (got_action == "direct_answer")
    else:
        ok = (got_action == expected)
    
    if ok: correct += 1

    if cat not in categories:
        categories[cat] = {"total": 0, "correct": 0}
    categories[cat]["total"] += 1
    if ok: categories[cat]["correct"] += 1

    status = "✅" if ok else "❌"
    got_display = got_action or "None"
    exp_display = expected or "direct_answer"
    out.append(f"[{i+1:2d}/20] {status} {cat:10s} | expected={exp_display:25s} | got={got_display:25s}")
    if not ok:
        out.append(f"        Reasoning: {reasoning}")

acc = correct / len(TESTS) * 100
json_rate = valid_json / len(TESTS) * 100

out.append(f"\n{'='*70}")
out.append(f"Overall Accuracy:    {correct}/20 ({acc:.0f}%)")
out.append(f"Valid JSON Output:   {valid_json}/20 ({json_rate:.0f}%) — grammar-constrained")
out.append(f"\nCategory Breakdown:")
for cat, d in sorted(categories.items()):
    out.append(f"  {cat:10s}: {d['correct']}/{d['total']} ({d['correct']/d['total']*100:.0f}%)")

result = "\n".join(out)
print(result)
with open(RESULTS_FILE, "w") as f:
    f.write(result)
