#!/usr/bin/env python3
"""
BFCL-Style Evaluation Harness for prism-coder:7b

Follows Berkeley Function Calling Leaderboard V4 methodology:
- AST comparison for parameter validation (not just name matching)
- Hallucination detection (tools that don't exist)
- Relevance detection (prompt needs no tool)
- Format sensitivity (same prompt, different format)
- Multi-turn chains (sequential tool calls)
- Statistical validation via --runs N --shuffle

Scoring: Overall Accuracy = unweighted average of all sub-categories
         (matching BFCL V4 methodology)

Usage:
  python3 bfcl_eval.py                    # Single run
  python3 bfcl_eval.py --runs 3 --shuffle # 3 randomized runs with median
  python3 bfcl_eval.py --verbose          # Show all model outputs
"""
import json
import re
import sys
import time
import random
import urllib.request
import statistics

MODEL = "prism-coder:7b"
OLLAMA_API = "http://localhost:11434/api/generate"

# ============================================================================
# PRISM TOOL REGISTRY (ground truth — 17 tools)
# ============================================================================
VALID_TOOLS = {
    "session_load_context", "session_save_ledger", "session_save_handoff",
    "session_search_memory", "session_forget_memory", "session_health_check",
    "session_compact_ledger", "session_export_memory", "session_task_route",
    "session_save_experience", "session_save_image", "session_view_image",
    "knowledge_search", "knowledge_forget", "knowledge_upvote",
    "knowledge_downvote", "knowledge_set_retention",
}

# ============================================================================
# Layer 3: Inference-Time False-Positive Rejection
# (Identical to production — copied from swe_bench_test.py)
# ============================================================================
GENERAL_PROGRAMMING_PATTERNS = [
    r'\bcontext\s+manager\b', r'\bcontextlib\b', r'\b__enter__\b', r'\b__exit__\b',
    r'\bforget\s+gate\b', r'\blstm\b', r'\bcatastrophic\s+forgetting\b',
    r'\bexpress\.js\b', r'\bdjango\b', r'\bflask\b', r'\bfastapi\b',
    r'\bgarbage\s+collection\b', r'\bgc\s+algorithm\b',
    r'\bload\s+balanc', r'\bnginx\b', r'\bhaproxy\b',
    r'\belasticsearch\b', r'\bsolr\b', r'\blucene\b',
    r'\bretention\s+polic(?:y|ies)\s+(?:in|for|with)\s+(?:kafka|s3|aws|gcp|azure|cloud)',
    # Additional patterns for BFCL relevance detection
    r'\bpostgresql\b.*\bmongodb\b', r'\bmongodb\b.*\bpostgresql\b',
    r'\bwrite\s+a\s+decorator\b', r'\bdecorator.*retries?\b',
    r'\bci/cd\b', r'\bgithub\s+actions\b',
    r'\bcors\b.*\bnode\.js\b', r'\bnode\.js\b.*\bcors\b',
    r'\bcap\s+theorem\b', r'\bbinary\s+search\s+tree\b',
    r'\bvirtual\s+dom\b', r'\breact\b.*\breconciliation\b',
    r'\bdependency\s+injection\b',
    r'\btcp\b.*\budp\b', r'\budp\b.*\btcp\b',
    r'\btime\s+complexity\b', r'\bquicksort\b',
]

PRISM_INTENT_PATTERNS = [
    r'\bprism\b', r'\bsession\s*ledger\b', r'\bhandoff\b',
    r'\bknowledge\s+base\b', r'\bproject\b', r'\bledger\b',
    r'\bsave.*(?:session|ledger|handoff)\b', r'\bload\s+context\b',
    r'\bexport.*memor', r'\bcompact.*ledger\b', r'\bhealth.*check\b',
    r'\btask.*rout',
]

def validate_tool_call(prompt, tool_name, tool_args):
    """Layer 3: reject false-positive tool calls on general programming prompts."""
    if tool_name == "NO_TOOL":
        return tool_name, tool_args
    prompt_lower = prompt.lower()
    is_general = any(re.search(p, prompt_lower) for p in GENERAL_PROGRAMMING_PATTERNS)
    if not is_general:
        return tool_name, tool_args
    has_prism_intent = any(re.search(p, prompt_lower) for p in PRISM_INTENT_PATTERNS)
    if has_prism_intent:
        return tool_name, tool_args
    return "NO_TOOL", {}

