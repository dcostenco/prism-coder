"""
BFCL Training Data Generator v2

Generates training data aligned with BFCL v4 test categories using REAL
BFCL function definitions from multi_turn_func_doc/ directory.

Categories generated:
1. Irrelevance negatives (abstention training with real BFCL tools)
2. Multi-turn function calling (using actual BFCL API collections)
3. Miss-func detection (model should recognize missing tools)
4. Miss-param detection (model should ask for missing parameters)

Output: JSONL in Prism chat format with <|tool_call|> special tokens.

Usage:
    python generate_bfcl_training_data.py --output-dir ./data/bfcl
    python generate_bfcl_training_data.py --output-dir ./data/bfcl --bfcl-dir ~/gorilla-bfcl/berkeley-function-call-leaderboard
"""

import argparse
import json
import os
import random
import sys
from pathlib import Path
from typing import Optional

# Default paths
OLLAMA_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
DEFAULT_BFCL_DIR = Path.home() / "gorilla-bfcl" / "berkeley-function-call-leaderboard"


def load_bfcl_func_docs(bfcl_dir: Path) -> dict:
    """Load all real BFCL function doc definitions from multi_turn_func_doc/."""
    func_doc_dir = bfcl_dir / "bfcl_eval" / "data" / "multi_turn_func_doc"
    if not func_doc_dir.exists():
        print(f"Warning: BFCL func_doc dir not found: {func_doc_dir}")
        return {}
    
    collections = {}
    for json_file in sorted(func_doc_dir.glob("*.json")):
        api_name = json_file.stem
        functions = []
        with open(json_file) as f:
            for line in f:
                try:
                    func_def = json.loads(line.strip())
                    functions.append(func_def)
                except json.JSONDecodeError:
                    continue
        if functions:
            collections[api_name] = functions
            print(f"  Loaded {len(functions)} functions from {api_name}")
    
    print(f"  Total: {sum(len(v) for v in collections.values())} functions across {len(collections)} API collections")
    return collections


# 40 irrelevant queries guaranteed to not match any BFCL tool
IRRELEVANT_QUERIES = [
    "What is the meaning of life?",
    "Can you write me a poem about the ocean?",
    "Explain quantum entanglement in simple terms.",
    "What's the difference between a crocodile and an alligator?",
    "Tell me a joke about programmers.",
    "How does photosynthesis work?",
    "What are the main causes of World War I?",
    "Can you explain the theory of relativity?",
    "What is the capital of Mongolia?",
    "How do you make sourdough bread?",
    "What programming language should I learn first?",
    "Explain the difference between TCP and UDP.",
    "What is the Fibonacci sequence?",
    "How does blockchain technology work?",
    "What are the benefits of meditation?",
    "Explain the water cycle.",
    "What is machine learning?",
    "How do vaccines work?",
    "What is the deepest part of the ocean?",
    "Can you summarize Romeo and Juliet?",
    "What are prime numbers?",
    "How does a combustion engine work?",
    "What is the greenhouse effect?",
    "Explain Newton's three laws of motion.",
    "What is the difference between a virus and bacteria?",
    "How does WiFi work?",
    "What are the planets in our solar system?",
    "Explain supply and demand.",
    "What is natural language processing?",
    "How do earthquakes happen?",
    "What is the Pythagorean theorem?",
    "Explain the concept of compound interest.",
    "What are the main types of renewable energy?",
    "How does DNA replication work?",
    "What is the speed of light?",
    "Explain the concept of opportunity cost.",
    "What are the different types of clouds?",
    "How does the human immune system work?",
    "What is the scientific method?",
    "Explain the difference between RAM and ROM.",
]

# Abstention response templates
ABSTENTION_RESPONSES = [
    "<|synalux_answer|>I don't have a suitable function to help with that query. The available tools are not relevant to your request.</|synalux_answer|>",
    "<|synalux_answer|>None of the available tools can assist with this question. I can only help with tasks related to the provided functions.</|synalux_answer|>",
    "<|synalux_answer|>This query is outside the scope of the available tools. I cannot call any function to address this request.</|synalux_answer|>",
    "<|synalux_answer|>The provided functions don't cover this topic. I'm unable to assist with this query using the available tools.</|synalux_answer|>",
    "<|synalux_answer|>I don't have the right tools for this request. The available functions are designed for different purposes.</|synalux_answer|>",
    "<|synalux_answer|>There are no relevant functions available to answer your question. Let me know if you need help with something the available tools can handle.</|synalux_answer|>",
    "<|synalux_answer|>The available tools cannot help with this kind of request. This falls outside their intended functionality.</|synalux_answer|>",
    "<|synalux_answer|>I appreciate the question, but none of the provided functions are applicable here. I can only assist with function-specific tasks.</|synalux_answer|>",
]


from config import (  # R4-3 + R5: Single source of truth
    format_system_prompt,
    build_smcot_think,
    build_dryrun_smcot_think,
    TOKEN_THINK_OPEN,
    TOKEN_THINK_CLOSE,
    TOKEN_TOOL_CALL_OPEN,
    TOKEN_TOOL_CALL_CLOSE,
    TOKEN_ANSWER_OPEN,
    TOKEN_ANSWER_CLOSE,
    DESTRUCTIVE_TOOLS,
)


def format_as_raw_text(messages: list, tools: list) -> str:
    """Format messages into raw text matching PrismCoderHandler._format_prompt exactly.
    
    CRITICAL: This ensures training data uses the IDENTICAL format that the handler
    produces during evaluation, eliminating training-inference prompt mismatch.
    """
    formatted = ""
    
    # System prompt with tools
    if tools:
        formatted += "<|im_start|>system\n"
        if messages[0]["role"] == "system":
            formatted += messages[0]["content"]
        else:
            formatted += format_system_prompt(tools)
        formatted += "<|im_end|>\n"
    
    # Conversation messages
    start_idx = 1 if messages[0]["role"] == "system" else 0
    for msg in messages[start_idx:]:
        role = msg["role"]
        content = msg.get("content", "")
        
        if role == "user":
            formatted += f"<|im_start|>user\n{content}<|im_end|>\n"
        elif role == "assistant":
            formatted += f"<|im_start|>assistant\n{content}<|im_end|>\n"
        elif role == "tool":
            # Synalux tool response format
            formatted += f"<|im_start|>tool\n<|tool_response|>\n{content}\n</|tool_response|><|im_end|>\n"
    
    return formatted


def unroll_multi_turn(messages: list, tools: list) -> list:
    """Convert a multi-turn conversation into a single ChatML training example.
    
    mlx_lm.lora natively handles multi-turn conversations by computing
    cross-entropy loss only on assistant tokens (role-based masking).
    We do NOT unroll into separate examples per turn — that causes Turn 1
    to receive N× gradient weight in an N-turn conversation, biasing
    the model against long-context reasoning.
    
    Output format: list of {"messages": [...]} dicts — one example per conversation.
    """
    # Strip any tool_calls metadata that mlx_lm won't understand
    clean_messages = []
    for msg in messages:
        clean = {"role": msg["role"], "content": msg.get("content", "")}
        clean_messages.append(clean)
    
    return [{"messages": clean_messages}]


# === NOISY TRAJECTORY INJECTION (Agent Stumble Prevention) ===
# 15% of multi-turn examples get an interruption to teach the model
# to handle context shifts without freezing or hallucinating.
INTERRUPTION_TEMPLATES = [
    "Wait, before that — {question}",
    "Actually, hold on. {question}",
    "One more thing first: {question}",
    "Before you do that, {question}",
    "Hmm, actually ignore the last thing. {question}",
    "Let me change my mind. {question}",
]

INTERRUPTION_QUESTIONS = [
    "what's the current status of everything?",
    "can you list what we've done so far?",
    "is there anything pending?",
    "how much storage space is left?",
    "what was the result of the first operation?",
    "never mind about the last step, just show me the current state.",
    "actually, let's check the account balance first.",
    "wait, what time is it in Tokyo right now?",
    "can you summarize what happened so far?",
    "hold on, I need to check something else first.",
]

INTERRUPTION_RESPONSES = [
    "I don't have a function available to answer that question. Based on what we've done so far: {summary}",
    "That question is outside the scope of the available tools. Let me know if you'd like to continue with the previous task.",
    "I can't help with that specific request using the available functions. Would you like to continue where we left off?",
]

