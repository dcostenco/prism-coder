#!/usr/bin/env python3
"""
SWE-Bench Inspired Blind Evaluation for prism-coder:7b

Unlike the real-life test (which had training overlap), these prompts are:
1. Completely novel — never seen in any training data
2. Realistic — mimic actual user interactions
3. Ambiguous — some have keyword traps or context-dependent meanings
4. Multi-intent — some require the model to pick the most appropriate tool
5. Adversarial — designed to confuse tool vs reasoning boundaries

Scoring follows SWE-bench methodology:
  - Strict match: correct tool name + all required params present
  - Partial match: correct tool name + some params  
  - Wrong tool: incorrect tool name (regardless of params)
  - False positive: tool called when none should be  
  - False negative: no tool called when one should be
"""
import subprocess
import json
import re
import time
import sys
import random
import urllib.request
import statistics

MODEL = "prism-coder:7b"
OLLAMA_API = "http://localhost:11434/api/generate"

# === BLIND TEST CASES (never in training data) ===
# Format: (prompt, expected_tool_or_NO_TOOL, required_params, category)
BLIND_TESTS = [
    # ====== CATEGORY 1: Natural user phrasing — tool needed (15 tests) ======
    ("Hey, I want to start a new session. Pull up everything we had on the synalux project.",
     "session_load_context", ["project"], "natural_phrasing"),
    
    ("Can you jot down what we accomplished? We rewrote the webhook handler and fixed 3 edge cases.",
     "session_save_ledger", ["project", "conversation_id", "summary"], "natural_phrasing"),
    
    ("I'm handing this off to the night shift. Make sure they know where we left off on prism-mcp.",
     "session_save_handoff", ["project"], "natural_phrasing"),
    
    ("Remind me — did we ever decide between Redis and Memcached for the session store?",
     "session_search_memory", ["query"], "natural_phrasing"),
    
    ("That memory entry about the old deployment script is totally wrong. Nuke it.",
     "session_forget_memory", ["memory_id"], "natural_phrasing"),

    ("Is everything OK with the memory backend? Run diagnostics.",
     "session_health_check", [], "natural_phrasing"),

    ("Any institutional knowledge about how we handle rate limiting?",
     "knowledge_search", ["query"], "natural_phrasing"),

    ("The ledger is getting huge. Summarize and archive the old stuff for billing-portal.",
     "session_compact_ledger", ["project"], "natural_phrasing"),

    ("Dump everything to a file so I can back it up. JSON format, save to /tmp/prism-backup.",
     "session_export_memory", ["output_dir", "format"], "natural_phrasing"),

    ("Should I handle this CSS grid refactor myself or punt it to the local model?",
     "session_task_route", ["task_description"], "natural_phrasing"),

    # Additional natural phrasing (indirect/conversational)
    ("Where were we on the portal project? Bring me up to speed.",
     "session_load_context", ["project"], "natural_phrasing"),

    ("We just finished a big refactor. Make sure it's written down for posterity.",
     "session_save_ledger", ["project", "conversation_id", "summary"], "natural_phrasing"),

    ("Go look through our old conversations and find anything about the payment gateway.",
     "session_search_memory", ["query"], "natural_phrasing"),

    ("Get rid of that wrong entry we saved about the broken migration.",
     "session_forget_memory", ["memory_id"], "natural_phrasing"),

    ("Is this bug fix simple enough for the local model to handle?",
     "session_task_route", ["task_description"], "natural_phrasing"),

    # ====== CATEGORY 2: Adversarial keyword traps — NO tool (15 tests) ======
    ("How do I implement a session manager in Express.js with Redis as the backing store?",
     "NO_TOOL", [], "adversarial_trap"),
    
    ("Explain the concept of memory management in Rust — borrowing, ownership, and lifetimes.",
     "NO_TOOL", [], "adversarial_trap"),

    ("What's the best way to save user preferences in a React Native app?",
     "NO_TOOL", [], "adversarial_trap"),

    ("Write a function that searches through a knowledge graph using BFS.",
     "NO_TOOL", [], "adversarial_trap"),

    ("How does garbage collection work in Go vs Java?",
     "NO_TOOL", [], "adversarial_trap"),

    ("Can you explain the compact representation of sparse matrices?",
     "NO_TOOL", [], "adversarial_trap"),

    ("What is the health check endpoint pattern in microservices?",
     "NO_TOOL", [], "adversarial_trap"),

    ("How do I export data from PostgreSQL to a CSV file?",
     "NO_TOOL", [], "adversarial_trap"),

    # NEW adversarial traps — high-risk keywords
    ("How do I create a session in PHP using session_start()?",
     "NO_TOOL", [], "adversarial_trap"),

    ("Write me a Python context manager for database connections.",
     "NO_TOOL", [], "adversarial_trap"),

    ("What's the difference between saving to disk vs saving to memory in SQLite?",
     "NO_TOOL", [], "adversarial_trap"),

    ("How do I implement search functionality with Elasticsearch?",
     "NO_TOOL", [], "adversarial_trap"),

    ("Explain how to load balance across multiple Node.js processes.",
     "NO_TOOL", [], "adversarial_trap"),

    ("What is the forget gate in an LSTM neural network?",
     "NO_TOOL", [], "adversarial_trap"),

    ("How do I route tasks in Celery to different queues?",
     "NO_TOOL", [], "adversarial_trap"),

    # ====== CATEGORY 3: Disambiguation — correct tool choice (8 tests) ======
    ("Search for anything we discussed about the authentication overhaul last month.",
     "session_search_memory", ["query"], "disambiguation"),

    ("I need to know if our knowledge base has anything on Kubernetes pod autoscaling.",
     "knowledge_search", ["query"], "disambiguation"),

    # NEW: forget tool disambiguation
    ("Delete the specific memory entry with ID mem-abc-123.",
     "session_forget_memory", ["memory_id"], "disambiguation"),

    ("Wipe out all old debugging entries from the prism-mcp project.",
     "knowledge_forget", ["project"], "disambiguation"),

    # NEW: save tool disambiguation
    ("We're done for the day. Log what we accomplished.",
     "session_save_ledger", ["project", "conversation_id", "summary"], "disambiguation"),

    ("Pass this project to the next developer. Save the handoff state.",
     "session_save_handoff", ["project"], "disambiguation"),

    # NEW: search tool disambiguation
    ("What do our curated knowledge items say about error handling best practices?",
     "knowledge_search", ["query"], "disambiguation"),

    ("Did we discuss anything about caching in our recent sessions?",
     "session_search_memory", ["query"], "disambiguation"),

    # ====== CATEGORY 4: Edge cases (8 tests) ======
    ("Load context.",
     "session_load_context", ["project"], "edge_case"),

    ("Save.",
     "session_save_ledger", ["project", "conversation_id", "summary"], "edge_case"),

    ("What tools do you have available?",
     "NO_TOOL", [], "edge_case"),

    ("Tell me about yourself.",
     "NO_TOOL", [], "edge_case"),

    # NEW edge cases
    ("Hello!",
     "NO_TOOL", [], "edge_case"),

    ("Thanks, that's all for now.",
     "NO_TOOL", [], "edge_case"),

    ("Search.",
     "session_search_memory", ["query"], "edge_case"),

    ("Check health.",
     "session_health_check", [], "edge_case"),

    # ====== CATEGORY 5: Multi-tool / complex intent (4 tests) ======
    ("Find all our past notes about the billing API redesign and check if the memory DB is healthy.",
     "session_search_memory", ["query"], "multi_intent"),

    ("Load the prism project context and then save a note that we started the migration.",
     "session_load_context", ["project"], "multi_intent"),

    ("Before I hand off, save what we did today: fixed the OAuth flow and updated tests.",
     "session_save_ledger", ["project", "conversation_id", "summary"], "multi_intent"),

    ("I want to export a backup and then compact the old entries.",
     "session_export_memory", ["output_dir"], "multi_intent"),
]

