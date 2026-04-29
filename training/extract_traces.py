#!/usr/bin/env python3
"""
Extract Prism reasoning traces from SQLite + conversation logs → SFT dataset.
Outputs ChatML-formatted JSONL for MLX LoRA fine-tuning.
"""
import sqlite3
import json
import os
import re
import random

DB_PATH = os.path.expanduser("~/.prism-mcp/data.db")
BRAIN_DIR = os.path.expanduser("~/.gemini/antigravity/brain")
_TRAINING_DIR = os.path.dirname(os.path.abspath(__file__))
TOOL_SCHEMA_PATH = os.path.join(_TRAINING_DIR, "data", "tool_schema.json")
OUTPUT = os.path.join(_TRAINING_DIR, "data", "sft_dataset.jsonl")

SYSTEM_PROMPT = """You are Prism, an AI coding assistant with persistent memory across sessions.
You have access to MCP tools for session management, knowledge retrieval, and project context.
When users ask about project history, decisions, stored context, or need to save work, use the appropriate tool.
Format tool calls as JSON with the exact schema provided.

Available tools: session_load_context, session_save, session_search, session_list, session_delete, knowledge_save, knowledge_search, memory_link, session_handoff, session_task_route"""


def load_tool_schemas():
    with open(TOOL_SCHEMA_PATH) as f:
        return json.load(f)["tools"]


def extract_session_ledger_examples(conn):
    """Convert session_ledger rows into SFT (user_prompt, assistant_response) pairs."""
    examples = []
    cursor = conn.execute("""
        SELECT project, summary, todos, files_changed, decisions, keywords, role, event_type
        FROM session_ledger
        WHERE summary != '' AND deleted_at IS NULL
        ORDER BY created_at DESC
    """)

    for row in cursor.fetchall():
        project, summary, todos, files, decisions, keywords, role, event_type = row

        # --- Example 1: session_save pattern ---
        todos_list = json.loads(todos) if todos else []
        files_list = json.loads(files) if files else []
        decisions_list = json.loads(decisions) if decisions else []
        keywords_list = json.loads(keywords) if keywords else []

        # Build a natural user prompt
        user_prompts = [
            f"Save this session for project {project}: {summary}",
            f"Record what we did on {project} - {summary}",
            f"Log this work session: {summary}",
        ]

        tool_call = {
            "name": "session_save",
            "arguments": {
                "project": project,
                "summary": summary,
            }
        }
        if todos_list:
            tool_call["arguments"]["todos"] = todos_list
        if files_list:
            tool_call["arguments"]["files_changed"] = files_list
        if decisions_list:
            tool_call["arguments"]["decisions"] = decisions_list
        if keywords_list:
            tool_call["arguments"]["keywords"] = keywords_list
        if role and role != "global":
            tool_call["arguments"]["role"] = role

        think = f"<|synalux_think|>The user wants to persist a work session for project '{project}'. This is a write operation to the session ledger. The correct tool is session_save, which requires 'project' and 'summary'. I have both from the user's message. Optional fields like todos, files_changed, decisions, and keywords should be included if available.</|synalux_think|>"
        assistant = f"{think}\n\nI'll save this session to Prism memory.\n\n<|tool_call|>\n{json.dumps(tool_call, indent=2)}\n</|tool_call|>"

        examples.append({
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": random.choice(user_prompts)},
                {"role": "assistant", "content": assistant}
            ]
        })

        # --- Example 2: session_search pattern (using the summary as query) ---
        search_prompts = [
            f"Find sessions about {keywords_list[0] if keywords_list else summary[:50]}",
            f"Search for work related to {summary[:60]}",
            f"What did we do regarding {decisions_list[0][:50] if decisions_list else summary[:40]}?",
        ]

        search_call = {
            "name": "session_search",
            "arguments": {
                "query": keywords_list[0] if keywords_list else summary[:80],
                "project": project
            }
        }
        search_query = keywords_list[0] if keywords_list else summary[:80]
        search_think = f"<|synalux_think|>The user is asking about past work. This is a read/retrieval operation. I need to search session history, not save anything new. The correct tool is session_search with a 'query' parameter. The best query term is '{search_query}' extracted from their message. I should also scope it to project '{project}'.</|synalux_think|>"
        search_response = f"{search_think}\n\nLet me search Prism memory for that.\n\n<|tool_call|>\n{json.dumps(search_call, indent=2)}\n</|tool_call|>"

        examples.append({
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": random.choice(search_prompts)},
                {"role": "assistant", "content": search_response}
            ]
        })

    return examples


