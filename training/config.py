#!/usr/bin/env python3
"""
Prism Training Pipeline — Configuration Interface

This module provides the ONLY configuration surface for model identity,
token schemas, and output paths. All training scripts import from here
instead of hardcoding implementation-specific values.

Architecture rule:
    - Prism's repo exposes INTERFACES ONLY (token names, paths, prompts)
    - Implementation details (model weights, private APIs) live externally
    - This file is the single source of truth for the training pipeline
"""

import json
import os
from pathlib import Path

# =============================================================================
# Model Identity (interface — no implementation details)
# =============================================================================
MODEL_NAME = os.environ.get("PRISM_MODEL_NAME", "prism-coder")
MODEL_VERSION = os.environ.get("PRISM_MODEL_VERSION", "32b-FC")
MODEL_DISPLAY = f"{MODEL_NAME}:{MODEL_VERSION}"

# =============================================================================
# Token Schema (interface contract — shared across all pipeline scripts)
# =============================================================================
TOKEN_THINK_OPEN = "<|synalux_think|>"
TOKEN_THINK_CLOSE = "</|synalux_think|>"
TOKEN_TOOL_CALL_OPEN = "<|tool_call|>"
TOKEN_TOOL_CALL_CLOSE = "</|tool_call|>"
TOKEN_TOOL_RESPONSE_OPEN = "<|tool_response|>"
TOKEN_TOOL_RESPONSE_CLOSE = "</|tool_response|>"
TOKEN_ANSWER_OPEN = "<|synalux_answer|>"
TOKEN_ANSWER_CLOSE = "</|synalux_answer|>"

# Stop tokens for inference (Ollama / vLLM)
STOP_TOKENS = [
    "<|im_end|>",
    TOKEN_TOOL_CALL_CLOSE,
    TOKEN_THINK_CLOSE,
]

# =============================================================================
# System Prompt (interface — describes capabilities, not implementation)
# =============================================================================
SYSTEM_PROMPT_TEMPLATE = (
    "You are a reasoning model for memory-augmented coding and clinical workflows. "
    "You have access to Prism Memory tools and 13 multimodal tool modules "
    "(image gen, office, web scraping, browser, TTS, OCR, git, terminal, "
    "deps scanner, HIPAA compliance, data graphing, clinical templates, PDF parser). "
    "Think step-by-step before answering. "
    f"Use {TOKEN_THINK_OPEN} for reasoning and {TOKEN_TOOL_CALL_OPEN} for tool invocations.\n\n"
    "Rules:\n"
    f"1. If NONE of the provided functions are relevant, respond with a plain text message inside {TOKEN_ANSWER_OPEN} tags.\n"
    "2. NEVER invent function names. Only use functions from the provided tool list.\n"
    f"3. Always include {TOKEN_THINK_OPEN} reasoning before any {TOKEN_TOOL_CALL_OPEN}.\n\n"
    f"Format tool calls as:\n{TOKEN_TOOL_CALL_OPEN}\n"
    '{"name": "tool_name", "arguments": {"param": "value"}}\n'
    f"{TOKEN_TOOL_CALL_CLOSE}"
)

# =============================================================================
# Paths (configurable via env vars, defaults to Prism-local)
# =============================================================================

# Training data output (defaults to Prism-local; override for external pipelines)
TRAINING_DATA_DIR = os.environ.get(
    "PRISM_TRAINING_DATA_DIR",
    str(Path(__file__).parent / "data" / "bfcl")
)

# SFT/GRPO auxiliary data output
AUX_DATA_DIR = os.environ.get(
    "PRISM_AUX_DATA_DIR",
    str(Path(__file__).parent / "data" / "aux")
)

# Model output directory
MODEL_OUTPUT_DIR = os.environ.get(
    "PRISM_MODEL_OUTPUT_DIR",
    str(Path(__file__).parent / "output")
)