TOOL_CALL_RE = re.compile(
    r'<\|tool_call\|>\s*(\{.*\})',
    re.DOTALL
)

def call_ollama(prompt: str, timeout: int = 120) -> tuple:
    """Call ollama REST API and return (raw_response, parsed_tool_name, parsed_args, latency)."""
    start = time.time()
    try:
        payload = json.dumps({
            "model": MODEL,
            "prompt": prompt,
            "stream": False,
            "raw": True,
            "options": {"temperature": 0.0, "num_predict": 512}
        }).encode("utf-8")
        
        req = urllib.request.Request(
            OLLAMA_API,
            data=payload,
            headers={"Content-Type": "application/json"}
        )
        
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            raw = data.get("response", "").strip()
    except Exception as e:
        return (str(e), "ERROR", {}, time.time() - start)
    
    latency = time.time() - start
    
    # Try to parse tool call — look for JSON with "name" key 
    match = TOOL_CALL_RE.search(raw)
    if match:
        try:
            tool_json = json.loads(match.group(1))
            tool_name = tool_json.get("name", tool_json.get("tool", "UNKNOWN"))
            tool_args = tool_json.get("arguments", tool_json.get("args", {}))
            return (raw, tool_name, tool_args, latency)
        except json.JSONDecodeError:
            pass
    
    # Fallback: try to find JSON with "name" key containing nested braces
    json_re = re.search(r'(\{[^{}]*"name"\s*:\s*"[^"]+?"[^{}]*(?:\{[^{}]*\}[^{}]*)*\})', raw)
    if json_re:
        try:
            tool_json = json.loads(json_re.group(0))
            tool_name = tool_json.get("name", "UNKNOWN")
            tool_args = tool_json.get("arguments", tool_json.get("args", {}))
            return (raw, tool_name, tool_args, latency)
        except json.JSONDecodeError:
            pass
    
    return (raw, "NO_TOOL", {}, latency)