# Tool-switching interruption templates (model must call a DIFFERENT tool, not just refuse)
TOOL_SWITCH_INTERRUPTIONS = [
    {"query": "Wait, before that — what files are in the current directory?",
     "func": "ls", "args": {}, "result": '["file1.txt", "file2.txt"]'},
    {"query": "Actually hold on, check the stock price of TSLA first.",
     "func": "get_stock_info", "args": {"symbol": "TSLA"}, "result": '{"symbol": "TSLA", "price": 245.20}'},
    {"query": "Hmm, actually check my account balance before we continue.",
     "func": "check_budget", "args": {}, "result": '{"balance": 10000.00}'},
]


def generate_irrelevance_negatives(output_path: Path, collections: dict, num_examples: int = 2000):
    """Generate training examples where the model should NOT call any function.
    
    Uses REAL BFCL tool definitions paired with irrelevant queries.
    """
    examples = []
    api_keys = list(collections.keys())
    
    for i in range(num_examples):
        # Pick 1-3 random API collections and combine their functions
        num_apis = random.randint(1, min(3, len(api_keys)))
        selected_apis = random.sample(api_keys, num_apis)
        tools = []
        for api in selected_apis:
            tools.extend(collections[api])
        
        query = random.choice(IRRELEVANT_QUERIES)
        response = random.choice(ABSTENTION_RESPONSES)
        
        example = {
            "messages": [
                {"role": "system", "content": format_system_prompt(tools)},
                {"role": "user", "content": query},
                {"role": "assistant", "content": response},
            ],
            "category": "irrelevance",
        }
        # Unroll to prompt/completion pair for loss masking (single-turn = 1 pair)
        pairs = unroll_multi_turn(example["messages"], tools)
        for pc in pairs:
            pc["category"] = "irrelevance"
            examples.append(pc)
    
    output_file = output_path / "irrelevance_train.jsonl"
    with open(output_file, "w") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")
    
    print(f"Generated {len(examples)} irrelevance examples -> {output_file}")
    return examples


def generate_multiturn_examples(output_path: Path, collections: dict, num_examples: int = 20):
    """Generate multi-turn function calling training data.
    
    NOTE: num_examples set to 20 to prevent catastrophic overfitting to hardcoded
    templates. SFT data should act as a gentle FORMATTING reminder, not a knowledge
    base. Each example is unrolled into 2-3 prompt/completion pairs, so effective
    training samples are ~50. Overfitting causes "Template Memorization" where the
    model loses its pre-trained generalizations.
    
    Uses REAL BFCL tool definitions. Each example is a multi-turn conversation
    with 2-4 turns of function calls followed by tool responses.
    """
    examples = []
    
    # Multi-turn scenario templates using real BFCL API collections
    scenario_templates = [
        # GorillaFileSystem scenarios
        {
            "apis": ["gorilla_file_system"],
            "turns": [
                {"query": "Create a new directory called 'reports' in the current location", "func": "mkdir", "args": {"dir_name": "reports"}, "result": '{"message": "Directory \'reports\' created successfully."}'},
                {"query": "List all files in the current directory", "func": "ls", "args": {}, "result": '["reports", "readme.txt", "data.csv"]'},
                {"query": "Move data.csv into the reports directory", "func": "mv", "args": {"source": "data.csv", "destination": "reports/data.csv"}, "result": '{"message": "File moved successfully."}'},
            ]
        },
        {
            "apis": ["gorilla_file_system"],
            "turns": [
                {"query": "What files are in my current directory?", "func": "ls", "args": {}, "result": '["main.py", "utils.py", "test.py", "config.json"]'},
                {"query": "Search for 'import' in main.py", "func": "grep", "args": {"file_name": "main.py", "pattern": "import"}, "result": '["import os", "import json", "import sys"]'},
                {"query": "Show me the content of config.json", "func": "cat", "args": {"file_name": "config.json"}, "result": '{"database": "postgresql", "port": 5432}'},
            ]
        },
        # VehicleControl scenarios
        {
            "apis": ["vehicle_control"],
            "turns": [
                {"query": "Start the engine of my car", "func": "startEngine", "args": {"ignitionMode": "START"}, "result": '{"engineState": "running", "fuelLevel": 75.5}'},
                {"query": "Turn on the headlights", "func": "toggleLights", "args": {"mode": "on"}, "result": '{"lightsStatus": "on"}'},
                {"query": "What's the current fuel level?", "func": "fuelStatus", "args": {}, "result": '{"fuelLevel": 75.5, "range": 320}'},
            ]
        },
        # TradingBot scenarios
        {
            "apis": ["trading_bot"],
            "turns": [
                {"query": "What's the current price of AAPL?", "func": "get_stock_info", "args": {"symbol": "AAPL"}, "result": '{"symbol": "AAPL", "price": 185.50, "change": 2.3}'},
                {"query": "Place a buy order for 10 shares", "func": "place_order", "args": {"order_type": "Buy", "symbol": "AAPL", "price": 185.50, "amount": 10}, "result": '{"orderId": "ORD-12345", "status": "Pending"}'},
                {"query": "Check the status of my recent order", "func": "get_order_details", "args": {"order_id": 12345}, "result": '{"orderId": 12345, "status": "Completed", "price": 185.50, "amount": 10}'},
            ]
        },
        # MessageAPI scenarios
        {
            "apis": ["message_api"],
            "turns": [
                {"query": "Send a message to user 456 saying 'Meeting at 3pm'", "func": "send_message", "args": {"receiver_id": 456, "message": "Meeting at 3pm"}, "result": '{"status": "sent", "messageId": 789}'},
                {"query": "Show me my inbox messages", "func": "view_messages_sent", "args": {}, "result": '[{"id": 789, "to": 456, "message": "Meeting at 3pm", "time": "2024-01-15T14:30:00"}]'},
                {"query": "Search for messages containing 'budget'", "func": "search_messages", "args": {"keyword": "budget"}, "result": '[{"id": 101, "from": 123, "message": "Budget report attached", "time": "2024-01-14T09:00:00"}]'},
            ]
        },
        # TicketAPI scenarios
        {
            "apis": ["ticket_api"],
            "turns": [
                {"query": "Create a support ticket for a login issue", "func": "create_ticket", "args": {"title": "Login Issue", "description": "Cannot login to the platform", "priority": 3}, "result": '{"ticketId": "T-1001", "status": "Open"}'},
                {"query": "Get the details of that ticket", "func": "get_ticket", "args": {"ticket_id": 1001}, "result": '{"id": 1001, "title": "Login Issue", "status": "Open", "priority": 3}'},
                {"query": "Close that ticket as resolved", "func": "close_ticket", "args": {"ticket_id": 1001}, "result": '{"ticketId": 1001, "status": "Closed"}'},
            ]
        },
        # PostingAPI scenarios  
        {
            "apis": ["posting_api"],
            "turns": [
                {"query": "Create a post saying 'Excited about our new product launch!'", "func": "post_tweet", "args": {"content": "Excited about our new product launch!"}, "result": '{"id": 501, "status": "posted"}'},
                {"query": "Retweet post 501", "func": "retweet", "args": {"tweet_id": 501}, "result": '{"status": "retweeted"}'},
                {"query": "How many followers do I have?", "func": "get_user_stats", "args": {}, "result": '{"followers": 1250, "following": 380, "tweets": 42}'},
            ]
        },
        # === PARALLEL TOOL CALLING SCENARIOS ===
        # Critical for AST and Live categories where model must output multiple <tool_call> tags
        {
            "apis": ["gorilla_file_system"],
            "turns": [
                {"query": "Show me the contents of both main.py and config.json",
                 "parallel_calls": [
                     {"func": "cat", "args": {"file_name": "main.py"}},
                     {"func": "cat", "args": {"file_name": "config.json"}},
                 ],
                 "results": ['"import os\nimport json"', '{"db": "postgres"}']},
                {"query": "Now delete both files",
                 "parallel_calls": [
                     {"func": "rm", "args": {"file_name": "main.py"}},
                     {"func": "rm", "args": {"file_name": "config.json"}},
                 ],
                 "results": ['{"message": "main.py deleted"}', '{"message": "config.json deleted"}']},
            ]
        },
        {
            "apis": ["trading_bot"],
            "turns": [
                {"query": "What are the current prices of AAPL and TSLA?",
                 "parallel_calls": [
                     {"func": "get_stock_info", "args": {"symbol": "AAPL"}},
                     {"func": "get_stock_info", "args": {"symbol": "TSLA"}},
                 ],
                 "results": ['{"symbol": "AAPL", "price": 185.50}', '{"symbol": "TSLA", "price": 245.20}']},
                {"query": "Buy 10 shares of each",
                 "parallel_calls": [
                     {"func": "place_order", "args": {"order_type": "Buy", "symbol": "AAPL", "price": 185.50, "amount": 10}},
                     {"func": "place_order", "args": {"order_type": "Buy", "symbol": "TSLA", "price": 245.20, "amount": 10}},
                 ],
                 "results": ['{"orderId": "ORD-101", "status": "Pending"}', '{"orderId": "ORD-102", "status": "Pending"}']},
            ]
        },
        {
            "apis": ["message_api"],
            "turns": [
                {"query": "Send 'Meeting at 3pm' to users 456 and 789",
                 "parallel_calls": [
                     {"func": "send_message", "args": {"receiver_id": 456, "message": "Meeting at 3pm"}},
                     {"func": "send_message", "args": {"receiver_id": 789, "message": "Meeting at 3pm"}},
                 ],
                 "results": ['{"status": "sent", "messageId": 101}', '{"status": "sent", "messageId": 102}']},
            ]
        },
        {
            "apis": ["ticket_api"],
            "turns": [
                {"query": "Create tickets for both the login bug and the payment error",
                 "parallel_calls": [
                     {"func": "create_ticket", "args": {"title": "Login Bug", "description": "Users cannot log in", "priority": 1}},
                     {"func": "create_ticket", "args": {"title": "Payment Error", "description": "Payment processing fails", "priority": 2}},
                 ],
                 "results": ['{"ticketId": "T-2001", "status": "Open"}', '{"ticketId": "T-2002", "status": "Open"}']},
            ]
        },
    ]
    
    for i in range(num_examples):
        scenario = random.choice(scenario_templates)
        
        # Get tools from the specified APIs
        tools = []
        for api_name in scenario["apis"]:
            if api_name in collections:
                tools.extend(collections[api_name])
        
        if not tools:
            # Fallback: use all tools if specific API not found
            for api_name in random.sample(list(collections.keys()), min(2, len(collections))):
                tools.extend(collections[api_name])
        
        messages = [{"role": "system", "content": format_system_prompt(tools)}]
        
        # Randomly select turns from the scenario (min 1, max 3)
        max_turns = min(3, len(scenario["turns"]))
        if max_turns == 0:
            continue  # Skip empty scenarios
        num_turns = random.randint(1, max_turns)
        selected_turns = scenario["turns"][:num_turns]
        
        inject_interruption = len(selected_turns) >= 2 and random.random() < 0.15
        interruption_after_turn = random.randint(0, len(selected_turns) - 1) if inject_interruption else -1
        
        for turn_idx, turn in enumerate(selected_turns):
            messages.append({"role": "user", "content": turn["query"]})
            
            if "parallel_calls" in turn:
                # Parallel tool calling: multiple <tool_call> blocks in one assistant message
                tc_parts = []
                tool_calls_meta = []
                for call in turn["parallel_calls"]:
                    tc_json = json.dumps({"name": call["func"], "arguments": call["args"]})
                    tc_parts.append(f'<|tool_call|>\n{tc_json}\n</|tool_call|>')
                    tool_calls_meta.append({"function": {"name": call["func"], "arguments": call["args"]}})
                
                tc_text = '\n'.join(tc_parts)
                messages.append({
                    "role": "assistant",
                    "content": tc_text,
                    "tool_calls": tool_calls_meta,
                })
                
                # Each parallel call gets its own tool response
                for result in turn["results"]:
                    messages.append({"role": "tool", "content": result})
            else:
                # Sequential single tool call with reasoning
                tc_json = json.dumps({"name": turn["func"], "arguments": turn["args"]})
                think_text = f'<|synalux_think|>\nThe user wants to {turn["query"].lower()}. I should call {turn["func"]}.\n</|synalux_think|>\n'
                tc_text = f'{think_text}<|tool_call|>\n{tc_json}\n</|tool_call|>'
                messages.append({
                    "role": "assistant",
                    "content": tc_text,
                    "tool_calls": [{"function": {"name": turn["func"], "arguments": turn["args"]}}],
                })
                
                # Tool response
                messages.append({"role": "tool", "content": turn["result"]})
            
            # === NOISY TRAJECTORY INJECTION (inside loop, after specified turn) ===
            # Inject user interruption MID-CHAIN so model learns to handle context shifts
            if turn_idx == interruption_after_turn:
                # 50% chance: tool-switching (model calls a different tool)
                # 50% chance: verbal refusal (model recognizes out-of-scope question)
                if random.random() < 0.5 and TOOL_SWITCH_INTERRUPTIONS:
                    switch = random.choice(TOOL_SWITCH_INTERRUPTIONS)
                    messages.append({"role": "user", "content": switch["query"]})
                    tc_json = json.dumps({"name": switch["func"], "arguments": switch["args"]})
                    think_text = f'<|synalux_think|>\nThe user changed their request. I should call {switch["func"]}.\n</|synalux_think|>\n'
                    tc_text = f'{think_text}<|tool_call|>\n{tc_json}\n</|tool_call|>'
                    messages.append({"role": "assistant", "content": tc_text})
                    messages.append({"role": "tool", "content": switch["result"]})
                else:
                    template = random.choice(INTERRUPTION_TEMPLATES)
                    question = random.choice(INTERRUPTION_QUESTIONS)
                    interrupt_query = template.format(question=question)
                    messages.append({"role": "user", "content": interrupt_query})
                    
                    summary = "the previous operations completed successfully"
                    response = random.choice(INTERRUPTION_RESPONSES).format(summary=summary)
                    messages.append({"role": "assistant", "content": response})
        
        example_msgs = [
            {"role": "system", "content": format_system_prompt(tools)},
        ] + messages[1:]  # skip our system message, use formatted one
        
        # Unroll into separate prompt/completion pairs for each assistant turn
        pairs = unroll_multi_turn(example_msgs, tools)
        for pc in pairs:
            pc["category"] = "multi_turn"
            examples.append(pc)
    
    output_file = output_path / "multiturn_train.jsonl"
    with open(output_file, "w") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")
    
    print(f"Generated {len(examples)} multi-turn examples -> {output_file}")
    return examples