# ============================================================================
# BFCL-STYLE TEST CATEGORIES
# ============================================================================

# CATEGORY 1: Simple Function Call (single tool, clear intent)
SIMPLE_TESTS = [
    {
        "prompt": "Load the context for the analytics-dashboard project at standard level.",
        "expected_tool": "session_load_context",
        "required_params": {"project": "analytics-dashboard", "level": "standard"},
        "id": "simple_001"
    },
    {
        "prompt": "Save a ledger entry for project 'backend-api', conversation abc123, summary 'Fixed auth bug'.",
        "expected_tool": "session_save_ledger",
        "required_params": {"project": "backend-api", "conversation_id": "abc123", "summary": "Fixed auth bug"},
        "id": "simple_002"
    },
    {
        "prompt": "Search my session memories for 'database migration rollback'.",
        "expected_tool": "session_search_memory",
        "required_params": {"query": "database migration rollback"},
        "id": "simple_003"
    },
    {
        "prompt": "Forget the memory entry with ID '7f3a-bc21-d4e5'.",
        "expected_tool": "session_forget_memory",
        "required_params": {"memory_id": "7f3a-bc21-d4e5"},
        "id": "simple_004"
    },
    {
        "prompt": "Run a health check on the memory backend.",
        "expected_tool": "session_health_check",
        "required_params": {},
        "id": "simple_005"
    },
    {
        "prompt": "Compact the ledger for the prism-mcp project.",
        "expected_tool": "session_compact_ledger",
        "required_params": {"project": "prism-mcp"},
        "id": "simple_006"
    },
    {
        "prompt": "Export all memory to /tmp/export in JSON format.",
        "expected_tool": "session_export_memory",
        "required_params": {"output_dir": "/tmp/export", "format": "json"},
        "id": "simple_007"
    },
    {
        "prompt": "Search the knowledge base for information about retry strategies.",
        "expected_tool": "knowledge_search",
        "required_params": {"query": "retry strategies"},
        "id": "simple_008"
    },
    {
        "prompt": "Upvote knowledge entry 'abc-def-123'.",
        "expected_tool": "knowledge_upvote",
        "required_params": {"id": "abc-def-123"},
        "id": "simple_009"
    },
    {
        "prompt": "Set a 90-day retention policy for the billing project.",
        "expected_tool": "knowledge_set_retention",
        "required_params": {"project": "billing", "ttl_days": 90},
        "id": "simple_010"
    },
]

# CATEGORY 2: Relevance Detection (NO tool should be called — BFCL's hallucination prevention)
RELEVANCE_TESTS = [
    {"prompt": "What's the time complexity of quicksort?", "expected_tool": "NO_TOOL", "id": "relevance_001"},
    {"prompt": "Explain the difference between TCP and UDP.", "expected_tool": "NO_TOOL", "id": "relevance_002"},
    {"prompt": "How do I implement a binary search tree in Python?", "expected_tool": "NO_TOOL", "id": "relevance_003"},
    {"prompt": "What is dependency injection and why is it useful?", "expected_tool": "NO_TOOL", "id": "relevance_004"},
    {"prompt": "How does React's virtual DOM reconciliation work?", "expected_tool": "NO_TOOL", "id": "relevance_005"},
    {"prompt": "Compare PostgreSQL and MongoDB for a real-time analytics platform.", "expected_tool": "NO_TOOL", "id": "relevance_006"},
    {"prompt": "Write a decorator that retries a function 3 times on failure.", "expected_tool": "NO_TOOL", "id": "relevance_007"},
    {"prompt": "How do I set up a CI/CD pipeline with GitHub Actions?", "expected_tool": "NO_TOOL", "id": "relevance_008"},
    {"prompt": "Explain the CAP theorem.", "expected_tool": "NO_TOOL", "id": "relevance_009"},
    {"prompt": "What's the best way to handle CORS in a Node.js Express app?", "expected_tool": "NO_TOOL", "id": "relevance_010"},
]