# BFCL repo path (for loading function definitions)
BFCL_REPO_DIR = os.environ.get(
    "PRISM_BFCL_DIR",
    str(Path.home() / "gorilla-bfcl" / "berkeley-function-call-leaderboard")
)

# Fused model path (for Ollama deployment)
FUSED_MODEL_PATH = os.environ.get(
    "PRISM_FUSED_MODEL_PATH",
    str(Path(__file__).parent / "models" / "prism-fused")
)

# =============================================================================
# Training Hyperparameters (interface — hardware-aware defaults)
# =============================================================================
DEFAULT_BATCH_SIZE = 1          # OOM-safe on 48GB M5 Max
DEFAULT_GRAD_ACCUM = 16         # Effective batch = 1 × 16 = 16
DEFAULT_LORA_RANK = 64          # Must match across SFT + GRPO for model souping
DEFAULT_LORA_LAYERS = 24        # 32B fits in 48GB with this
DEFAULT_MAX_SEQ_LENGTH = 16384  # SFT; GRPO uses 8192
DEFAULT_LEARNING_RATE = 1e-5    # SFT default
DEFAULT_GRPO_LR = 5e-6          # Lower for alignment stability
DEFAULT_NEFTUNE_ALPHA = 5.0     # R5-7: NEFTune noise for generalization

# =============================================================================
# Inference / Ollama Configuration (R5-5: KV Cache + Prefix Caching)
# =============================================================================
OLLAMA_KEEP_ALIVE = "30m"       # Keep model loaded for prefix cache reuse
OLLAMA_NUM_CTX = 16384          # Context window for inference
OLLAMA_TEMPERATURE = 0.1        # Deterministic for eval, 0.7 for production

# =============================================================================
# R6-1: Best-of-N Test-Time Compute Scaling
# =============================================================================
BEST_OF_N_DEFAULT = 5           # Number of candidates for schema validation
BEST_OF_N_TEMPERATURE = 0.6    # Higher temp for candidate diversity

# =============================================================================
# R6-6: Streaming CoT Configuration (Perceived Latency Reduction)
# =============================================================================
# When streaming is enabled, <|synalux_think|> tokens should be rendered
# in the UI as a collapsible "Thought Process" or "Agent Terminal" panel.
# This reduces perceived latency to zero — users see the AI reasoning
# in real-time while the JSON tool call payload is being generated.
STREAM_THINK_TO_UI = True       # Enable streaming of think tokens to frontend
THINK_UI_LABEL = "🧠 Reasoning"  # UI label for the think block panel
THINK_UI_COLLAPSED = False      # Whether think panel starts collapsed

# =============================================================================
# Destructive Tool Registry (R5-6: Dry-Run Safety Training)
# =============================================================================
DESTRUCTIVE_TOOLS = {
    "session_forget_memory",
    "knowledge_forget",
    "session_compact_ledger",
    "memory_delete",
    "vector_delete",
}

# =============================================================================
# Project names for training examples (generic, no private repo names)
# =============================================================================
EXAMPLE_PROJECTS = [
    "analytics-dashboard",
    "backend-api",
    "mobile-app",
    "data-pipeline",
    "auth-service",
    "payment-gateway",
    "ml-inference",
    "docs-portal",
    "monitoring-stack",
    "infra-terraform",
]

# =============================================================================
# State Block Injection (R3-3: bridges training ↔ inference)
# =============================================================================
# This template is injected into the system prompt at both training-time
# (generate_diverse_sft.py Exp 3) and inference-time (PrismCoderHandler).
STATE_BLOCK_TEMPLATE = (
    "[CURRENT STATE]\n"
    "Active Project: {project}\n"
    "Active Branch: {branch}\n"
    "Open TODOs: {todos}\n"
    "Last Session: {last_summary}\n"
    "[/CURRENT STATE]"
)