def generate_miss_func_examples(output_path: Path, collections: dict, num_examples: int = 500):
    """Generate examples where the model should recognize that needed functions are missing.
    
    Strategy: provide a subset of tools from an API and ask about functionality
    that requires a missing tool. Model should say it can't do that.
    """
    examples = []
    
    miss_func_queries = [
        ("gorilla_file_system", "cp", "Copy the file report.pdf to the backup directory"),
        ("gorilla_file_system", "chmod", "Change the permissions of script.sh to executable"),
        ("vehicle_control", "adjustClimateControl", "Set the car temperature to 72°F"),
        ("trading_bot", "cancel_order", "Cancel my pending order for TSLA"),
        ("message_api", "delete_message", "Delete the message I sent to user 456"),
        ("ticket_api", "edit_ticket", "Change the priority of ticket T-1001 to high"),
        ("posting_api", "delete_tweet", "Remove my last tweet"),
    ]
    
    for i in range(num_examples):
        api_name, excluded_func, query = random.choice(miss_func_queries)
        
        if api_name not in collections:
            continue
        
        # Remove the excluded function
        tools = [f for f in collections[api_name] if f.get("name") != excluded_func]
        
        if not tools or len(tools) == len(collections.get(api_name, [])):
            # Skip if no tools remain or function wasn't found
            continue
        
        response = random.choice(ABSTENTION_RESPONSES)
        
        msgs = [
            {"role": "system", "content": format_system_prompt(tools)},
            {"role": "user", "content": query},
            {"role": "assistant", "content": response},
        ]
        pairs = unroll_multi_turn(msgs, tools)
        for pc in pairs:
            pc["category"] = "miss_func"
            examples.append(pc)
    
    output_file = output_path / "miss_func_train.jsonl"
    with open(output_file, "w") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")
    
    print(f"Generated {len(examples)} miss-func examples -> {output_file}")
    return examples


