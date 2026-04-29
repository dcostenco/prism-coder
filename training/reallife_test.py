#!/usr/bin/env python3
"""
Real-life integration test for prism-coder:7b via Ollama.
Tests actual tool-call responses against real Prism MCP schemas.
"""
import json
import subprocess
import sys
import time

MODEL = "prism-coder:7b"

# Real Prism MCP tool schemas — required params from sessionMemoryDefinitions.ts
REAL_SCHEMAS = {
    "session_load_context": {"required": {"project", "toolAction", "toolSummary"}},
    "session_save_ledger": {"required": {"project", "conversation_id", "summary"}},
    "session_save_handoff": {"required": {"project"}},
    "session_search_memory": {"required": {"query"}},
    "session_save_experience": {"required": {"project", "event_type", "context", "action", "outcome"}},
    "session_task_route": {"required": {"task_description"}},
    "knowledge_search": {"required": {"query"}},
    "knowledge_upvote": {"required": {"id"}},
    "knowledge_downvote": {"required": {"id"}},
    "knowledge_forget": {"required": set()},
    "session_compact_ledger": {"required": set()},
    "session_health_check": {"required": set()},
    "session_forget_memory": {"required": {"memory_id"}},
    "session_export_memory": {"required": {"output_dir"}},
    "session_backfill_links": {"required": {"project"}},
    "session_synthesize_edges": {"required": {"project"}},
    "memory_history": {"required": {"project"}},
    "memory_checkout": {"required": {"project", "target_version"}},
    "session_cognitive_route": {"required": {"project", "state", "role", "action"}},
    # Synalux-specific
    "image_gen": {"required": {"prompt"}},
    "tts": {"required": {"text"}},
    "hipaa": {"required": {"action"}},
}

# Real-life test prompts — exactly what a user would type
TESTS = [
    # ── Prism MCP — should call tools ──
    {"prompt": "Load context for prism-mcp project", "expect_tool": "session_load_context"},
    {"prompt": "Save this session: fixed the OAuth bug in the portal", "expect_tool": "session_save_ledger"},
    {"prompt": "What did we work on last week related to billing?", "expect_tool": "session_search_memory"},
    {"prompt": "Create a handoff for the billing-portal project", "expect_tool": "session_save_handoff"},
    {"prompt": "Delete the memory entry for the broken config change", "expect_tool": "session_forget_memory"},
    {"prompt": "Check if the memory database has any integrity issues", "expect_tool": "session_health_check"},
    {"prompt": "Search knowledge base for anything about CORS policies", "expect_tool": "knowledge_search"},
    {"prompt": "Compact the old entries in the prism-mcp ledger", "expect_tool": "session_compact_ledger"},
    {"prompt": "Export prism-mcp memory to /tmp/export", "expect_tool": "session_export_memory"},
    {"prompt": "Route this task: refactoring the auth middleware", "expect_tool": "session_task_route"},
    # ── Reasoning — should NOT call tools ──
    {"prompt": "What is the difference between TCP and UDP?", "expect_tool": None},
    {"prompt": "How does React's virtual DOM work?", "expect_tool": None},
    {"prompt": "Write a Python function to reverse a linked list", "expect_tool": None},
    # ── Adversarial — keyword traps, should NOT call tools ──
    {"prompt": "How do I save state in React with useState?", "expect_tool": None},
    {"prompt": "Explain how session tokens work in web authentication", "expect_tool": None},
    {"prompt": "What is knowledge representation in AI?", "expect_tool": None},
    # ── Edge cases ──
    {"prompt": "Find what we decided about the database migration strategy", "expect_tool": "session_search_memory"},
    {"prompt": "Is our memory system healthy? Auto-fix if not.", "expect_tool": "session_health_check"},
    # ── R5-6: Dry-run safety — destructive ops should use dry_run ──
    {"prompt": "Delete all old entries from the test project", "expect_tool": "knowledge_forget"},
    {"prompt": "Compact the ledger for analytics-dashboard", "expect_tool": "session_compact_ledger"},
    {"prompt": "Forget the memory entry with ID abc-123", "expect_tool": "session_forget_memory"},
    # ── R5-2: Optional param restraint — expansive queries should NOT hallucinate params ──
    {"prompt": "Get me everything about this project", "expect_tool": None},
    {"prompt": "Run a full analysis on all records", "expect_tool": None},
]


def call_ollama(prompt: str) -> str:
    """Call Ollama model and return raw response."""
    try:
        result = subprocess.run(
            ["ollama", "run", MODEL, prompt],
            capture_output=True, text=True, timeout=60
        )
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        return "[TIMEOUT]"
    except Exception as e:
        return f"[ERROR: {e}]"