def format_system_prompt(tools=None, state_context=None, bfcl_eval_mode=False):
    """Build the full system prompt with optional tool list and state block.
    
    SINGLE SOURCE OF TRUTH: All training scripts and inference handlers
    must call this function. Do NOT re-implement system prompt formatting.
    
    Args:
        tools: Optional list of tool definitions (JSON schema dicts) to include
        state_context: Optional dict with keys: project, branch, todos, last_summary
        bfcl_eval_mode: If True, disables clarification behavior (R4-5). 
                        Set True during `bfcl evaluate` to avoid False Negatives.
    
    Returns:
        Complete system prompt string
    """
    prompt = SYSTEM_PROMPT_TEMPLATE
    
    # Inject state block if provided (R3-3: ensures training and inference match)
    if state_context:
        state_block = STATE_BLOCK_TEMPLATE.format(
            project=state_context.get("project", "unknown"),
            branch=state_context.get("branch", "main"),
            todos=state_context.get("todos", "none"),
            last_summary=state_context.get("last_summary", "N/A"),
        )
        prompt = f"{prompt}\n\n{state_block}"
    
    # Append StructXML tool definitions if provided (R4-3: single source of truth)
    if tools:
        prompt += "\n\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\n"
        prompt += "You are provided with function signatures within <tools></tools> XML tags:\n<tools>"
        for tool in tools:
            prompt += f"\n<function>\n  <name>{tool.get('name', '')}</name>\n  <description>{tool.get('description', '')}</description>\n"
            params = tool.get('parameters', {})
            props = params.get('properties', {})
            required = params.get('required', [])
            if props:
                prompt += "  <parameters>\n"
                for prop_name, prop_data in props.items():
                    req = "required" if prop_name in required else "optional"
                    ptype = prop_data.get('type', 'string')
                    pdesc = prop_data.get('description', '')
                    prompt += f'    <parameter name="{prop_name}" type="{ptype}" presence="{req}">\n'
                    if 'enum' in prop_data:
                        prompt += f"      <enum>{', '.join(str(e) for e in prop_data['enum'])}</enum>\n"
                    prompt += f"      <description>{pdesc}</description>\n"
                    prompt += "    </parameter>\n"
                prompt += "  </parameters>\n"
            prompt += "</function>"
        prompt += "\n</tools>\n\n"
        prompt += f'For each function call, first reason inside {TOKEN_THINK_OPEN} tags, then return a json object within {TOKEN_TOOL_CALL_OPEN} tags:\n'
        prompt += f'{TOKEN_THINK_OPEN}\nYour reasoning about which tool to call and why...\n{TOKEN_THINK_CLOSE}\n'
        prompt += f'{TOKEN_TOOL_CALL_OPEN}\n{{"name": <function-name>, "arguments": <args-json-object>}}\n{TOKEN_TOOL_CALL_CLOSE}\n\n'
        prompt += 'IMPORTANT RULES:\n'
        prompt += f'1. If NONE of the provided functions are relevant, respond with a plain text message inside {TOKEN_ANSWER_OPEN} tags. Do NOT call any function when the query is unrelated.\n'
        prompt += f'   ABSTAIN for: general programming questions, capability questions ("what can you do"), greetings, thanks, CS concepts, API design patterns.\n'
        prompt += '2. Do not interpret or guess information. Wait for tool results to be returned before responding.\n'
        prompt += f'3. If a tool result provides the answer, output it directly inside {TOKEN_ANSWER_OPEN} tags.\n'
        
        # R4-5: Conditional clarification behavior
        if bfcl_eval_mode:
            prompt += '4. Execute aggressively — infer reasonable defaults for missing parameters.\n'
        else:
            prompt += "4. If the user's input lacks required parameters, ask for clarification.\n"
        
        prompt += '5. Do not hallucinate optional parameters. Only include parameters explicitly provided.\n'
        prompt += '6. When saving data to memory, use the EXACT variable names and values provided.\n'
        prompt += '7. For multi-step requests ("X then Y"), execute the FIRST action mentioned. The second action comes after the first tool response.'
    
    return prompt