def generate_grpo_pairs(output_path: Path, collections: dict, num_pairs: int = 800):
    """Generate GRPO preference pairs for irrelevance calibration.
    
    Each pair has:
    - chosen: correct abstention (no tool call)
    - rejected: hallucinated tool call
    """
    pairs = []
    api_keys = list(collections.keys())
    
    for i in range(num_pairs):
        # Pick random tools
        num_apis = random.randint(1, min(2, len(api_keys)))
        selected_apis = random.sample(api_keys, num_apis)
        tools = []
        for api in selected_apis:
            tools.extend(collections[api])
        
        query = random.choice(IRRELEVANT_QUERIES)
        
        # Chosen: correct abstention
        chosen_response = random.choice(ABSTENTION_RESPONSES)
        
        # Rejected: hallucinated tool call
        random_tool = random.choice(tools)
        tool_name = random_tool.get("name", "unknown_func")
        rejected_response = f'<|tool_call|>\n{{"name": "{tool_name}", "arguments": {{"query": "{query}"}}}}\n</|tool_call|>'
        
        pair = {
            "prompt": format_system_prompt(tools) + f"\n\nUser: {query}",
            "chosen": chosen_response,
            "rejected": rejected_response,
            "category": "irrelevance_grpo",
        }
        pairs.append(pair)
    
    output_file = output_path / "grpo_pairs.jsonl"
    with open(output_file, "w") as f:
        for pair in pairs:
            f.write(json.dumps(pair) + "\n")
    
    print(f"Generated {len(pairs)} GRPO preference pairs -> {output_file}")
    return pairs


# ============================================================================
# ENHANCEMENT 2: Agentic Error Recovery (targets 40% V4 weight)
# ============================================================================
# BFCL V4 introduced complex live APIs where things fail (404, missing param,
# disambiguation needed). Models that freeze or hallucinate on error get 
# heavily penalized. This teaches recovery.

ERROR_RECOVERY_SCENARIOS = [
    # API returns error → model asks user for clarification
    {
        "apis": ["gorilla_file_system"],
        "turns": [
            {"query": "Move report.pdf to the archive folder", "func": "mv", 
             "args": {"source": "report.pdf", "destination": "archive/report.pdf"},
             "result": '{"error": "FileNotFoundError: report.pdf does not exist in current directory"}',
             "is_error": True},
            {"recovery": '<|synalux_think|>\nThe file was not found. I should inform the user and suggest listing available files.\n</|synalux_think|>\n<|synalux_answer|>The file report.pdf was not found in the current directory. Would you like me to list the available files so you can find the correct name?</|synalux_answer|>'},
            {"query": "Yes, list the files", "func": "ls", "args": {},
             "result": '["budget_report.pdf", "readme.txt", "data.csv"]'},
        ]
    },
    # Disambiguation required
    {
        "apis": ["trading_bot"],
        "turns": [
            {"query": "Check the stock price of Apple", "func": "get_stock_info",
             "args": {"symbol": "AAPL"},
             "result": '{"error": "Ambiguous: Multiple tickers match. Did you mean AAPL (Apple Inc) or APLE (Apple Hospitality REIT)?"}',
             "is_error": True},
            {"recovery": '<|synalux_think|>\nThe API returned an ambiguity error. I need to clarify which ticker the user wants.\n</|synalux_think|>\n<|synalux_answer|>There are multiple matches for "Apple". Did you mean:\n1. AAPL — Apple Inc.\n2. APLE — Apple Hospitality REIT\nPlease specify which one.</|synalux_answer|>'},
            {"query": "Apple Inc, AAPL", "func": "get_stock_info",
             "args": {"symbol": "AAPL"},
             "result": '{"symbol": "AAPL", "price": 185.50, "change": 2.3}'},
        ]
    },
    # Missing required parameter  
    {
        "apis": ["message_api"],
        "turns": [
            {"query": "Send a message to John", "func": "send_message",
             "args": {"receiver_id": "John", "message": ""},
             "result": '{"error": "ValidationError: receiver_id must be an integer, got string. message cannot be empty."}',
             "is_error": True},
            {"recovery": '<|synalux_think|>\nThe API requires receiver_id as an integer and message cannot be empty. I need to ask the user for the receiver\'s numeric ID and the message content.\n</|synalux_think|>\n<|synalux_answer|>I need two things to send the message:\n1. John\'s numeric user ID (not his name)\n2. The message content\nCould you provide both?</|synalux_answer|>'},
            {"query": "His ID is 456 and the message is 'Meeting at 3pm'", "func": "send_message",
             "args": {"receiver_id": 456, "message": "Meeting at 3pm"},
             "result": '{"status": "sent", "messageId": 789}'},
        ]
    },
    # Rate limit / timeout retry
    {
        "apis": ["trading_bot"],
        "turns": [
            {"query": "Place a buy order for 50 shares of TSLA at market price", "func": "place_order",
             "args": {"order_type": "Buy", "symbol": "TSLA", "price": 245.20, "amount": 50},
             "result": '{"error": "RateLimitExceeded: Too many requests. Retry after 5 seconds."}',
             "is_error": True},
            {"recovery": '<|synalux_think|>\nThe API returned a rate limit error. I should inform the user that the request was rate-limited and offer to retry.\n</|synalux_think|>\n<|synalux_answer|>The order request was rate-limited by the exchange. This is temporary. Would you like me to retry?</|synalux_answer|>'},
            {"query": "Yes, retry", "func": "place_order",
             "args": {"order_type": "Buy", "symbol": "TSLA", "price": 245.20, "amount": 50},
             "result": '{"orderId": "ORD-54321", "status": "Pending", "amount": 50}'},
        ]
    },
    # 404 Not Found recovery
    {
        "apis": ["ticket_api"],
        "turns": [
            {"query": "Get the details of ticket T-9999", "func": "get_ticket",
             "args": {"ticket_id": 9999},
             "result": '{"error": "404 Not Found: Ticket T-9999 does not exist."}',
             "is_error": True},
            {"recovery": '<|synalux_think|>\nThe ticket was not found. I should let the user know and suggest alternatives.\n</|synalux_think|>\n<|synalux_answer|>Ticket T-9999 was not found. It may have been deleted or the ID may be incorrect. Would you like me to search for recent tickets instead?</|synalux_answer|>'},
        ]
    },
]


def generate_error_recovery_examples(output_path: Path, collections: dict, num_examples: int = 400):
    """Enhancement 2: Generate agentic error recovery training data.
    
    Teaches the model to handle API failures (404, missing params, disambiguation,
    rate limits) gracefully instead of freezing or hallucinating. This directly
    targets the 40% V4 agentic scoring weight.
    """
    examples = []
    
    for i in range(num_examples):
        scenario = random.choice(ERROR_RECOVERY_SCENARIOS)
        
        tools = []
        for api_name in scenario["apis"]:
            if api_name in collections:
                tools.extend(collections[api_name])
        if not tools:
            continue
        
        messages = [{"role": "system", "content": format_system_prompt(tools)}]
        
        for turn in scenario["turns"]:
            if "recovery" in turn:
                # Model's recovery response (no tool call, just explanation)
                messages.append({"role": "assistant", "content": turn["recovery"]})
            else:
                messages.append({"role": "user", "content": turn["query"]})
                
                # Build tool call
                tc_json = json.dumps({"name": turn["func"], "arguments": turn["args"]})
                think = f'<|synalux_think|>\nThe user wants to {turn["query"].lower()}. I should call {turn["func"]}.\n</|synalux_think|>\n'
                tc_text = f'{think}<|tool_call|>\n{tc_json}\n</|tool_call|>'
                messages.append({
                    "role": "assistant", "content": tc_text,
                    "tool_calls": [{"function": {"name": turn["func"], "arguments": turn["args"]}}],
                })
                
                # Tool response (may be error)
                messages.append({"role": "tool", "content": turn["result"]})
        
        pairs = unroll_multi_turn(messages, tools)
        for pc in pairs:
            pc["category"] = "error_recovery"
            examples.append(pc)
    
    output_file = output_path / "error_recovery_train.jsonl"
    with open(output_file, "w") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")
    
    print(f"Generated {len(examples)} error recovery examples -> {output_file}")
    return examples


# ============================================================================
# ENHANCEMENT 3: AST Data Type Hardening
# ============================================================================
# The #1 reason models fail BFCL's AST category is strict data typing.
# LLMs output strings "true" instead of booleans true, or stringified JSON
# instead of nested objects. Force explicit type reasoning in <|synalux_think|>.

