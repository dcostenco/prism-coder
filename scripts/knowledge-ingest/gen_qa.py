#!/usr/bin/env python3
import anthropic, os, json, re, sys
from pathlib import Path

client = anthropic.Anthropic(api_key=open(os.path.expanduser("~/.anthropic_key")).read().strip())
OUT = Path("/tmp/training_qa")
OUT.mkdir(exist_ok=True)

source_file = sys.argv[1]
source_label = sys.argv[2]

text = Path(source_file).read_text()
lines = text.split('\n')
chunks, cur, cl = [], [], 0
for l in lines:
    if cl + len(l) > 4000 and cur:
        chunks.append('\n'.join(cur))
        cur, cl = [], 0
    cur.append(l)
    cl += len(l) + 1
if cur:
    chunks.append('\n'.join(cur))

chunks = [c for c in chunks if len(c.strip()) > 200]
print(f"{source_label}: {len(chunks)} chunks", flush=True)

pairs = []
for i, c in enumerate(chunks):
    try:
        r = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=2048,
            system='Generate 3 Q&A training pairs as JSON array: [{"prompt":"...","response":"..."}]',
            messages=[{"role": "user", "content": f"Source: {source_label}\n```\n{c[:5000]}\n```"}]
        )
        match = re.search(r'\[.*\]', r.content[0].text, re.DOTALL)
        if match:
            try:
                pairs.extend(json.loads(match.group()))
            except json.JSONDecodeError:
                pass
    except Exception:
        pass
    if (i + 1) % 50 == 0:
        print(f"  [{i+1}/{len(chunks)}] {len(pairs)} pairs", flush=True)

print(f"  -> {len(pairs)} pairs", flush=True)

basename = Path(source_file).stem
with open(OUT / f"qa_{basename}.jsonl", "w") as f:
    for p in pairs:
        row = {
            "text": (
                "<|im_start|>system\n"
                "You are Synalux AI, a clinical practice management and software development assistant.<|im_end|>\n"
                "<|im_start|>user\n"
                f"{p['prompt']}<|im_end|>\n"
                "<|im_start|>assistant\n"
                f"{p['response']}<|im_end|>"
            )
        }
        f.write(json.dumps(row) + "\n")
