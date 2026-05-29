# Knowledge Ingestion — Train Your AI on Your Codebase

Prism MCP supports automatic codebase knowledge ingestion. Connect your repositories and Prism learns your code patterns, architecture, and conventions — available instantly via `knowledge_search` at inference time.

**No model retraining required.** Your codebase knowledge lives in the knowledge graph, not in model weights. Routing accuracy stays at 100%.

## How It Works

```
Your Repos → git hook → chunk & generate Q&A → POST to Prism API → Knowledge Graph
                                                                         ↓
                                              prism-coder routes → knowledge_search retrieves
                                                                         ↓
                                                              AI responds with your code context
```

1. **You push code** to any connected repository
2. **Git hook fires** — extracts changed files, chunks them, generates Q&A pairs
3. **Q&A pairs are posted** to the Prism Memory API (`/api/v1/prism/memory`)
4. **Knowledge graph indexes** the entries with full-text search + embeddings
5. **At inference time**, `knowledge_search` retrieves relevant code context
6. **The model responds** using your codebase knowledge — without retraining

## Quick Start (5 minutes)

### 1. Get Your API Key

```bash
# From the Prism MCP dashboard (localhost:3000)
# Or from your Synalux portal account → Settings → API Keys
export SYNALUX_API_KEY="synalux_sk_..."
```

### 2. Install the Ingestion Scripts

```bash
# Copy scripts to your preferred location
cp scripts/knowledge-ingest/gen_qa.py ~/.prism/hooks/
cp scripts/knowledge-ingest/ingest.mjs ~/.prism/hooks/
cp scripts/knowledge-ingest/post-commit ~/.prism/hooks/

# Make executable
chmod +x ~/.prism/hooks/post-commit
```

### 3. Add the Git Hook

```bash
# In each repo you want to connect:
cd /path/to/your/repo
ln -sf ~/.prism/hooks/post-commit .git/hooks/post-commit
```

That's it. Every commit now feeds your codebase into the knowledge graph.

## Architecture

### Components

| Component | Purpose | Location |
|-----------|---------|----------|
| `gen_qa.py` | Chunks source files, generates Q&A pairs via Claude API | `scripts/knowledge-ingest/` |
| `ingest.mjs` | Posts Q&A batches to Prism Memory API | `scripts/knowledge-ingest/` |
| `post-commit` | Git hook that orchestrates the pipeline | `scripts/knowledge-ingest/` |
| Prism Memory API | Stores entries in knowledge graph | `POST /api/v1/prism/memory` |
| `knowledge_search` | Retrieves relevant entries at inference | MCP tool |

### Storage Backends

| Mode | Backend | Use Case |
|------|---------|----------|
| `remote` (default) | Synalux Portal → Supabase | Teams, multi-device, production |
| `local` | SQLite (`prism-local.db`) | Offline, HIPAA, air-gapped |

Set `PRISM_FORCE_LOCAL=true` to keep all knowledge on-device.

### Data Flow

```
Source Code
    │
    ▼
┌─────────────┐
│  Chunker     │  Split files into ~4000 char chunks
│  (gen_qa.py) │  Filter chunks < 200 chars
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Q&A Gen     │  Claude Haiku generates 3 Q&A pairs per chunk
│  (gen_qa.py) │  Format: {"prompt": "...", "response": "..."}
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Ingest      │  Batch 30 pairs per API call
│  (ingest.mjs)│  POST /api/v1/prism/memory action=save_ledger
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Knowledge   │  FTS5 full-text index + vector embeddings
│  Graph       │  Searchable via knowledge_search MCP tool
└─────────────┘
```

## API Reference

### POST /api/v1/prism/memory

Save a knowledge entry to the graph.

**Authentication:**

```bash
# Step 1: Exchange API key for JWT
JWT=$(curl -s -X POST "https://your-portal.com/api/v1/auth/jwt" \
  -H "Authorization: Bearer $SYNALUX_API_KEY" | jq -r '.jwt')

# Step 2: Use JWT for all subsequent requests
curl -X POST "https://your-portal.com/api/v1/prism/memory" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "save_ledger",
    "project": "my-codebase",
    "summary": "Q: How does auth work?\nA: JWT-based, middleware in auth.ts...",
    "keywords": ["auth", "jwt", "middleware"],
    "decisions": []
  }'
```

**Response:**
```json
{"status": "success", "action": "save_ledger", "project": "my-codebase"}
```

### knowledge_search (MCP Tool)

Retrieve knowledge at inference time.

```json
{
  "name": "knowledge_search",
  "arguments": {
    "query": "how does authentication work",
    "project": "my-codebase",
    "limit": 5
  }
}
```

Returns matching Q&A entries from the knowledge graph, ranked by relevance.

## Scripts

### gen_qa.py — Q&A Generator

Reads a source file, chunks it, and generates Q&A training pairs using Claude Haiku.

```bash
# Generate Q&A for a single file
python3 gen_qa.py /path/to/source.ts my-project

# Output: /tmp/training_qa/qa_source.jsonl
```

**Requirements:**
- `ANTHROPIC_API_KEY` environment variable (or `~/.anthropic_key` file)
- Python 3.10+
- `anthropic` pip package

**Configuration:**
- Chunk size: 4000 chars (adjustable in script)
- Min chunk: 200 chars (skip trivial chunks)
- Q&A per chunk: 3
- Model: `claude-haiku-4-5-20251001`