AST_TYPE_EXAMPLES = [
    # Boolean parameters
    {
        "query": "Delete the file temp.log and force delete it",
        "func": "rm", "api": "gorilla_file_system",
        "args": {"file_name": "temp.log"},
        "think": "The rm function takes file_name as a string. I must output the filename as a string value.",
    },
    # Integer vs string
    {
        "query": "Get details for ticket number 42",
        "func": "get_ticket", "api": "ticket_api",
        "args": {"ticket_id": 42},
        "think": "The ticket_id parameter requires an integer, not a string. I will output 42 without quotes.",
    },
    # Float precision
    {
        "query": "Buy 5 shares of MSFT at $415.75",
        "func": "place_order", "api": "trading_bot",
        "args": {"order_type": "Buy", "symbol": "MSFT", "price": 415.75, "amount": 5},
        "think": "The price parameter is a float (415.75), amount is an integer (5), order_type is a string enum ('Buy'). I must use the correct types for each.",
    },
    # Empty string vs null
    {
        "query": "Create a new directory called 'logs'",
        "func": "mkdir", "api": "gorilla_file_system",
        "args": {"dir_name": "logs"},
        "think": "The mkdir function requires dir_name as a non-empty string. I will pass 'logs' as a string.",
    },
    # Nested object
    {
        "query": "Search for messages containing 'quarterly report'",
        "func": "search_messages", "api": "message_api",
        "args": {"keyword": "quarterly report"},
        "think": "The keyword parameter takes a string. I need to pass the full search phrase as a single string value.",
    },
    # Array of integers
    {
        "query": "Send meeting reminder to users 100, 200, and 300",
        "func": "send_message", "api": "message_api",
        "args": {"receiver_id": 100, "message": "Meeting reminder"},
        "think": "The receiver_id parameter requires an integer. I need to send separate messages to each user. Starting with user 100.",
    },
    # Enum values  
    {
        "query": "Start the engine in normal ignition mode",
        "func": "startEngine", "api": "vehicle_control",
        "args": {"ignitionMode": "START"},
        "think": "The ignitionMode parameter requires an enum value. Valid values are 'START'. I must use the exact string, not a description.",
    },
]


def generate_ast_hardening_examples(output_path: Path, collections: dict, num_examples: int = 300):
    """Enhancement 3: Generate AST data type hardening examples.
    
    Forces the model to explicitly reason about data types in <|synalux_think|>
    before generating JSON. This prevents the #1 AST failure: stringifying 
    booleans, integers, and nested objects.
    """
    examples = []
    
    for i in range(num_examples):
        example = random.choice(AST_TYPE_EXAMPLES)
        api_name = example["api"]
        
        if api_name not in collections:
            continue
        
        tools = collections[api_name]
        
        tc_json = json.dumps({"name": example["func"], "arguments": example["args"]})
        think_text = f'<|synalux_think|>\n{example["think"]}\n</|synalux_think|>\n'
        tc_text = f'{think_text}<|tool_call|>\n{tc_json}\n</|tool_call|>'
        
        msgs = [
            {"role": "system", "content": format_system_prompt(tools)},
            {"role": "user", "content": example["query"]},
            {"role": "assistant", "content": tc_text,
             "tool_calls": [{"function": {"name": example["func"], "arguments": example["args"]}}]},
        ]
        
        pairs = unroll_multi_turn(msgs, tools)
        for pc in pairs:
            pc["category"] = "ast_hardening"
            examples.append(pc)
    
    output_file = output_path / "ast_hardening_train.jsonl"
    with open(output_file, "w") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")
    
    print(f"Generated {len(examples)} AST hardening examples -> {output_file}")
    return examples


# ============================================================================
# ENHANCEMENT 4: Borderline Adversarial Training
# ============================================================================
# Remove the eval regex crutch by baking relevance detection into weights.
# Train on highly similar prompt pairs with opposite targets:
# - "How do I build a session manager?" → <|synalux_answer|> (explain)
# - "Start the session manager"        → <|tool_call|> (call tool)

BORDERLINE_PAIRS = [
    # Session management
    {
        "tool_query": "Load the context for my analytics project",
        "tool_func": "session_load_context",
        "tool_args": {"project": "analytics"},
        "general_query": "How do session managers work in web applications?",
        "general_answer": "Session managers handle user state across HTTP requests using cookies, tokens, or server-side storage. They track login state, preferences, and shopping carts.",
    },
    # Memory/search
    {
        "tool_query": "Search my memories for the database migration we did last week",
        "tool_func": "session_search_memory",
        "tool_args": {"query": "database migration last week"},
        "general_query": "What's the difference between RAM and persistent storage?",
        "general_answer": "RAM is volatile memory for active data (fast, cleared on power off). Persistent storage (SSD/HDD) retains data permanently but is slower.",
    },
    # File operations
    {
        "tool_query": "List all files in the current directory",
        "tool_func": "ls",
        "tool_args": {},
        "general_query": "Explain how file systems organize data on disk",
        "general_answer": "File systems use hierarchical structures with directories (folders) containing files. They manage metadata (permissions, timestamps) and map logical paths to physical disk sectors.",
    },
    # Knowledge/save
    {
        "tool_query": "Save a ledger entry for the auth-service project",
        "tool_func": "session_save_ledger",
        "tool_args": {"project": "auth-service", "conversation_id": "conv-001", "summary": "Fixed OAuth flow"},
        "general_query": "What are best practices for logging in production systems?",
        "general_answer": "Use structured logging (JSON format), implement log levels (DEBUG/INFO/WARN/ERROR), centralize with ELK/Datadog, avoid logging sensitive data, and set up alerts on error patterns.",
    },
    # Trading
    {
        "tool_query": "What's the current price of Tesla stock?",
        "tool_func": "get_stock_info",
        "tool_args": {"symbol": "TSLA"},
        "general_query": "Explain how the stock market works",
        "general_answer": "The stock market is a marketplace where shares of publicly traded companies are bought and sold. Prices are determined by supply and demand, influenced by company performance, economic conditions, and investor sentiment.",
    },
    # Tickets
    {
        "tool_query": "Create a bug report ticket for the login page crash",
        "tool_func": "create_ticket",
        "tool_args": {"title": "Login Page Crash", "description": "Page crashes on submit", "priority": 1},
        "general_query": "What is the ITIL framework for incident management?",
        "general_answer": "ITIL defines a structured approach to incident management: detection → logging → categorization → prioritization → investigation → resolution → closure. It emphasizes SLAs and continuous improvement.",
    },
]


def generate_borderline_adversarial(output_path: Path, collections: dict, num_examples: int = 500):
    """Enhancement 4: Generate borderline adversarial training data.
    
    Trains the model to distinguish between:
    - Actionable requests that require tool calls
    - General knowledge questions that should be answered directly
    
    This replaces the regex crutch in bfcl_eval.py by baking detection into weights.
    """
    examples = []
    
    for i in range(num_examples):
        pair = random.choice(BORDERLINE_PAIRS)
        
        # 50% tool call examples, 50% general answer examples
        if random.random() < 0.5:
            # TOOL CALL: actionable request
            api_name = None
            for name, funcs in collections.items():
                if any(f.get("name") == pair["tool_func"] for f in funcs):
                    api_name = name
                    break
            
            if not api_name:
                # Use any tools for context
                tools = list(collections.values())[0] if collections else []
            else:
                tools = collections[api_name]
            
            tc_json = json.dumps({"name": pair["tool_func"], "arguments": pair["tool_args"]})
            think = f'<|synalux_think|>\nThe user wants to perform an action. This requires calling the {pair["tool_func"]} function.\n</|synalux_think|>\n'
            tc_text = f'{think}<|tool_call|>\n{tc_json}\n</|tool_call|>'
            
            msgs = [
                {"role": "system", "content": format_system_prompt(tools)},
                {"role": "user", "content": pair["tool_query"]},
                {"role": "assistant", "content": tc_text},
            ]
        else:
            # GENERAL ANSWER: knowledge question (no tool call!)
            # Use random tools for context — model must learn to NOT call them
            api_keys = list(collections.keys())
            tools = collections[random.choice(api_keys)] if api_keys else []
            
            think = '<|synalux_think|>\nThis is a general knowledge question. None of the available tools are relevant. I should answer directly.\n</|synalux_think|>\n'
            answer = f'{think}<|synalux_answer|>{pair["general_answer"]}</|synalux_answer|>'
            
            msgs = [
                {"role": "system", "content": format_system_prompt(tools)},
                {"role": "user", "content": pair["general_query"]},
                {"role": "assistant", "content": answer},
            ]
        
        pairs_out = unroll_multi_turn(msgs, tools)
        for pc in pairs_out:
            pc["category"] = "borderline_adversarial"
            examples.append(pc)
    
    output_file = output_path / "borderline_adversarial_train.jsonl"
    with open(output_file, "w") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")
    
    print(f"Generated {len(examples)} borderline adversarial examples -> {output_file}")
    return examples


