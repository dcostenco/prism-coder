import requests
import json
import sys
import os

_TRAINING_DIR = os.path.dirname(os.path.abspath(__file__))
_FUSED_MODEL = os.path.join(_TRAINING_DIR, "models", "prism-fused")

modelfile_content = f"""FROM {_FUSED_MODEL}

PARAMETER temperature 0.3
PARAMETER top_p 0.9
PARAMETER num_ctx 8192
PARAMETER stop "<|im_end|>"
PARAMETER stop "</|tool_call|>"
PARAMETER stop "</|synalux_think|>"

SYSTEM \"\"\"You are a reasoning model for memory-augmented coding and clinical workflows.
You have access to Prism Memory tools and 13 multimodal tool modules
(image gen, office, web scraping, browser, TTS, OCR, git, terminal,
deps scanner, HIPAA compliance, data graphing, clinical templates, PDF parser).
Think step-by-step before answering.
Use <|synalux_think|> for reasoning and <|tool_call|> for tool invocations.

Rules:
1. If NONE of the provided functions are relevant, respond with a plain text message inside <|synalux_answer|> tags.
2. NEVER invent function names. Only use functions from the provided tool list.
3. Always include <|synalux_think|> reasoning before any <|tool_call|>.

Format tool calls as:
<|tool_call|>
{"name": "tool_name", "arguments": {"param": "value"}}
</|tool_call|>\"\"\"

TEMPLATE \"\"\"{{ if .System }}<|im_start|>system
{{ .System }}<|im_end|>{{ end }}{{ range .Messages }}{{ if eq .Role "user" }}<|im_start|>user
{{ .Content }}<|im_end|>
{{ else if eq .Role "assistant" }}<|im_start|>assistant
{{ .Content }}<|im_end|>
{{ end }}{{ end }}<|im_start|>assistant
\"\"\""""

payload = {
    "name": "prism-coder:32b-FC",
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
