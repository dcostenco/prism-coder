import requests
import json
import sys

modelfile_content = """FROM /Users/admin/prism/training/models/prism-fused

PARAMETER temperature 0.3
PARAMETER top_p 0.9
PARAMETER num_ctx 8192
PARAMETER stop "<|im_end|>"
PARAMETER stop "</tool_call>"

SYSTEM \"\"\"You are Prism, an AI coding assistant with persistent memory across sessions.
You have access to MCP tools for session management, knowledge retrieval, and project context.
When users ask about project history, decisions, stored context, or need to save work, use the appropriate tool.
When users ask general coding questions, answer directly without using tools.

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

Format tool calls as:
<tool_call>
{"name": "tool_name", "arguments": {"param": "value"}}
</tool_call>\"\"\"

TEMPLATE \"\"\"{{ if .System }}<|im_start|>system
{{ .System }}<|im_end|>{{ end }}{{ range .Messages }}{{ if eq .Role "user" }}<|im_start|>user
{{ .Content }}<|im_end|>
{{ else if eq .Role "assistant" }}<|im_start|>assistant
{{ .Content }}<|im_end|>
{{ end }}{{ end }}<|im_start|>assistant
\"\"\""""

payload = {
    "name": "prism-coder:7b",
    "modelfile": modelfile_content,
    "stream": True
}

try:
    print("Initiating model creation via Ollama API...")
    response = requests.post("http://localhost:11434/api/create", json=payload, stream=True)
    response.raise_for_status()
    for line in response.iter_lines():
        if line:
            data = json.loads(line)
            status = data.get("status", "")
            print(f"- {status}", flush=True)
            if status == "success":
                break
    print("Model successfully loaded into Ollama.")
except Exception as e:
    print(f"Failed: {e}")
    sys.exit(1)