def generate_v4_agentic_examples(output_path: Path, num_examples: int = 600):
    """Generate training examples for BFCL V4 heavily-weighted agentic categories.
    
    R3-5: The pipeline was missing examples for web_search, memory_kv, and 
    memory_vector — the hardest V4 categories that carry 40% of the score.
    """
    from config import V4_API_SCHEMAS, TOKEN_THINK_OPEN, TOKEN_THINK_CLOSE
    from config import TOKEN_TOOL_CALL_OPEN, TOKEN_TOOL_CALL_CLOSE
    
    examples = []
    
    # Web search scenarios (multi-step browsing)
    web_scenarios = [
        {"query": "Search for the latest Python 3.13 features and summarize them.",
         "tool": "web_search", "args": {"query": "Python 3.13 new features", "num_results": 5},
         "think": "The user wants to search the web. I'll use web_search with a targeted query."},
        {"query": "Find the pricing page of Stripe and extract the pricing tiers.",
         "tool": "web_scrape", "args": {"url": "https://stripe.com/pricing", "format": "text"},
         "think": "The user wants to scrape content from a specific URL. I'll use web_scrape."},
        {"query": "Search for React 19 release date and then scrape the official blog post.",
         "steps": [
             {"tool": "web_search", "args": {"query": "React 19 release date official"}},
             {"tool": "web_scrape", "args": {"url": "https://react.dev/blog", "format": "markdown"}},
         ],
         "think": "This requires two steps: first search, then scrape the relevant result."},
        {"query": "Find the top 3 news articles about AI regulation.",
         "tool": "web_search", "args": {"query": "AI regulation news 2024", "num_results": 3, "search_type": "news"},
         "think": "The user wants news articles. I should use search_type 'news' to get relevant results."},
        {"query": "Go to the GitHub trending page and click on the first repository.",
         "tool": "web_click", "args": {"element_id": "a.Link--primary", "wait_after": 2000},
         "think": "The user wants to interact with a web page element. I'll use web_click."},
    ]
    
    # Memory KV scenarios (state management)
    kv_scenarios = [
        {"query": "Remember that my API key is sk-proj-abc123.",
         "tool": "memory_set", "args": {"key": "api_key", "value": "sk-proj-abc123"},
         "think": "The user wants to store a value. I'll use memory_set to persist it."},
        {"query": "What was my API key?",
         "tool": "memory_get", "args": {"key": "api_key"},
         "think": "The user wants to recall a stored value. I'll use memory_get."},
        {"query": "Store the deployment URL as https://api.example.com in the prod namespace.",
         "tool": "memory_set", "args": {"key": "deployment_url", "value": "https://api.example.com", "namespace": "prod"},
         "think": "The user wants to store with a specific namespace. I'll use memory_set with namespace."},
        {"query": "List all keys that start with 'user_' in the default namespace.",
         "tool": "memory_list", "args": {"prefix": "user_", "namespace": "default"},
         "think": "The user wants to list keys by prefix. I'll use memory_list with the prefix filter."},
        {"query": "Delete the cached_token from memory.",
         "tool": "memory_delete", "args": {"key": "cached_token"},
         "think": "The user wants to delete a key. I'll use memory_delete."},
    ]
    
    # Vector memory scenarios (semantic retrieval)
    vector_scenarios = [
        {"query": "Store this code review feedback for later: 'The auth module needs rate limiting'.",
         "tool": "vector_store", "args": {"text": "The auth module needs rate limiting", "metadata": {"type": "code_review"}},
         "think": "The user wants to store text with semantic embedding. I'll use vector_store."},
        {"query": "Search my notes for anything about authentication.",
         "tool": "vector_search", "args": {"query": "authentication", "top_k": 5},
         "think": "The user wants semantic search over stored content. I'll use vector_search."},
        {"query": "Find similar documents to 'database optimization techniques'.",
         "tool": "vector_search", "args": {"query": "database optimization techniques", "threshold": 0.8},
         "think": "The user wants high-similarity matches. I'll set a higher threshold for precision."},
        {"query": "Remove all vector entries tagged as 'draft' from the docs collection.",
         "tool": "vector_delete", "args": {"filter": {"type": "draft"}, "collection": "docs"},
         "think": "The user wants to delete by metadata filter. I'll use vector_delete with the filter."},
        {"query": "Store this meeting summary in the meetings collection: 'Q4 planning: focus on mobile app launch'.",
         "tool": "vector_store", "args": {"text": "Q4 planning: focus on mobile app launch", "collection": "meetings"},
         "think": "The user wants to store in a specific collection. I'll use vector_store with collection."},
    ]
    
    all_scenarios = web_scenarios + kv_scenarios + vector_scenarios
    category_map = {
        "web_search": "v4_web", "web_scrape": "v4_web", "web_click": "v4_web",
        "memory_set": "v4_kv", "memory_get": "v4_kv", "memory_delete": "v4_kv", "memory_list": "v4_kv",
        "vector_store": "v4_vector", "vector_search": "v4_vector", "vector_delete": "v4_vector",
    }
    
    for i in range(num_examples):
        scenario = random.choice(all_scenarios)
        think = f"{TOKEN_THINK_OPEN}\n{scenario['think']}\n{TOKEN_THINK_CLOSE}\n"
        
        if "steps" in scenario:
            # Multi-step: generate parallel tool calls
            tool_blocks = []
            for step in scenario["steps"]:
                tc = json.dumps({"name": step["tool"], "arguments": step["args"]})
                tool_blocks.append(f"{TOKEN_TOOL_CALL_OPEN}\n{tc}\n{TOKEN_TOOL_CALL_CLOSE}")
            completion = f"{think}\n".join([""] + tool_blocks).strip()
            cat = category_map.get(scenario["steps"][0]["tool"], "v4_agentic")
        else:
            tc = json.dumps({"name": scenario["tool"], "arguments": scenario["args"]})
            completion = f"{think}{TOKEN_TOOL_CALL_OPEN}\n{tc}\n{TOKEN_TOOL_CALL_CLOSE}"
            cat = category_map.get(scenario["tool"], "v4_agentic")
        
        # Determine tools for system prompt
        api_key = "web_search" if "web" in scenario.get("tool", "") else (
            "memory_kv" if "memory" in scenario.get("tool", "") else "memory_vector"
        )
        tools = V4_API_SCHEMAS.get(api_key, [])
        
        msgs = [
            {"role": "system", "content": format_system_prompt(tools)},
            {"role": "user", "content": scenario["query"]},
            {"role": "assistant", "content": completion},
        ]
        examples.append({"messages": msgs, "category": cat})
    
    output_file = output_path / "v4_agentic_train.jsonl"
    with open(output_file, "w") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")
    
    print(f"Generated {len(examples)} V4 agentic examples -> {output_file}")
    return examples