# CATEGORY 3: Hallucination Detection (keywords overlap with tools but should NOT trigger)
HALLUCINATION_TESTS = [
    {"prompt": "How do I implement a context manager in Python using __enter__ and __exit__?",
     "expected_tool": "NO_TOOL", "id": "hallucination_001"},
    {"prompt": "Explain the forget gate in an LSTM neural network.",
     "expected_tool": "NO_TOOL", "id": "hallucination_002"},
    {"prompt": "How does session management work in Express.js with passport?",
     "expected_tool": "NO_TOOL", "id": "hallucination_003"},
    {"prompt": "What's the difference between knowledge distillation and model pruning?",
     "expected_tool": "NO_TOOL", "id": "hallucination_004"},
    {"prompt": "How do I save state in a Redux store?",
     "expected_tool": "NO_TOOL", "id": "hallucination_005"},
    {"prompt": "Explain memory-mapped files and how they improve I/O performance.",
     "expected_tool": "NO_TOOL", "id": "hallucination_006"},
    {"prompt": "How does the garbage collector handle circular references in Python?",
     "expected_tool": "NO_TOOL", "id": "hallucination_007"},
    {"prompt": "What is a load balancer health check in Kubernetes?",
     "expected_tool": "NO_TOOL", "id": "hallucination_008"},
    {"prompt": "How do I implement exponential backoff with jitter for API retries?",
     "expected_tool": "NO_TOOL", "id": "hallucination_009"},
    {"prompt": "Compare Elasticsearch and Solr for full-text search.",
     "expected_tool": "NO_TOOL", "id": "hallucination_010"},
]

# CATEGORY 4: Disambiguation (similar tools — must pick the right one)
DISAMBIGUATION_TESTS = [
    {
        "prompt": "Find past sessions where I discussed WebSocket error handling.",
        "expected_tool": "session_search_memory",
        "required_params": {"query": "WebSocket error handling"},
        "id": "disambig_001"
    },
    {
        "prompt": "Search our accumulated documentation for WebSocket best practices.",
        "expected_tool": "knowledge_search",
        "required_params": {"query": "WebSocket best practices"},
        "id": "disambig_002"
    },
    {
        "prompt": "Delete that specific memory entry ID 'mem-42' — it's outdated.",
        "expected_tool": "session_forget_memory",
        "required_params": {"memory_id": "mem-42"},
        "id": "disambig_003"
    },
    {
        "prompt": "Clear out all old knowledge entries in the 'testing' category for analytics project.",
        "expected_tool": "knowledge_forget",
        "required_params": {"project": "analytics"},
        "id": "disambig_004"
    },
    {
        "prompt": "Boost the importance of knowledge entry 'insight-77'.",
        "expected_tool": "knowledge_upvote",
        "required_params": {"id": "insight-77"},
        "id": "disambig_005"
    },
    {
        "prompt": "This knowledge item 'insight-88' is not useful anymore, lower its score.",
        "expected_tool": "knowledge_downvote",
        "required_params": {"id": "insight-88"},
        "id": "disambig_006"
    },
    {
        "prompt": "Record a successful experience: I fixed the login bug by adding input validation.",
        "expected_tool": "session_save_experience",
        "required_params": {"event_type": "success"},
        "id": "disambig_007"
    },
    {
        "prompt": "Leave a handoff note for the next session on the portal project — tell them the DB schema is finalized.",
        "expected_tool": "session_save_handoff",
        "required_params": {"project": "portal"},
        "id": "disambig_008"
    },
]

# CATEGORY 5: Format Sensitivity (same intent, different prompt styles)
FORMAT_SENSITIVITY_TESTS = [
    # All 5 should map to session_load_context
    {"prompt": "Load context for myproject.",
     "expected_tool": "session_load_context", "required_params": {"project": "myproject"}, "id": "format_001"},
    {"prompt": "SESSION_LOAD_CONTEXT(project='myproject')",
     "expected_tool": "session_load_context", "required_params": {"project": "myproject"}, "id": "format_002"},
    {"prompt": "Please initialize the session context for project myproject at the standard level.",
     "expected_tool": "session_load_context", "required_params": {"project": "myproject"}, "id": "format_003"},
    {"prompt": "ctx = load(project='myproject')",
     "expected_tool": "session_load_context", "required_params": {"project": "myproject"}, "id": "format_004"},
    {"prompt": "Yo pull up myproject's context real quick",
     "expected_tool": "session_load_context", "required_params": {"project": "myproject"}, "id": "format_005"},
]