def extract_semantic_knowledge_examples(conn):
    """Convert semantic_knowledge rows into knowledge_save/search training pairs."""
    examples = []
    cursor = conn.execute("""
        SELECT project, concept, description, confidence, related_entities
        FROM semantic_knowledge
        WHERE description != ''
    """)

    for row in cursor.fetchall():
        project, concept, description, confidence, related = row
        related_list = json.loads(related) if related else []

        # knowledge_save pattern
        save_prompts = [
            f"Remember this pattern for {project}: {concept} - {description[:80]}",
            f"Store this knowledge: {concept}",
            f"Save this insight about {concept} in {project}",
        ]

        save_call = {
            "name": "knowledge_save",
            "arguments": {
                "project": project,
                "concept": concept,
                "description": description,
                "confidence": confidence or 0.5,
            }
        }
        if related_list:
            save_call["arguments"]["related_entities"] = related_list

        examples.append({
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": random.choice(save_prompts)},
                {"role": "assistant", "content": f"<|synalux_think|>The user wants to store a reusable insight about '{concept}' for project '{project}'. This is a knowledge persistence operation, not a session log. The correct tool is knowledge_save (not session_save). Required parameters are project, concept, and description. Confidence and related_entities are optional but I have them.</|synalux_think|>\n\nI'll store this knowledge in Prism.\n\n<|tool_call|>\n{json.dumps(save_call, indent=2)}\n</|tool_call|>"}
            ]
        })

        # knowledge_search pattern
        search_prompts = [
            f"What do we know about {concept}?",
            f"Find knowledge related to {concept} in {project}",
            f"Search for patterns about {concept}",
        ]

        search_call = {
            "name": "knowledge_search",
            "arguments": {
                "query": concept,
                "project": project
            }
        }

        examples.append({
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": random.choice(search_prompts)},
                {"role": "assistant", "content": f"<|synalux_think|>The user is asking about a concept ('{concept}'). They want existing knowledge, not session history. The correct tool is knowledge_search (not session_search), scoped to project '{project}'. The query should be the concept name itself.</|synalux_think|>\n\nLet me search Prism's knowledge base.\n\n<|tool_call|>\n{json.dumps(search_call, indent=2)}\n</|tool_call|>"}
            ]
        })

    return examples


def generate_context_loading_examples():
    """Generate session_load_context training examples."""
    projects = ["prism-mcp", "analytics-dashboard", "billing-portal", "docs-portal"]
    examples = []

    for project in projects:
        for level in ["shallow", "deep"]:
            prompts = [
                f"Load context for {project}",
                f"What's the current state of {project}?",
                f"Initialize session for {project}",
                f"Start working on {project}, load everything",
            ]

            call = {
                "name": "session_load_context",
                "arguments": {
                    "project": project,
                    "level": level
                }
            }

            for prompt in prompts:
                ctx_think = f"<|synalux_think|>The user wants to start or resume work on '{project}'. This requires loading project context from Prism memory. The correct tool is session_load_context. The 'level' parameter controls depth: 'shallow' for quick summaries, 'deep' for full history. Based on the phrasing, I'll use '{level}' depth.</|synalux_think|>"
                examples.append({
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": prompt},
                        {"role": "assistant", "content": f"{ctx_think}\n\nLoading {level} context for {project}.\n\n<|tool_call|>\n{json.dumps(call, indent=2)}\n</|tool_call|>"}
                    ]
                })

    return examples