# ============================================================================
# R5-1: Schema-Mapping Chain-of-Thought (SM-CoT) Training Data
# ============================================================================
def generate_smcot_examples(output_path: Path, collections: dict, num_examples: int = 300):
    """R5-1: Generate SM-CoT training data with structured schema-mapping think blocks.
    
    Replaces conversational think patterns with explicit schema validation.
    Each example forces the model to check REQUIRED/OPTIONAL for every param.
    """
    examples = []
    
    # SM-CoT scenario templates (tool_name, user_query, param_values, intent)
    smcot_scenarios = [
        # Gorilla FileSystem
        {"api": "gorilla_file_system", "func": "mkdir",
         "query": "Create a directory called projects",
         "args": {"dir_name": "projects"},
         "intent": "Create a new directory"},
        {"api": "gorilla_file_system", "func": "ls",
         "query": "Show me all files in the current directory",
         "args": {},
         "intent": "List directory contents"},
        {"api": "gorilla_file_system", "func": "grep",
         "query": "Search for 'TODO' in main.py",
         "args": {"file_name": "main.py", "pattern": "TODO"},
         "intent": "Search for pattern in file"},
        {"api": "gorilla_file_system", "func": "mv",
         "query": "Move report.csv to the archive folder",
         "args": {"source": "report.csv", "destination": "archive/report.csv"},
         "intent": "Move a file to another location"},
        {"api": "gorilla_file_system", "func": "cat",
         "query": "Show me the contents of readme.md",
         "args": {"file_name": "readme.md"},
         "intent": "Read file contents"},
        # Vehicle Control
        {"api": "vehicle_control", "func": "startEngine",
         "query": "Start my car",
         "args": {"ignitionMode": "START"},
         "intent": "Start the vehicle engine"},
        {"api": "vehicle_control", "func": "gallon_to_liter",
         "query": "Convert 10 gallons to liters",
         "args": {"gallon": 10.0},
         "intent": "Convert fuel measurement units"},
        # Trading Bot
        {"api": "trading_bot", "func": "place_order",
         "query": "Buy 100 shares of AAPL at $185.50",
         "args": {"order_type": "Buy", "symbol": "AAPL", "price": 185.50, "amount": 100},
         "intent": "Place a stock purchase order"},
        {"api": "trading_bot", "func": "get_stock_info",
         "query": "What's the current price of TSLA?",
         "args": {"symbol": "TSLA"},
         "intent": "Get current stock information"},
        # Message API
        {"api": "message_api", "func": "send_message",
         "query": "Send a message to user 42 saying 'meeting at 3pm'",
         "args": {"receiver_id": 42, "message": "meeting at 3pm"},
         "intent": "Send a direct message to a user"},
    ]
    
    for i in range(num_examples):
        scenario = random.choice(smcot_scenarios)
        api_name = scenario["api"]
        
        if api_name not in collections:
            continue
        
        tools = collections[api_name]
        
        # Find the actual tool schema
        tool_schema = None
        for t in tools:
            if t.get("name") == scenario["func"]:
                tool_schema = t
                break
        
        if not tool_schema:
            # Fallback: use first tool if exact match not found
            tool_schema = {"name": scenario["func"], "parameters": {"properties": {}, "required": []}}
        
        # Build structured SM-CoT think block
        smcot_text = build_smcot_think(tool_schema, scenario["intent"], scenario["args"])
        tc_json = json.dumps({"name": scenario["func"], "arguments": scenario["args"]})
        
        think_text = f'{TOKEN_THINK_OPEN}\n{smcot_text}\n{TOKEN_THINK_CLOSE}\n'
        tc_text = f'{think_text}{TOKEN_TOOL_CALL_OPEN}\n{tc_json}\n{TOKEN_TOOL_CALL_CLOSE}'
        
        msgs = [
            {"role": "system", "content": format_system_prompt(tools)},
            {"role": "user", "content": scenario["query"]},
            {"role": "assistant", "content": tc_text},
        ]
        
        pairs = unroll_multi_turn(msgs, tools)
        for pc in pairs:
            pc["category"] = "smcot"
            examples.append(pc)
    
    output_file = output_path / "smcot_train.jsonl"
    with open(output_file, "w") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")
    
    print(f"Generated {len(examples)} SM-CoT examples -> {output_file}")
    return examples


# ============================================================================
# R5-2: Optional Parameter Restraint Training
# ============================================================================
def generate_optional_restraint_examples(output_path: Path, collections: dict, num_examples: int = 500):
    """R5-2: Train the model to strictly OMIT optional params not mentioned by user.
    
    BFCL V4 scores guessed defaults as hallucination (10% weight).
    For tools with 3+ optional params, we train with SM-CoT that explicitly
    marks each unmentioned optional as 'Not specified -> OMIT'.
    """
    examples = []
    
    # Find tools with 3+ optional params across all collections
    rich_tools = []
    for api_name, tools in collections.items():
        for tool in tools:
            params = tool.get('parameters', {})
            props = params.get('properties', {})
            required = set(params.get('required', []))
            optional_count = sum(1 for p in props if p not in required)
            if optional_count >= 3:
                rich_tools.append((api_name, tool))
    
    if not rich_tools:
        print("WARNING: No tools with 3+ optional params found. Skipping R5-2.")
        return []
    
    # Queries that sound expansive but should still only use required params
    expansive_queries = [
        "Get me everything about {topic}",
        "Run a full {action} on {target}",
        "Do a complete {action}",
        "Give me all the details on {topic}",
        "Show me the full {topic} report",
        "Execute {action} with all options",
    ]
    topics = ["the account", "this project", "the database", "user profiles", "the system"]
    actions = ["scan", "analysis", "check", "search", "query"]
    targets = ["the database", "all records", "the cluster", "this workspace"]
    
    for i in range(num_examples):
        api_name, tool = random.choice(rich_tools)
        all_tools = collections[api_name]
        
        params = tool.get('parameters', {})
        props = params.get('properties', {})
        required = set(params.get('required', []))
        
        # Build param_values with ONLY required params (random but type-correct values)
        param_values = {}
        for req_p in required:
            pdata = props.get(req_p, {})
            ptype = pdata.get('type', 'string')
            if ptype == 'integer':
                param_values[req_p] = random.randint(1, 100)
            elif ptype == 'number':
                param_values[req_p] = round(random.uniform(1.0, 100.0), 2)
            elif ptype == 'boolean':
                param_values[req_p] = random.choice([True, False])
            elif 'enum' in pdata:
                param_values[req_p] = random.choice(pdata['enum'])
            else:
                param_values[req_p] = random.choice(["test-value", "my-project", "data.csv", "report"])
        
        # Build an expansive-sounding query
        query_t = random.choice(expansive_queries)
        query = query_t.format(
            topic=random.choice(topics),
            action=random.choice(actions),
            target=random.choice(targets),
        )
        # Add required param values to query naturally
        for k, v in param_values.items():
            query += f" with {k}={v}"
        
        intent = f"Use {tool['name']} with only explicitly provided parameters"
        smcot_text = build_smcot_think(tool, intent, param_values)
        tc_json = json.dumps({"name": tool['name'], "arguments": param_values})
        
        think_text = f'{TOKEN_THINK_OPEN}\n{smcot_text}\n{TOKEN_THINK_CLOSE}\n'
        tc_text = f'{think_text}{TOKEN_TOOL_CALL_OPEN}\n{tc_json}\n{TOKEN_TOOL_CALL_CLOSE}'
        
        msgs = [
            {"role": "system", "content": format_system_prompt(all_tools)},
            {"role": "user", "content": query},
            {"role": "assistant", "content": tc_text},
        ]
        
        pairs = unroll_multi_turn(msgs, all_tools)
        for pc in pairs:
            pc["category"] = "optional_restraint"
            examples.append(pc)
    
    output_file = output_path / "optional_restraint_train.jsonl"
    with open(output_file, "w") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")
    
    print(f"Generated {len(examples)} optional restraint examples -> {output_file}")
    return examples


# ============================================================================
# R5-6: Dry-Run Safety Training
# ============================================================================
DRY_RUN_SCENARIOS = [
    {"query": "Delete all old memory entries for the test project",
     "tool": "knowledge_forget", "args": {"project": "test", "dry_run": True},
     "intent": "Delete old memory entries"},
    {"query": "Forget everything in the deprecated-api project",
     "tool": "knowledge_forget", "args": {"project": "deprecated-api", "confirm_all": True, "dry_run": True},
     "intent": "Wipe all entries for a project"},
    {"query": "Remove the memory entry abc-123 permanently",
     "tool": "session_forget_memory", "args": {"memory_id": "abc-123", "hard_delete": True, "dry_run": True},
     "intent": "Permanently remove a specific memory entry"},
    {"query": "Clean up the data-pipeline ledger, it has too many entries",
     "tool": "session_compact_ledger", "args": {"project": "data-pipeline", "dry_run": True},
     "intent": "Compact the session ledger"},
    {"query": "Nuke all the logs from last month",
     "tool": "knowledge_forget", "args": {"project": "logs", "older_than_days": 30, "dry_run": True},
     "intent": "Delete logs older than 30 days"},
    {"query": "Delete the user-data key from memory",
     "tool": "memory_delete", "args": {"key": "user-data", "namespace": "default", "dry_run": True},
     "intent": "Delete a key-value memory entry"},
    {"query": "Remove all vectors about deprecated features",
     "tool": "vector_delete", "args": {"filter": {"topic": "deprecated"}, "collection": "default", "dry_run": True},
     "intent": "Delete vector embeddings by filter"},
]