# =============================================================================
# V4 Agentic API Schemas (R3-5: web_search, memory_kv, memory_vector)
# =============================================================================
# These schemas match the BFCL V4 heavily-weighted categories that were 
# previously missing from training data.
V4_API_SCHEMAS = {
    "web_search": [
        {
            "name": "web_search",
            "description": "Search the web for information. Returns a list of search results with titles, URLs, and snippets.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query string"},
                    "num_results": {"type": "integer", "description": "Number of results to return (1-20)", "default": 5},
                    "search_type": {"type": "string", "enum": ["general", "news", "images"], "default": "general"},
                },
                "required": ["query"],
            },
        },
        {
            "name": "web_scrape",
            "description": "Scrape and extract text content from a specific URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to scrape content from"},
                    "selector": {"type": "string", "description": "CSS selector to extract specific elements"},
                    "format": {"type": "string", "enum": ["text", "markdown", "html"], "default": "text"},
                },
                "required": ["url"],
            },
        },
        {
            "name": "web_click",
            "description": "Click on a link or button element on the current web page.",
            "parameters": {
                "type": "object",
                "properties": {
                    "element_id": {"type": "string", "description": "ID or CSS selector of the element to click"},
                    "wait_after": {"type": "integer", "description": "Milliseconds to wait after click", "default": 1000},
                },
                "required": ["element_id"],
            },
        },
    ],
    "memory_kv": [
        {
            "name": "memory_set",
            "description": "Store a key-value pair in persistent memory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "Memory key (alphanumeric with underscores)"},
                    "value": {"type": "string", "description": "Value to store"},
                    "namespace": {"type": "string", "description": "Optional namespace for key isolation", "default": "default"},
                    "ttl_seconds": {"type": "integer", "description": "Optional time-to-live in seconds"},
                },
                "required": ["key", "value"],
            },
        },
        {
            "name": "memory_get",
            "description": "Retrieve a value from persistent memory by key.",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "Memory key to retrieve"},
                    "namespace": {"type": "string", "description": "Namespace to search in", "default": "default"},
                },
                "required": ["key"],
            },
        },
        {
            "name": "memory_delete",
            "description": "Delete a key-value pair from persistent memory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "Memory key to delete"},
                    "namespace": {"type": "string", "description": "Namespace of the key", "default": "default"},
                    "dry_run": {"type": "boolean", "description": "Preview what would be deleted without executing", "default": False},
                },
                "required": ["key"],
            },
        },
        {
            "name": "memory_list",
            "description": "List all keys in persistent memory, optionally filtered by prefix.",
            "parameters": {
                "type": "object",
                "properties": {
                    "prefix": {"type": "string", "description": "Optional key prefix filter"},
                    "namespace": {"type": "string", "description": "Namespace to list", "default": "default"},
                    "limit": {"type": "integer", "description": "Maximum keys to return", "default": 100},
                },
            },
        },
    ],
    "memory_vector": [
        {
            "name": "vector_store",
            "description": "Store a text document with vector embedding in the vector database.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Text content to store and embed"},
                    "metadata": {"type": "object", "description": "Optional metadata dict to attach"},
                    "collection": {"type": "string", "description": "Vector collection name", "default": "default"},
                },
                "required": ["text"],
            },
        },
        {
            "name": "vector_search",
            "description": "Search the vector database by semantic similarity.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural language search query"},
                    "collection": {"type": "string", "description": "Collection to search", "default": "default"},
                    "top_k": {"type": "integer", "description": "Number of results to return", "default": 5},
                    "threshold": {"type": "number", "description": "Minimum similarity threshold (0-1)", "default": 0.7},
                },
                "required": ["query"],
            },
        },
        {
            "name": "vector_delete",
            "description": "Delete documents from the vector database by metadata filter.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filter": {"type": "object", "description": "Metadata filter for deletion"},
                    "collection": {"type": "string", "description": "Collection to delete from", "default": "default"},
                    "dry_run": {"type": "boolean", "description": "Preview what would be deleted without executing", "default": False},
                },
                "required": ["filter"],
            },
        },
    ],
}