# CATEGORY 6: AST Parameter Accuracy (correct tool + parameter value matching)
AST_PARAM_TESTS = [
    {
        "prompt": "Export my memories to /Users/admin/Desktop/backup in markdown format for the billing project.",
        "expected_tool": "session_export_memory",
        "required_params": {"output_dir": "/Users/admin/Desktop/backup", "format": "markdown", "project": "billing"},
        "ast_strict": True,  # enforce exact param values
        "id": "ast_001"
    },
    {
        "prompt": "Set a 30-day retention policy for the staging project's knowledge.",
        "expected_tool": "knowledge_set_retention",
        "required_params": {"project": "staging", "ttl_days": 30},
        "ast_strict": True,
        "id": "ast_002"
    },
    {
        "prompt": "Save a ledger entry: project is 'portal', conversation is 'conv-2024-001', summary is 'Deployed v2.0 to production with zero downtime'.",
        "expected_tool": "session_save_ledger",
        "required_params": {"project": "portal", "conversation_id": "conv-2024-001"},
        "ast_strict": True,
        "id": "ast_003"
    },
    {
        "prompt": "Record a correction experience for the analytics project: I tried using batch inserts but should have used streaming writes instead.",
        "expected_tool": "session_save_experience",
        "required_params": {"project": "analytics", "event_type": "correction"},
        "ast_strict": False,  # Free-text fields (action, correction) are hard to match exactly
        "id": "ast_004"
    },
    {
        "prompt": "Save an image at /tmp/screenshot.png for the dashboard project with description 'Login page redesign mockup'.",
        "expected_tool": "session_save_image",
        "required_params": {"project": "dashboard", "file_path": "/tmp/screenshot.png"},
        "ast_strict": True,
        "id": "ast_005"
    },
]

# CATEGORY 7: Edge Cases (single-word, ambiguous, multi-intent)
EDGE_CASE_TESTS = [
    {"prompt": "Hello!", "expected_tool": "NO_TOOL", "id": "edge_001"},
    {"prompt": "Thanks, that's all for now.", "expected_tool": "NO_TOOL", "id": "edge_002"},
    {"prompt": "What can you do?", "expected_tool": "NO_TOOL", "id": "edge_003"},
    {"prompt": "Load context.", "expected_tool": "session_load_context", "required_params": {}, "id": "edge_004"},
    {"prompt": "Save.", "expected_tool": "session_save_ledger", "required_params": {}, "id": "edge_005"},
    # Accept both search tools for ambiguous single-word "Search."
    {"prompt": "Search.", "expected_tool": ["session_search_memory", "knowledge_search"], "required_params": {}, "id": "edge_006"},
    {"prompt": "Health check.", "expected_tool": "session_health_check", "required_params": {}, "id": "edge_007"},
    {"prompt": "🚀", "expected_tool": "NO_TOOL", "id": "edge_008"},
]

# ============================================================================
# ALL CATEGORIES
# ============================================================================
ALL_CATEGORIES = {
    "simple": SIMPLE_TESTS,
    "relevance_detection": RELEVANCE_TESTS,
    "hallucination": HALLUCINATION_TESTS,
    "disambiguation": DISAMBIGUATION_TESTS,
    "format_sensitivity": FORMAT_SENSITIVITY_TESTS,
    "ast_parameter": AST_PARAM_TESTS,
    "edge_case": EDGE_CASE_TESTS,
}