def generate_dry_run_examples(output_path: Path, num_examples: int = 200):
    """R5-6: Generate dry-run safety training data.
    
    Teaches the model to auto-inject dry_run=true for destructive operations.
    Uses SM-CoT with explicit destructive action detection.
    """
    from config import V4_API_SCHEMAS
    
    examples = []
    
    # Build a minimal tool registry for destructive tools
    destructive_schemas = []
    for api_name, api_tools in V4_API_SCHEMAS.items():
        for tool in api_tools:
            if tool['name'] in DESTRUCTIVE_TOOLS:
                destructive_schemas.append(tool)
    
    # Add Prism MCP schemas for destructive tools
    prism_destructive = [
        {"name": "knowledge_forget", "description": "Forget accumulated knowledge entries.",
         "parameters": {"type": "object", "properties": {
             "project": {"type": "string", "description": "Project identifier"},
             "category": {"type": "string", "description": "Category filter"},
             "older_than_days": {"type": "integer", "description": "Age filter in days"},
             "confirm_all": {"type": "boolean", "description": "Confirm wipe all"},
             "dry_run": {"type": "boolean", "description": "Preview without deleting"},
         }, "required": []}},
        {"name": "session_forget_memory", "description": "Forget a specific memory entry by ID.",
         "parameters": {"type": "object", "properties": {
             "memory_id": {"type": "string", "description": "UUID of the memory entry"},
             "hard_delete": {"type": "boolean", "description": "Permanently remove"},
             "reason": {"type": "string", "description": "Justification for deletion"},
             "dry_run": {"type": "boolean", "description": "Preview what would be deleted without executing"},
         }, "required": ["memory_id"]}},
        {"name": "session_compact_ledger", "description": "Compact old session ledger entries.",
         "parameters": {"type": "object", "properties": {
             "project": {"type": "string", "description": "Project to compact"},
             "threshold": {"type": "integer", "description": "Min entries before compaction"},
             "keep_recent": {"type": "integer", "description": "Recent entries to keep"},
             "dry_run": {"type": "boolean", "description": "Preview without executing"},
         }, "required": []}},
    ]
    all_destructive = destructive_schemas + prism_destructive
    
    for i in range(num_examples):
        scenario = random.choice(DRY_RUN_SCENARIOS)
        
        # Find matching tool schema
        tool_schema = None
        for t in all_destructive:
            if t['name'] == scenario['tool']:
                tool_schema = t
                break
        
        if not tool_schema:
            continue
        
        smcot_text = build_dryrun_smcot_think(tool_schema, scenario['intent'], scenario['args'])
        tc_json = json.dumps({"name": scenario['tool'], "arguments": scenario['args']})
        
        think_text = f'{TOKEN_THINK_OPEN}\n{smcot_text}\n{TOKEN_THINK_CLOSE}\n'
        tc_text = f'{think_text}{TOKEN_TOOL_CALL_OPEN}\n{tc_json}\n{TOKEN_TOOL_CALL_CLOSE}'
        
        msgs = [
            {"role": "system", "content": format_system_prompt(all_destructive)},
            {"role": "user", "content": scenario['query']},
            {"role": "assistant", "content": tc_text},
        ]
        
        pairs = unroll_multi_turn(msgs, all_destructive)
        for pc in pairs:
            pc["category"] = "dry_run_safety"
            examples.append(pc)
    
    output_file = output_path / "dry_run_safety_train.jsonl"
    with open(output_file, "w") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")
    
    print(f"Generated {len(examples)} dry-run safety examples -> {output_file}")
    return examples

def merge_datasets(output_path: Path):
    """Merge all training data into a single shuffled file."""
    all_examples = []
    
    for jsonl_file in output_path.glob("*_train.jsonl"):
        with open(jsonl_file) as f:
            for line in f:
                all_examples.append(json.loads(line))
    
    random.shuffle(all_examples)
    
    # Split 90/10 train/valid
    split_idx = int(len(all_examples) * 0.9)
    train = all_examples[:split_idx]
    valid = all_examples[split_idx:]
    
    train_file = output_path / "train.jsonl"
    valid_file = output_path / "valid.jsonl"
    
    with open(train_file, "w") as f:
        for ex in train:
            f.write(json.dumps(ex) + "\n")
    
    with open(valid_file, "w") as f:
        for ex in valid:
            f.write(json.dumps(ex) + "\n")
    
    print(f"\nMerged dataset: {len(train)} train, {len(valid)} valid")
    print(f"Category distribution:")
    cats = {}
    for ex in all_examples:
        cat = ex.get("category", "unknown")
        cats[cat] = cats.get(cat, 0) + 1
    for cat, count in sorted(cats.items()):
        print(f"  {cat}: {count}")


def main():
    parser = argparse.ArgumentParser(description="Generate BFCL training data (v5 — R5 optimizations)")
    parser.add_argument("--output-dir", type=str, default="./data/bfcl", help="Output directory")
    parser.add_argument("--bfcl-dir", type=str, default=str(DEFAULT_BFCL_DIR), help="BFCL repo directory")
    parser.add_argument("--irrelevance-count", type=int, default=800, help="Irrelevance examples")
    parser.add_argument("--multiturn-count", type=int, default=1200, help="Multi-turn examples")
    parser.add_argument("--miss-func-count", type=int, default=500, help="Miss-func examples")
    parser.add_argument("--grpo-count", type=int, default=600, help="GRPO preference pairs")
    parser.add_argument("--error-recovery-count", type=int, default=400, help="Enhancement 2: Agentic error recovery")
    parser.add_argument("--ast-hardening-count", type=int, default=300, help="Enhancement 3: AST type hardening")
    parser.add_argument("--borderline-count", type=int, default=500, help="Enhancement 4: Borderline adversarial")
    parser.add_argument("--v4-agentic-count", type=int, default=600, help="V4 agentic categories (web/memory/vector)")
    parser.add_argument("--smcot-count", type=int, default=300, help="R5-1: SM-CoT schema-mapping examples")
    parser.add_argument("--optional-restraint-count", type=int, default=500, help="R5-2: Optional param restraint")
    parser.add_argument("--dry-run-count", type=int, default=200, help="R5-6: Dry-run safety examples")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    args = parser.parse_args()
    
    random.seed(args.seed)
    output_path = Path(args.output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    bfcl_dir = Path(args.bfcl_dir)
    
    print("=" * 60)
    print("BFCL Training Data Generator v5 (R5 Optimizations)")
    print("=" * 60)
    
    # Load real BFCL function definitions
    print("\nLoading BFCL function definitions...")
    collections = load_bfcl_func_docs(bfcl_dir)
    
    if not collections:
        print("ERROR: No BFCL function docs found. Check --bfcl-dir path.")
        sys.exit(1)
    
    print(f"\n--- Generating Training Data ---")
    # Core categories
    generate_irrelevance_negatives(output_path, collections, args.irrelevance_count)
    generate_multiturn_examples(output_path, collections, args.multiturn_count)
    generate_miss_func_examples(output_path, collections, args.miss_func_count)
    generate_grpo_pairs(output_path, collections, args.grpo_count)
    # V4 enhancements
    print(f"\n--- V4 Enhancement Data ---")
    generate_error_recovery_examples(output_path, collections, args.error_recovery_count)
    generate_ast_hardening_examples(output_path, collections, args.ast_hardening_count)
    generate_borderline_adversarial(output_path, collections, args.borderline_count)
    # V4 agentic categories (R3-5: web_search, memory_kv, memory_vector)
    print(f"\n--- V4 Agentic Categories ---")
    generate_v4_agentic_examples(output_path, args.v4_agentic_count)
    # R5 optimizations
    print(f"\n--- R5 Advanced Optimizations ---")
    generate_smcot_examples(output_path, collections, args.smcot_count)
    generate_optional_restraint_examples(output_path, collections, args.optional_restraint_count)
    generate_dry_run_examples(output_path, args.dry_run_count)
    merge_datasets(output_path)
    
    print(f"\n✅ Training data generation complete!")
    print(f"Files written to: {output_path}")


if __name__ == "__main__":
    main()