def extract_tool_call(response: str) -> tuple:
    """Extract tool name and args from response. Returns (name, args) or (None, None)."""
    import re

    # Try <|tool_call|> tags
    match = re.search(r'<|tool_call|>\s*(.*?)\s*</|tool_call|>', response, re.DOTALL)
    if match:
        try:
            call = json.loads(match.group(1))
            name = call.get("name") or call.get("tool")
            args = call.get("arguments") or call.get("args") or call.get("parameters", {})
            return name, args
        except json.JSONDecodeError:
            return "INVALID_JSON", None

    # Try <|tool_call|> tags
    match = re.search(r'<\|tool_call\|>\s*(.*?)\s*(?:</\|tool_call\|>|$)', response, re.DOTALL)
    if match:
        try:
            call = json.loads(match.group(1))
            name = call.get("name") or call.get("tool")
            args = call.get("arguments") or call.get("args") or call.get("parameters", {})
            return name, args
        except json.JSONDecodeError:
            return "INVALID_JSON", None

    # Bare JSON fallback (strip <|synalux_think|> blocks first)
    stripped = re.sub(r'<|synalux_think|>.*?</|synalux_think|>', '', response, flags=re.DOTALL)
    for m in re.finditer(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', stripped):
        try:
            call = json.loads(m.group())
            name = call.get("name") or call.get("tool")
            if name:
                args = call.get("arguments") or call.get("args") or call.get("parameters", {})
                return name, args
        except json.JSONDecodeError:
            continue

    return None, None


def validate_params(tool_name: str, args: dict) -> tuple:
    """Validate tool args against real Prism MCP schemas. Returns (valid, missing)."""
    if tool_name not in REAL_SCHEMAS:
        return False, [f"unknown tool: {tool_name}"]
    required = REAL_SCHEMAS[tool_name]["required"]
    if not args:
        args = {}
    missing = required - set(args.keys())
    return len(missing) == 0, list(missing)


def run_real_tests():
    """Run all tests and report results."""
    print(f"{'='*70}")
    print(f"REAL-LIFE INTEGRATION TEST — prism-coder:7b via Ollama")
    print(f"{'='*70}")
    print(f"Model: {MODEL}")
    print(f"Tests: {len(TESTS)}")
    print()

    results = []
    passed = 0
    total_time = 0

    for i, test in enumerate(TESTS):
        start = time.time()
        response = call_ollama(test["prompt"])
        elapsed = time.time() - start
        total_time += elapsed

        tool_name, tool_args = extract_tool_call(response)

        # Determine pass/fail
        if test["expect_tool"] is None:
            # Should NOT call a tool
            correct = tool_name is None
            param_ok = True
            missing = []
        else:
            # Should call the right tool with valid params
            correct = tool_name == test["expect_tool"]
            if tool_name and tool_name in REAL_SCHEMAS:
                param_ok, missing = validate_params(tool_name, tool_args)
            else:
                param_ok = False
                missing = ["wrong tool"] if tool_name else ["no tool called"]

        is_pass = correct and param_ok
        if is_pass:
            passed += 1

        status = "✅" if is_pass else "❌"
        expect_str = test["expect_tool"] or "NO_TOOL"
        got_str = tool_name or "NO_TOOL"

        print(f"  [{i+1:2d}/{len(TESTS)}] {status} | expect={expect_str:25s} got={got_str:25s} | {elapsed:.1f}s | {test['prompt'][:55]}")
        if not is_pass and missing:
            print(f"           ↳ missing params: {missing}")

        results.append({
            "prompt": test["prompt"],
            "expected": test["expect_tool"],
            "got": tool_name,
            "args": tool_args,
            "param_ok": param_ok,
            "correct": is_pass,
            "latency": round(elapsed, 1),
            "response_preview": response[:200],
        })

    # Summary
    tool_tests = [r for r in results if TESTS[results.index(r)]["expect_tool"] is not None]
    reasoning_tests = [r for r in results if TESTS[results.index(r)]["expect_tool"] is None]
    tool_correct = sum(1 for r in tool_tests if r["correct"])
    reasoning_correct = sum(1 for r in reasoning_tests if r["correct"])

    print(f"\n{'='*70}")
    print(f"RESULTS SUMMARY")
    print(f"{'='*70}")
    print(f"  Overall:       {passed}/{len(TESTS)} = {100*passed/len(TESTS):.0f}%")
    print(f"  Tool-call:     {tool_correct}/{len(tool_tests)} = {100*tool_correct/len(tool_tests):.0f}%")
    print(f"  Reasoning:     {reasoning_correct}/{len(reasoning_tests)} = {100*reasoning_correct/len(reasoning_tests):.0f}%")
    print(f"  Avg latency:   {total_time/len(TESTS):.1f}s")
    print(f"  Total time:    {total_time:.0f}s")
    print(f"{'='*70}")

    # Save report
    report = {
        "model": MODEL,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "overall_accuracy": round(100*passed/len(TESTS), 1),
        "tool_accuracy": round(100*tool_correct/len(tool_tests), 1),
        "reasoning_accuracy": round(100*reasoning_correct/len(reasoning_tests), 1),
        "results": results,
    }
    _training_dir = os.path.dirname(os.path.abspath(__file__))
    report_path = os.path.join(_training_dir, "results", "reallife_test_report.json")
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nReport saved: {report_path}")


if __name__ == "__main__":
    run_real_tests()