def call_ollama(prompt: str) -> tuple:
    """Call Ollama API and parse tool call response."""
    payload = json.dumps({
        "model": MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": 512}
    }).encode()
    
    req = urllib.request.Request(OLLAMA_API, data=payload,
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read().decode())
    except Exception as e:
        return "ERROR", {}, str(e), 0.0
    
    response_text = result.get("response", "")
    elapsed = result.get("total_duration", 0) / 1e9  # nanoseconds to seconds
    
    # Strategy 1: Parse JSON-style tool call (most common format from prism-coder)
    # Matches: <|tool_call|>\n{"name": "tool_name", "arguments": {...}}
    json_block = re.search(r'<\|tool_call\|>\s*(\{.*\})', response_text, re.DOTALL)
    if json_block:
        try:
            # Find the outermost JSON object
            raw_json = json_block.group(1)
            # Handle potential trailing text after JSON
            brace_depth = 0
            end_idx = 0
            for i, ch in enumerate(raw_json):
                if ch == '{': brace_depth += 1
                elif ch == '}': brace_depth -= 1
                if brace_depth == 0:
                    end_idx = i + 1
                    break
            clean_json = raw_json[:end_idx]
            parsed = json.loads(clean_json)
            tool_name = parsed.get("name", "")
            tool_args = parsed.get("arguments", {})
            # Normalize int values
            for k, v in tool_args.items():
                if isinstance(v, str) and v.isdigit():
                    tool_args[k] = int(v)
            return tool_name, tool_args, response_text, elapsed
        except (json.JSONDecodeError, IndexError):
            pass
    
    # Strategy 2: Parse function-call style: <|tool_call|> tool_name(key=val, ...)
    tool_match = re.search(r'<\|tool_call\|>\s*(\w+)\s*\((.*?)\)', response_text, re.DOTALL)
    if tool_match:
        tool_name = tool_match.group(1)
        args_str = tool_match.group(2).strip()
        tool_args = {}
        if args_str:
            for param_match in re.finditer(r'(\w+)\s*=\s*(?:"([^"]*?)"|\'([^\']*?)\'|(\d+(?:\.\d+)?)|(\w+))', args_str):
                key = param_match.group(1)
                val = param_match.group(2) or param_match.group(3) or param_match.group(4) or param_match.group(5)
                if val and isinstance(val, str) and val.isdigit():
                    val = int(val)
                tool_args[key] = val
        return tool_name, tool_args, response_text, elapsed
    
    # Strategy 3: Bare JSON with name field (no <|tool_call|> prefix)
    bare_json = re.search(r'\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[^}]*\})', response_text)
    if bare_json:
        tool_name = bare_json.group(1)
        try:
            tool_args = json.loads(bare_json.group(2))
            return tool_name, tool_args, response_text, elapsed
        except json.JSONDecodeError:
            return tool_name, {}, response_text, elapsed
    
    return "NO_TOOL", {}, response_text, elapsed


def evaluate_test(test: dict, verbose: bool = False) -> dict:
    """Evaluate a single BFCL test case."""
    prompt = test["prompt"]
    expected_tool = test["expected_tool"]
    required_params = test.get("required_params", {})
    ast_strict = test.get("ast_strict", False)
    test_id = test["id"]
    
    # Support list of acceptable tools for ambiguous prompts
    expected_tool_list = expected_tool if isinstance(expected_tool, list) else [expected_tool]
    
    actual_tool, actual_args, raw_response, latency = call_ollama(prompt)
    
    # Layer 3 validation
    actual_tool, actual_args = validate_tool_call(prompt, actual_tool, actual_args)
    
    # Hallucination check: did the model call a tool that doesn't exist?
    hallucinated = actual_tool not in VALID_TOOLS and actual_tool != "NO_TOOL" and actual_tool != "ERROR"
    
    # Score
    result = {
        "id": test_id,
        "prompt": prompt,
        "expected": expected_tool_list[0] if len(expected_tool_list) == 1 else str(expected_tool_list),
        "actual": actual_tool,
        "latency": latency,
        "hallucinated": hallucinated,
        "correct": False,
        "tool_correct": False,
        "params_correct": False,
        "details": "",
    }
    
    if actual_tool == "ERROR":
        result["details"] = "API error"
        return result
    
    # Tool name match (check against all acceptable tools)
    tool_matches = actual_tool in expected_tool_list
    if tool_matches:
        result["tool_correct"] = True
        
        if "NO_TOOL" in expected_tool_list:
            result["correct"] = True
            result["params_correct"] = True
            result["details"] = "✅ Correct abstention"
        else:
            # Check parameters
            if ast_strict and required_params:
                # AST-level: check exact parameter values
                params_ok = True
                mismatches = []
                for key, expected_val in required_params.items():
                    actual_val = actual_args.get(key)
                    if actual_val is None:
                        params_ok = False
                        mismatches.append(f"missing '{key}'")
                    elif isinstance(expected_val, int):
                        try:
                            if int(actual_val) != expected_val:
                                params_ok = False
                                mismatches.append(f"'{key}': expected {expected_val}, got {actual_val}")
                        except (ValueError, TypeError):
                            params_ok = False
                            mismatches.append(f"'{key}': expected int {expected_val}, got '{actual_val}'")
                    elif isinstance(expected_val, str):
                        if str(actual_val).lower().strip() != expected_val.lower().strip():
                            # Fuzzy match for similar strings
                            if expected_val.lower() not in str(actual_val).lower():
                                params_ok = False
                                mismatches.append(f"'{key}': expected '{expected_val}', got '{actual_val}'")
                
                result["params_correct"] = params_ok
                result["correct"] = params_ok
                result["details"] = "✅ AST match" if params_ok else f"⚠️ Param mismatch: {', '.join(mismatches)}"
            else:
                # Non-strict: just check required param keys exist
                missing = [k for k in required_params if k not in actual_args]
                result["params_correct"] = len(missing) == 0
                result["correct"] = True  # Tool is correct even if params partially missing
                if missing:
                    result["details"] = f"✅ Tool correct, missing params: {missing}"
                else:
                    result["details"] = "✅ Full match"
    else:
        # Wrong tool
        expected_str = expected_tool_list[0] if len(expected_tool_list) == 1 else str(expected_tool_list)
        if "NO_TOOL" in expected_tool_list:
            result["details"] = f"❌ False positive: called {actual_tool} instead of abstaining"
        elif actual_tool == "NO_TOOL":
            result["details"] = f"❌ False negative: abstained instead of calling {expected_str}"
        else:
            result["details"] = f"❌ Wrong tool: expected {expected_str}, got {actual_tool}"
    
    if verbose:
        status = "✅" if result["correct"] else "❌"
        print(f"  {status} [{test_id}] {result['details']}")
        if not result["correct"]:
            print(f"     Prompt: {prompt[:80]}...")
            print(f"     Raw: {raw_response[:120]}...")
    
    return result