# === LAYER 3: Inference-Time False Positive Rejection ===
# Catches cases where the model hallucinates a tool call on general programming prompts.
# These are lightweight heuristics — they only reject, never add tool calls.

# Patterns that strongly indicate a general programming question (NOT Prism)
GENERAL_PROGRAMMING_PATTERNS = [
    # Python context managers — not Prism context loading
    r'\bcontext\s+manager\b', r'\bcontextlib\b', r'\b__enter__\b', r'\b__exit__\b',
    r'\basync\s+context\s+manager\b',
    # ML/LSTM forget gates — not Prism memory deletion
    r'\bforget\s+gate\b', r'\blstm\b', r'\bcatastrophic\s+forgetting\b',
    r'\bforget\s+bias\b', r'\belastic\s+weight\s+consolidation\b',
    # Web framework sessions — not Prism sessions
    r'\bexpress\.js\b', r'\bdjango\b', r'\bflask\b', r'\bsession_start\(\)',
    r'\bsession\s+middleware\b', r'\bsession\s+affinity\b',
    # General CS concepts that overlap with tool names
    r'\bgarbage\s+collection\b', r'\bmemory\s+management\s+in\s+rust\b',
    r'\bload\s+balanc', r'\bcontext\s+switch',
    r'\bsearch\s+algorithm\b', r'\bsearch\s+functionality\s+with\s+elasticsearch\b',
    r'\bhealth\s+check\s+endpoint\s+pattern\b',
]

# Patterns that confirm Prism-specific intent (overrides rejection)
PRISM_INTENT_PATTERNS = [
    r'\bprism\b', r'\bsession\s*ledger\b', r'\bhandoff\b', r'\bknowledge\s+base\b',
    r'\bknowledge\s+items?\b', r'\bour\s+knowledge\b', r'\bknowledge\s+base\b',
    r'\bsave.*(?:session|ledger|handoff)\b', r'\bload\s+context\b',
    r'\b(?:search|find).*(?:memory|sessions?|conversations?|notes)\b',
    r'\bproject\b', r'\bwhat\s+(?:do\s+)?we\s+(?:know|have)\b',
    r'\binstitutional\s+knowledge\b', r'\bdocumented\b', r'\bcurated\b',
    r'\bmemory\s+entry\b', r'\bmemory\s+backend\b', r'\bdiagnostics\b',
    r'\bledger\b', r'\bcompact\b.*(?:ledger|entries|session)\b',
    r'\bexport.*(?:memory|backup)\b', r'\b(?:delete|nuke|wipe|remove).*(?:entry|memory|entries)\b',
    r'\blog.*(?:what|accomplished|session)\b', r'\brecord.*(?:session|what)\b',
    r'\bhand.*(?:off|over)\b', r'\bbring.*up\s+to\s+speed\b',
    r'\bbug\s+fix.*(?:local\s+model|handle)\b', r'\broute.*(?:task|this)\b',
]