### ingest.mjs — Knowledge Ingestion

Posts Q&A JSONL files to the Prism Memory API.

```bash
# Ingest all Q&A files in default directory
node ingest.mjs

# Custom directory
node ingest.mjs --dir /path/to/qa/files

# Custom API endpoint
SYNALUX_BASE_URL=https://my-portal.com node ingest.mjs
```

**Environment Variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `SYNALUX_API_KEY` | (required) | API key for authentication |
| `SYNALUX_BASE_URL` | `https://synalux.ai` | Portal API base URL |
| `QA_DIR` | `/tmp/training_qa` | Directory with Q&A JSONL files |

### post-commit — Git Hook

Orchestrates the full pipeline on every commit.

```bash
#!/bin/bash
# .git/hooks/post-commit
# Runs gen_qa.py on changed files, then ingest.mjs to push to knowledge graph

HOOKS_DIR="${PRISM_HOOKS_DIR:-$HOME/.prism/hooks}"
QA_DIR="/tmp/training_qa"
PROJECT_NAME=$(basename "$(git rev-parse --show-toplevel)")

# Get changed files in this commit
CHANGED=$(git diff-tree --no-commit-id --name-only -r HEAD -- '*.ts' '*.tsx' '*.py' '*.swift' '*.md')

if [ -z "$CHANGED" ]; then
    exit 0  # No relevant files changed
fi

# Concatenate changed files into a single source
COMBINED=$(mktemp)
for f in $CHANGED; do
    [ -f "$f" ] && echo "// === $f ===" >> "$COMBINED" && cat "$f" >> "$COMBINED"
done

# Generate Q&A
python3 "$HOOKS_DIR/gen_qa.py" "$COMBINED" "$PROJECT_NAME" 2>/dev/null

# Ingest to knowledge graph
node "$HOOKS_DIR/ingest.mjs" --dir "$QA_DIR" 2>/dev/null &

rm -f "$COMBINED"
```

## Advanced Configuration

### Multiple Repositories

Connect multiple repos to the same project:

```bash
# All repos share one knowledge namespace
for repo in ~/myapp ~/mylib ~/my-infra; do
    cd "$repo"
    ln -sf ~/.prism/hooks/post-commit .git/hooks/post-commit
done
```

Or use separate projects per repo:

```bash
# In .git/hooks/post-commit, override PROJECT_NAME:
PROJECT_NAME="backend-api"  # instead of auto-detecting from dirname
```

### File Filters

Edit the `post-commit` hook to control which files are indexed:

```bash
# Only TypeScript and Python
CHANGED=$(git diff-tree --no-commit-id --name-only -r HEAD -- '*.ts' '*.tsx' '*.py')

# Exclude test files
CHANGED=$(echo "$CHANGED" | grep -v '\.test\.' | grep -v '\.spec\.')

# Only src/ directory
CHANGED=$(echo "$CHANGED" | grep '^src/')
```

### Custom Q&A System Prompt

Override the Q&A generation prompt in `gen_qa.py`:

```python
# Default: general-purpose Q&A
system = 'Generate 3 Q&A training pairs as JSON array: [{"prompt":"...","response":"..."}]'

# Custom: domain-specific
system = 'Generate 3 Q&A pairs about clinical ABA software. Focus on data collection, behavior tracking, and treatment planning.'
```

### Rate Limiting

The ingestion script includes a 300ms delay between API calls. Adjust for your tier:

```javascript
// In ingest.mjs — increase for free tier, decrease for paid
await new Promise(r => setTimeout(r, 300));  // 300ms = ~3 req/sec
```

### Local-Only Mode (HIPAA / Air-Gapped)

For clinical installations where data must stay on-device:

```bash
# In your environment
export PRISM_FORCE_LOCAL=true

# Use the local ingestion script instead
node ingest_knowledge.mjs  # writes to prism-local.db directly
```

The same `knowledge_search` tool works — it just reads from local SQLite instead of Supabase.

### Scheduled Re-ingestion

For full repo snapshots (not just diffs), run periodically:

```bash
# macOS launchd (~/Library/LaunchAgents/com.prism.ingest.plist)
# Or crontab:
# 0 */6 * * * cd ~/prism && node ~/.prism/hooks/ingest.mjs >> /tmp/ingest.log 2>&1
```

## Troubleshooting

### Knowledge search returns 0 results

1. **Check storage mode**: `echo $PRISM_STORAGE` — if `auto` with `SYNALUX_API_KEY` set, data must be in remote Supabase, not local SQLite
2. **Check project name**: The project in `knowledge_search` must match the project used during ingestion
3. **Check API response**: Run `curl` manually against the memory endpoint to verify entries are saved

### Q&A generation is slow

- Each chunk takes ~1-2s via Claude Haiku
- Large repos (1000+ files) may take 30+ minutes
- Run in background: `nohup python3 gen_qa.py source.ts my-project &`

### API authentication fails

```bash
# Verify your key
curl -s https://synalux.ai/api/v1/auth/jwt \
  -H "Authorization: Bearer $SYNALUX_API_KEY" | jq .
```

## Security

- API keys are scoped to your organization — no cross-tenant access
- Knowledge entries inherit the project's access controls
- HIPAA-sensitive data should use `PRISM_FORCE_LOCAL=true`
- Git hooks run locally — source code is never sent to Prism, only generated Q&A summaries
- Q&A generation uses Anthropic API — review their data policies for your compliance needs