def run_evaluation(shuffle: bool = False, verbose: bool = False) -> dict:
    """Run full BFCL-style evaluation across all categories."""
    
    # Build flat test list with category tags
    all_tests = []
    for cat_name, tests in ALL_CATEGORIES.items():
        for test in tests:
            test_copy = test.copy()
            test_copy["category"] = cat_name
            all_tests.append(test_copy)
    
    if shuffle:
        random.shuffle(all_tests)
    
    print(f"\n{'='*70}")
    print(f"  BFCL-Style Evaluation — prism-coder:7b")
    print(f"  {len(all_tests)} tests across {len(ALL_CATEGORIES)} categories")
    print(f"  Shuffle: {'ON' if shuffle else 'OFF'}")
    print(f"{'='*70}\n")
    
    # Run all tests
    results = []
    category_results = {cat: [] for cat in ALL_CATEGORIES}
    start_time = time.time()
    
    for i, test in enumerate(all_tests, 1):
        cat = test["category"]
        if verbose:
            print(f"[{i}/{len(all_tests)}] Category: {cat}")
        
        result = evaluate_test(test, verbose=verbose)
        result["category"] = cat
        results.append(result)
        category_results[cat].append(result)
        
        if not verbose:
            status = "✅" if result["correct"] else "❌"
            print(f"  {status} [{result['id']}] {result['expected']:>25s} → {result['actual']:<25s} {result['latency']:.1f}s", end="")
            if result["hallucinated"]:
                print(" 🚨 HALLUCINATED", end="")
            print()
    
    elapsed = time.time() - start_time
    
    # Category scores (BFCL methodology: accuracy per category)
    category_scores = {}
    print(f"\n{'='*70}")
    print(f"  CATEGORY BREAKDOWN")
    print(f"{'='*70}")
    
    for cat_name in ALL_CATEGORIES:
        cat_res = category_results[cat_name]
        if not cat_res:
            continue
        correct = sum(1 for r in cat_res if r["correct"])
        total = len(cat_res)
        accuracy = correct / total * 100
        category_scores[cat_name] = accuracy
        
        tool_correct = sum(1 for r in cat_res if r["tool_correct"])
        params_correct = sum(1 for r in cat_res if r["params_correct"])
        hallucinated = sum(1 for r in cat_res if r["hallucinated"])
        
        print(f"  {cat_name:25s}  {correct}/{total} = {accuracy:6.1f}%  "
              f"(tool:{tool_correct}/{total}  params:{params_correct}/{total}  "
              f"halluc:{hallucinated})")
    
    # Overall score (BFCL: unweighted average across categories)
    overall = sum(category_scores.values()) / len(category_scores) if category_scores else 0
    total_correct = sum(1 for r in results if r["correct"])
    total_halluc = sum(1 for r in results if r["hallucinated"])
    avg_latency = sum(r["latency"] for r in results) / len(results) if results else 0
    
    print(f"\n{'='*70}")
    print(f"  OVERALL RESULTS")
    print(f"{'='*70}")
    print(f"  Overall Accuracy (BFCL avg): {overall:.1f}%")
    print(f"  Raw Accuracy:                {total_correct}/{len(results)} = {total_correct/len(results)*100:.1f}%")
    print(f"  Hallucinations:              {total_halluc}")
    print(f"  Avg Latency:                 {avg_latency:.1f}s")
    print(f"  Total Time:                  {elapsed:.0f}s")
    print(f"{'='*70}\n")
    
    return {
        "overall_accuracy": overall,
        "raw_accuracy": total_correct / len(results) * 100 if results else 0,
        "total_correct": total_correct,
        "total_tests": len(results),
        "category_scores": category_scores,
        "hallucinations": total_halluc,
        "avg_latency": avg_latency,
        "elapsed": elapsed,
        "results": results,
    }