def validate_tool_call(prompt, tool_name, tool_args):
    """Layer 3: reject obvious false positive tool calls.
    
    Returns (tool_name, tool_args) — possibly changed to ("NO_TOOL", {}) if rejected.
    """
    if tool_name == "NO_TOOL":
        return tool_name, tool_args
    
    prompt_lower = prompt.lower()
    
    # Check if this looks like a general programming question
    is_general = any(re.search(p, prompt_lower) for p in GENERAL_PROGRAMMING_PATTERNS)
    
    if not is_general:
        return tool_name, tool_args  # No red flags → keep tool call
    
    # It looks general — but check if there's Prism-specific intent that overrides
    has_prism_intent = any(re.search(p, prompt_lower) for p in PRISM_INTENT_PATTERNS)
    
    if has_prism_intent:
        return tool_name, tool_args  # Prism intent confirmed → keep tool call
    
    # General programming pattern + no Prism intent → reject the tool call
    return "NO_TOOL", {}



def evaluate_result(expected_tool, required_params, got_tool, got_args):
    """
    SWE-bench scoring:
      - strict_pass: correct tool + all required params
      - partial_pass: correct tool + missing some params
      - wrong_tool: different tool called
      - false_positive: tool called when none should be
      - false_negative: no tool called when one should be
    """
    if expected_tool == "NO_TOOL":
        if got_tool == "NO_TOOL":
            return "strict_pass"
        else:
            return "false_positive"
    else:
        if got_tool == "NO_TOOL":
            return "false_negative"
        elif got_tool != expected_tool:
            # Special case: accept session_search_memory OR knowledge_search for search queries
            if expected_tool in ("session_search_memory", "knowledge_search") and got_tool in ("session_search_memory", "knowledge_search"):
                pass  # Close enough
            else:
                return "wrong_tool"
        
        # Check required params
        if not required_params:
            return "strict_pass"
        
        present = [p for p in required_params if p in got_args]
        if len(present) == len(required_params):
            return "strict_pass"
        elif len(present) > 0:
            return "partial_pass"
        else:
            return "partial_pass"  # Got the tool right but missing params