def generate_negative_examples():
    """Generate examples where the model should NOT call a tool."""
    no_tool_pairs = [
        ("What is Python?", "Python is a high-level, interpreted programming language known for its simplicity and readability. It was created by Guido van Rossum and first released in 1991."),
        ("Explain async/await in JavaScript", "Async/await is syntactic sugar over Promises in JavaScript. The `async` keyword marks a function as asynchronous, and `await` pauses execution until the Promise resolves."),
        ("Write a hello world in Rust", '```rust\nfn main() {\n    println!("Hello, world!");\n}\n```'),
        ("How do I create a React component?", "You can create a React component as a function:\n\n```tsx\nfunction MyComponent({ name }: { name: string }) {\n  return <div>Hello, {name}!</div>;\n}\n```"),
        ("Fix this TypeScript error: Type 'string' is not assignable to type 'number'", "This error means you're trying to assign a string value where a number is expected. Check the variable declaration and ensure the types match, or use `parseInt()` / `Number()` to convert."),
    ]

    examples = []
    for user, assistant in no_tool_pairs:
        neg_think = f"<|synalux_think|>The user is asking a general programming question ('{user[:60]}'). This does not involve session history, knowledge storage, or project context from Prism memory. None of my MCP tools are relevant here. I should answer directly with my own knowledge without calling any tool.</|synalux_think|>"
        examples.append({
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user},
                {"role": "assistant", "content": f"{neg_think}\n\n{assistant}"}
            ]
        })

    return examples


def generate_handoff_examples():
    """Generate session_handoff training examples."""
    handoffs = [
        ("Hand off the auth work from coder to tester", "prism-mcp", "coder", "tester", "Authentication implementation complete. JWT tokens and bcrypt hashing implemented. Need edge case testing for expired tokens and rate limiting."),
        ("Transfer this task to the QA agent", "analytics-dashboard", "developer", "qa", "SOAP note generation feature complete. Need comprehensive testing of voice dictation → SOAP conversion pipeline."),
        ("Pass the billing module to security for review", "analytics-dashboard", "coder", "security", "Stripe integration complete with webhook handlers. Need security review of payment data handling and PCI compliance."),
    ]

    examples = []
    for prompt, project, from_a, to_a, summary in handoffs:
        call = {
            "name": "session_handoff",
            "arguments": {
                "project": project,
                "from_agent": from_a,
                "to_agent": to_a,
                "summary": summary
            }
        }
        handoff_think = f"<|synalux_think|>The user wants to transfer work between agents. This is a handoff operation — not a save or search. The correct tool is session_handoff, which requires 'project', 'from_agent', 'to_agent', and 'summary'. I'll route from '{from_a}' to '{to_a}' for project '{project}'.</|synalux_think|>"
        examples.append({
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": f"{handoff_think}\n\nCreating handoff from {from_a} to {to_a}.\n\n<|tool_call|>\n{json.dumps(call, indent=2)}\n</|tool_call|>"}
            ]
        })

    return examples


def main():
    # Build tool schema first
    os.system(f"python3 {os.path.join(_TRAINING_DIR, 'build_tool_schema.py')}")

    conn = sqlite3.connect(DB_PATH)

    all_examples = []

    # 1. Session ledger traces
    ledger_examples = extract_session_ledger_examples(conn)
    print(f"Session ledger examples: {len(ledger_examples)}")
    all_examples.extend(ledger_examples)

    # 2. Semantic knowledge
    knowledge_examples = extract_semantic_knowledge_examples(conn)
    print(f"Semantic knowledge examples: {len(knowledge_examples)}")
    all_examples.extend(knowledge_examples)

    # 3. Context loading
    context_examples = generate_context_loading_examples()
    print(f"Context loading examples: {len(context_examples)}")
    all_examples.extend(context_examples)

    # 4. Negative examples (no tool call)
    negative_examples = generate_negative_examples()
    print(f"Negative examples: {len(negative_examples)}")
    all_examples.extend(negative_examples)

    # 5. Handoff examples
    handoff_examples = generate_handoff_examples()
    print(f"Handoff examples: {len(handoff_examples)}")
    all_examples.extend(handoff_examples)

    conn.close()

    # Shuffle
    random.seed(42)
    random.shuffle(all_examples)

    # Split 90/10 train/valid
    split = int(len(all_examples) * 0.9)
    train = all_examples[:split]
    valid = all_examples[split:]

    # Write train
    with open(OUTPUT, "w") as f:
        for ex in train:
            f.write(json.dumps(ex) + "\n")

    # Write valid
    valid_path = OUTPUT.replace("sft_dataset", "sft_valid")
    with open(valid_path, "w") as f:
        for ex in valid:
            f.write(json.dumps(ex) + "\n")

    print(f"\nTotal examples: {len(all_examples)}")
    print(f"Train: {len(train)} → {OUTPUT}")
    print(f"Valid: {len(valid)} → {valid_path}")


if __name__ == "__main__":
    main()