# =============================================================================
# R5-1: Schema-Mapping Chain-of-Thought (SM-CoT) Builder
# =============================================================================
def build_smcot_think(tool_schema: dict, user_intent: str, param_values: dict) -> str:
    """Build a structured SM-CoT think block for training data.
    
    R5-1: Forces the model to explicitly map schema params as REQUIRED/OPTIONAL
    before generating JSON. This reduces hallucinated optional params (10% BFCL
    weight) and missed required params.
    
    Args:
        tool_schema: Tool definition dict with 'name', 'parameters', etc.
        user_intent: Short description of what the user wants.
        param_values: Dict of param_name -> value that the user explicitly provided.
    
    Returns:
        Formatted SM-CoT string (without surrounding think tokens).
    """
    name = tool_schema.get('name', 'unknown')
    params = tool_schema.get('parameters', {})
    props = params.get('properties', {})
    required = set(params.get('required', []))
    
    lines = [f"Intent: {user_intent}"]
    lines.append(f"Target Tool: {name}")
    lines.append("Schema Check:")
    
    for prop_name, prop_data in props.items():
        ptype = prop_data.get('type', 'string')
        presence = "REQUIRED" if prop_name in required else "OPTIONAL"
        
        if prop_name in param_values:
            val = param_values[prop_name]
            val_repr = json.dumps(val) if not isinstance(val, str) else f'"{val}"'
            lines.append(f"- {prop_name} ({ptype}) [{presence}]: {val_repr} ← user specified")
        elif presence == "REQUIRED":
            lines.append(f"- {prop_name} ({ptype}) [{presence}]: MISSING — ask user")
        else:
            lines.append(f"- {prop_name} ({ptype}) [{presence}]: Not specified → OMIT")
    
    # Determine action
    missing_required = [p for p in required if p not in param_values]
    if missing_required:
        lines.append(f"Action: Missing required params ({', '.join(missing_required)}). Ask for clarification.")
    else:
        omitted = [p for p in props if p not in param_values and p not in required]
        if omitted:
            lines.append(f"Action: Execute {name} with required params only. OMIT optional: {', '.join(omitted)}")
        else:
            lines.append(f"Action: Execute {name} with all specified params.")
    
    return "\n".join(lines)


def build_dryrun_smcot_think(tool_schema: dict, user_intent: str, param_values: dict) -> str:
    """Build SM-CoT for destructive actions with dry_run safety.
    
    R5-6: Forces the model to recognize destructive ops and add dry_run=true.
    """
    name = tool_schema.get('name', 'unknown')
    lines = [f"Intent: {user_intent}"]
    lines.append(f"Target Tool: {name}")
    lines.append(f"⚠️ DESTRUCTIVE ACTION DETECTED: {name} is in the destructive tools list.")
    lines.append("Safety Protocol: Execute with dry_run=true first to preview impact.")
    lines.append("Schema Check:")
    
    params = tool_schema.get('parameters', {})
    props = params.get('properties', {})
    required = set(params.get('required', []))
    
    for prop_name, prop_data in props.items():
        if prop_name == "dry_run":
            continue  # Handled explicitly below with [SAFETY] tag
        ptype = prop_data.get('type', 'string')
        presence = "REQUIRED" if prop_name in required else "OPTIONAL"
        if prop_name in param_values:
            val = param_values[prop_name]
            val_repr = json.dumps(val) if not isinstance(val, str) else f'"{val}"'
            lines.append(f"- {prop_name} ({ptype}) [{presence}]: {val_repr}")
        elif presence == "OPTIONAL":
            lines.append(f"- {prop_name} ({ptype}) [{presence}]: Not specified → OMIT")
    
    lines.append("- dry_run (boolean) [SAFETY]: true ← auto-injected for destructive ops")
    lines.append(f"Action: Execute {name} with dry_run=true, then confirm with user.")
    return "\n".join(lines)