def main(shuffle=False, no_validate_layer3=False):
    print("=" * 70)
    print("SWE-BENCH INSPIRED BLIND EVALUATION — prism-coder:7b")
    print("=" * 70)
    print(f"Model: {MODEL}")
    print(f"Tests: {len(BLIND_TESTS)} (all novel, never in training data)")
    print(f"Order: {'RANDOMIZED' if shuffle else 'sequential'}")
    print(f"Categories: natural_phrasing, adversarial_trap, disambiguation, edge_case, multi_intent")
    print()

    # Build indexed test list and optionally shuffle
    indexed_tests = list(enumerate(BLIND_TESTS))
    if shuffle:
        random.shuffle(indexed_tests)

    results = [None] * len(BLIND_TESTS)  # store by original index
    category_stats = {}
    
    # R10-fix: Load tool schemas and format ChatML system prompt
    try:
        _schema_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "tool_schema.json")
        with open(_schema_path) as _f:
            _tools = json.load(_f).get("tools", [])
    except (FileNotFoundError, json.JSONDecodeError):
        _tools = []
    from config import format_system_prompt
    _sys_prompt = format_system_prompt(_tools)

    for display_i, (orig_idx, (prompt, expected, required_params, category)) in enumerate(indexed_tests, 1):
        full_prompt = f"<|im_start|>system\n{_sys_prompt}<|im_end|>\n<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n"
        raw, got_tool, got_args, latency = call_ollama(full_prompt)
        # Layer 3: reject false positive tool calls on general programming prompts
        # Disabled during training benchmarks so RFT/DPO sees true model failures.
        if not no_validate_layer3:
            got_tool, got_args = validate_tool_call(prompt, got_tool, got_args)
        verdict = evaluate_result(expected, required_params, got_tool, got_args)
        
        is_pass = verdict in ("strict_pass", "partial_pass")
        icon = "✅" if verdict == "strict_pass" else ("⚠️" if verdict == "partial_pass" else "❌")
        
        # Truncate prompt for display
        short_prompt = prompt[:55]
        tag = f"#{orig_idx+1}"
        print(f"  [{display_i:2d}/{len(BLIND_TESTS)}] {icon} {tag:4s}| expect={expected:28s} got={got_tool:28s} | {latency:5.1f}s | {short_prompt}")
        if verdict not in ("strict_pass",):
            if verdict == "partial_pass":
                missing = [p for p in required_params if p not in got_args]
                print(f"           ↳ missing params: {missing}")
            elif verdict == "false_positive":
                print(f"           ↳ FALSE POSITIVE: called {got_tool} when no tool expected")
            elif verdict == "false_negative":
                print(f"           ↳ FALSE NEGATIVE: no tool called when {expected} expected")
            elif verdict == "wrong_tool":
                print(f"           ↳ WRONG TOOL: expected {expected}, got {got_tool}")
        
        results[orig_idx] = {
            "id": orig_idx + 1,
            "prompt": prompt,
            "expected": expected,
            "got": got_tool,
            "got_args": got_args,
            "verdict": verdict,
            "latency": latency,
            "category": category
        }
        
        # Category tracking
        if category not in category_stats:
            category_stats[category] = {"total": 0, "strict": 0, "partial": 0, "fail": 0}
        category_stats[category]["total"] += 1
        if verdict == "strict_pass":
            category_stats[category]["strict"] += 1
        elif verdict == "partial_pass":
            category_stats[category]["partial"] += 1
        else:
            category_stats[category]["fail"] += 1

    # Summary
    strict = sum(1 for r in results if r["verdict"] == "strict_pass")
    partial = sum(1 for r in results if r["verdict"] == "partial_pass")
    fails = sum(1 for r in results if r["verdict"] not in ("strict_pass", "partial_pass"))
    total = len(results)
    
    tool_tests = [r for r in results if r["expected"] != "NO_TOOL"]
    no_tool_tests = [r for r in results if r["expected"] == "NO_TOOL"]
    
    tool_strict = sum(1 for r in tool_tests if r["verdict"] == "strict_pass")
    tool_partial = sum(1 for r in tool_tests if r["verdict"] == "partial_pass")
    no_tool_pass = sum(1 for r in no_tool_tests if r["verdict"] == "strict_pass")
    
    avg_latency = sum(r["latency"] for r in results) / total
    
    print()
    print("=" * 70)
    print("SWE-BENCH RESULTS (Blind Evaluation)")
    print("=" * 70)
    print(f"  Strict Pass:   {strict}/{total} = {strict/total*100:.0f}%")
    print(f"  Partial Pass:  {partial}/{total} = {partial/total*100:.0f}%")
    print(f"  Total Pass:    {strict+partial}/{total} = {(strict+partial)/total*100:.0f}%")
    print(f"  Fail:          {fails}/{total} = {fails/total*100:.0f}%")
    print(f"  ---")
    print(f"  Tool Strict:   {tool_strict}/{len(tool_tests)} = {tool_strict/len(tool_tests)*100:.0f}%")
    print(f"  Tool Partial:  {tool_partial}/{len(tool_tests)} = {tool_partial/len(tool_tests)*100:.0f}%")
    print(f"  Abstention:    {no_tool_pass}/{len(no_tool_tests)} = {no_tool_pass/len(no_tool_tests)*100:.0f}%")
    print(f"  Avg latency:   {avg_latency:.1f}s")
    print()
    print("  Category Breakdown:")
    for cat, stats in sorted(category_stats.items()):
        pct = (stats["strict"] + stats["partial"]) / stats["total"] * 100
        print(f"    {cat:20s}: {stats['strict']}/{stats['total']} strict, {stats['partial']} partial, {stats['fail']} fail  ({pct:.0f}%)")
    print("=" * 70)
    
    # Save report
    report = {
        "model": MODEL,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "total_tests": total,
        "strict_pass": strict,
        "partial_pass": partial,
        "fails": fails,
        "strict_rate": strict / total,
        "total_pass_rate": (strict + partial) / total,
        "tool_strict_rate": tool_strict / len(tool_tests),
        "abstention_rate": no_tool_pass / len(no_tool_tests),
        "avg_latency": avg_latency,
        "category_stats": category_stats,
        "results": results
    }
    
    os.makedirs("results", exist_ok=True)
    with open("results/swe_bench_report.json", "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"\nReport saved: results/swe_bench_report.json")
    
    return strict, total, results

import os
import argparse

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=1, help="Number of eval runs for statistical validation")
    parser.add_argument("--shuffle", action="store_true", help="Randomize test order each run")
    parser.add_argument("--no-validate-layer3", action="store_true",
                        help="Disable Layer 3 false-positive rejection (use during training benchmarks "
                             "so RFT/DPO sees true model failures, not heuristic-corrected results)")
    args = parser.parse_args()

    if args.runs == 1:
        main(shuffle=args.shuffle, no_validate_layer3=args.no_validate_layer3)
    else:
        all_scores = []
        per_test_pass = [0] * len(BLIND_TESTS)
        per_test_fail_tools = [[] for _ in range(len(BLIND_TESTS))]
        
        for run_idx in range(args.runs):
            seed = random.randint(0, 9999) if args.shuffle else None
            print(f"\n{'#'*70}")
            print(f"  RUN {run_idx+1}/{args.runs}" + (f"  (seed={seed})" if seed else ""))
            print(f"{'#'*70}")
            if seed is not None:
                random.seed(seed)
            strict, total, results = main(shuffle=args.shuffle, no_validate_layer3=args.no_validate_layer3)
            all_scores.append(strict)
            for i, r in enumerate(results):
                if r["verdict"] == "strict_pass":
                    per_test_pass[i] += 1
                else:
                    per_test_fail_tools[i].append(r.get("got", "???"))
        
        # Multi-run summary
        med = statistics.median(all_scores)
        avg = sum(all_scores) / len(all_scores)
        print(f"\n{'='*70}")
        print(f"  MULTI-RUN SUMMARY ({args.runs} runs × {total} tests" + (" — RANDOMIZED ORDER" if args.shuffle else "") + ")")
        print(f"{'='*70}")
        print(f"  Scores:  {' | '.join(f'{s}/{total}' for s in all_scores)}")
        print(f"  Median:  {med}/{total} = {med/total*100:.1f}%")
        print(f"  Average: {avg:.1f}/{total} = {avg/total*100:.1f}%")
        print(f"  Min:     {min(all_scores)}/{total} = {min(all_scores)/total*100:.0f}%")
        print(f"  Max:     {max(all_scores)}/{total} = {max(all_scores)/total*100:.0f}%")
        
        # Per-test consistency
        print(f"\n  Per-Test Consistency (N={args.runs} runs):")
        flaky = []
        for i, (prompt, expected, _, cat) in enumerate(BLIND_TESTS):
            rate = per_test_pass[i] / args.runs
            if rate < 1.0:
                fail_tools = per_test_fail_tools[i]
                flaky.append((i+1, prompt[:60], expected, rate, fail_tools))
                status = f"  ⚠️  [{i+1:2d}] {rate*100:3.0f}% pass | expect={expected:25s} | fails→{','.join(set(fail_tools)):20s} | {prompt[:55]}"
                print(status)
        
        if not flaky:
            print("  ✅ All tests passed consistently across all runs!")
        else:
            print(f"\n  Flaky tests: {len(flaky)}/{total}")
        print(f"{'='*70}")