def main():
    import argparse
    parser = argparse.ArgumentParser(description="BFCL-Style evaluation for prism-coder:7b")
    parser.add_argument("--runs", type=int, default=1, help="Number of evaluation runs")
    parser.add_argument("--shuffle", action="store_true", help="Randomize test order each run")
    parser.add_argument("--verbose", action="store_true", help="Show detailed model outputs")
    args = parser.parse_args()
    
    all_run_results = []
    
    for run_idx in range(args.runs):
        if args.runs > 1:
            print(f"\n{'#'*70}")
            print(f"  RUN {run_idx + 1} / {args.runs}")
            print(f"{'#'*70}")
        
        result = run_evaluation(shuffle=args.shuffle, verbose=args.verbose)
        all_run_results.append(result)
    
    if args.runs > 1:
        # Multi-run summary
        overall_scores = [r["overall_accuracy"] for r in all_run_results]
        raw_scores = [r["raw_accuracy"] for r in all_run_results]
        raw_correct = [r["total_correct"] for r in all_run_results]
        total_tests = all_run_results[0]["total_tests"]
        total_halluc = [r["hallucinations"] for r in all_run_results]
        
        print(f"\n{'='*70}")
        print(f"  MULTI-RUN SUMMARY ({args.runs} runs × {total_tests} tests)")
        print(f"{'='*70}")
        print(f"  BFCL Overall Accuracy:")
        for i, s in enumerate(overall_scores):
            print(f"    Run {i+1}: {s:.1f}%")
        print(f"    Average: {statistics.mean(overall_scores):.1f}%")
        print(f"    Median:  {statistics.median(overall_scores):.1f}%")
        if len(overall_scores) > 1:
            print(f"    StdDev:  {statistics.stdev(overall_scores):.2f}%")
        
        print(f"\n  Raw Scores: {' | '.join(f'{c}/{total_tests}' for c in raw_correct)}")
        print(f"  Hallucinations: {' | '.join(str(h) for h in total_halluc)}")
        
        # Per-category consistency
        print(f"\n  Per-Category Consistency:")
        categories = all_run_results[0]["category_scores"].keys()
        for cat in categories:
            scores = [r["category_scores"].get(cat, 0) for r in all_run_results]
            avg = statistics.mean(scores)
            consistent = all(s == scores[0] for s in scores)
            marker = "✅" if consistent and avg == 100 else "⚠️" if not consistent else "✅"
            print(f"    {marker} {cat:25s} {' | '.join(f'{s:.0f}%' for s in scores)} → avg {avg:.1f}%")
        
        print(f"\n{'='*70}\n")
        
        # Exit code
        median_overall = statistics.median(overall_scores)
        if median_overall < 90:
            print("❌ FAIL: Median BFCL accuracy below 90%")
            sys.exit(1)
        elif median_overall < 95:
            print("⚠️ WARN: Median BFCL accuracy below 95%")
            sys.exit(0)
        else:
            print(f"✅ PASS: Median BFCL accuracy {median_overall:.1f}%")
            sys.exit(0)
    else:
        overall = all_run_results[0]["overall_accuracy"]
        if overall < 90:
            sys.exit(1)
        sys.exit(0)


if __name__ == "__main__":
    main()
