#!/bin/bash
# Generate evidence bundle with assertions.
# Fails loudly if any evidence is inconsistent with config.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/tmp/prism-evidence}"
rm -rf "$OUT" && mkdir -p "$OUT"

cd "$DIR"
source .env 2>/dev/null || true
export $(grep -v '^#' .env 2>/dev/null | xargs) 2>/dev/null || true
TOKEN="${PRISM_SKILLS_TOKEN:-}"
PORTAL="${PRISM_SYNALUX_BASE_URL:-https://synalux.ai}"

echo "=== Generating evidence ==="

# Ev1: Portal paid resolution
echo -n "ev1 (portal paid)... "
curl -sf -X POST "$PORTAL/api/v1/prism/resolve" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"project":"prism-mcp"}' > "$OUT/01-portal-paid.json"
VERSION=$(python3 -c "import json; print(json.load(open('$OUT/01-portal-paid.json')).get('routing_version','?'))")
PAID_COUNT=$(python3 -c "import json; print(len(json.load(open('$OUT/01-portal-paid.json')).get('loaded',[])))")
echo "v$VERSION, $PAID_COUNT skills"
[ "$PAID_COUNT" -gt 20 ] || { echo "FAIL: paid should load >20 skills, got $PAID_COUNT"; exit 1; }

# Ev2: session_load_context content delivery
echo -n "ev2 (content delivery)... "
node -e "
const { sessionLoadContextHandler } = require('./dist/tools/ledgerHandlers.js');
(async () => {
  const t0 = Date.now();
  const r = await sessionLoadContextHandler({ project: 'prism-mcp', level: 'quick', conversation_id: 'evidence' });
  const latency_ms = Date.now() - t0;
  const text = r.content[0].text;
  const skills = (text.match(/\[📜 SKILL: ([^\]]+)\]/g) || []).map(s => s.replace(/\[📜 SKILL: |\]/g, ''));
  const total_chars = text.length;
  console.log(JSON.stringify({ skills_loaded: skills.length, has_content: text.includes('---\nname:'), total_chars, latency_ms, all_skills: skills }));
})().catch(e => { console.error(e.message); process.exit(1); });
" 2>/dev/null > "$OUT/02-session-load-content.json"
CONTENT_COUNT=$(python3 -c "import json; print(json.load(open('$OUT/02-session-load-content.json'))['skills_loaded'])")
HAS_CONTENT=$(python3 -c "import json; print(json.load(open('$OUT/02-session-load-content.json'))['has_content'])")
LATENCY=$(python3 -c "import json; print(json.load(open('$OUT/02-session-load-content.json')).get('latency_ms','?'))")
CHARS=$(python3 -c "import json; print(json.load(open('$OUT/02-session-load-content.json')).get('total_chars','?'))")
echo "$CONTENT_COUNT skills, content=$HAS_CONTENT, ${LATENCY}ms, ${CHARS} chars"
[ "$CHARS" -lt 150000 ] || { echo "WARN: session_load_context output is ${CHARS} chars — context budget growing"; }
[ "$CONTENT_COUNT" -gt 20 ] || { echo "FAIL: should load >20 skills with content, got $CONTENT_COUNT"; exit 1; }
[ "$HAS_CONTENT" = "True" ] || { echo "FAIL: skill content should include frontmatter"; exit 1; }

# Ev3: Free tier gating
echo -n "ev3 (free tier)... "
curl -sf -X POST "$PORTAL/api/v1/prism/resolve" \
  -H "Content-Type: application/json" \
  -d '{"project":"prism-mcp"}' > "$OUT/03-free-tier.json"
FREE_COUNT=$(python3 -c "import json; print(len(json.load(open('$OUT/03-free-tier.json')).get('loaded',[])))")
FREE_TIER=$(python3 -c "import json; print(json.load(open('$OUT/03-free-tier.json')).get('tier','?'))")
HAS_BCBA=$(python3 -c "import json; print('bcba_ai_assistant' in json.load(open('$OUT/03-free-tier.json')).get('loaded',[]))")
echo "tier=$FREE_TIER, $FREE_COUNT skills, bcba=$HAS_BCBA"
[ "$FREE_TIER" = "free" ] || { echo "FAIL: no-auth should be free tier"; exit 1; }
[ "$FREE_COUNT" -lt "$PAID_COUNT" ] || { echo "FAIL: free ($FREE_COUNT) should have fewer skills than paid ($PAID_COUNT)"; exit 1; }
[ "$HAS_BCBA" = "False" ] || { echo "FAIL: bcba should not be in free tier (not protected)"; exit 1; }

# Ev4: Ollama
echo -n "ev4 (ollama)... "
curl -sf http://localhost:11434/api/tags | python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(json.dumps({'models':[{'name':m['name'],'size_gb':round(m['size']/(1024**3),1)} for m in d.get('models',[])]}, indent=2))
" > "$OUT/04-ollama.json"
MODEL_COUNT=$(python3 -c "import json; print(len(json.load(open('$OUT/04-ollama.json'))['models']))")
echo "$MODEL_COUNT models"
[ "$MODEL_COUNT" -gt 0 ] || { echo "FAIL: no Ollama models available"; exit 1; }

# Ev5: prism_infer
echo -n "ev5 (inference)... "
node -e "
const { runInfer } = require('./dist/tools/prismInferHandler.js');
const os = require('os');
(async () => {
  const r = await runInfer(
    { prompt: 'What is 2+2? Answer with just the number.', max_tokens: 64, mode: 'route' },
    { freemem: () => require('./dist/utils/availableMemory.js').getAvailableMemoryBytes(),
      listTags: async () => { const r = await fetch('http://localhost:11434/api/tags').catch(()=>null); if(!r) return null; return new Set((await r.json()).models?.map(m=>m.name)||[]); },
      listLoaded: async () => { const r = await fetch('http://localhost:11434/api/ps').catch(()=>null); if(!r) return new Set(); return new Set((await r.json()).models?.map(m=>m.name)||[]); },
      callLocal: async (url,model,prompt,sys,max,temp,timeout,think) => { const body={model,messages:[{role:'user',content:prompt}],stream:false,think:!!think,options:{num_predict:max,temperature:temp}}; const r=await fetch(url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)}); const d=await r.json(); return {ok:true,text:d.message?.content||''}; },
      callLayer1: async () => 'OBVIOUS_NOT_RESERVED',
      callCloud: async () => ({ok:false,reason:'no_cloud'}),
      ollamaUrl: 'http://localhost:11434' }
  );
  console.log(JSON.stringify({ backend: r.backend, model: r.model_picked, used_cloud: r.used_cloud, latency_ms: r.latency_ms, output: r.output }));
})().catch(e => { console.error(e.message); process.exit(1); });
" 2>/dev/null > "$OUT/05-prism-infer.json"
OUTPUT_LEN=$(python3 -c "import json; print(len(json.load(open('$OUT/05-prism-infer.json')).get('output','')))")
BACKEND=$(python3 -c "import json; print(json.load(open('$OUT/05-prism-infer.json')).get('backend','?'))")
echo "$BACKEND, output=$OUTPUT_LEN chars"
[ "$OUTPUT_LEN" -gt 0 ] || { echo "FAIL: prism_infer returned empty output"; exit 1; }
OUTPUT=$(python3 -c "import json; print(json.load(open('$OUT/05-prism-infer.json')).get('output',''))")
echo "$OUTPUT" | grep -q "4" || { echo "FAIL: prism_infer output '$OUTPUT' does not contain expected answer '4'"; exit 1; }

# Ev6: Layer 1 classifier latency (cold + warm)
echo -n "ev6 (layer1 latency)... "
node -e "
const { callLayer1 } = require('./dist/utils/layer1.js');
(async () => {
  const model = 'dcostenco/prism-coder:4b';
  const url = 'http://localhost:11434';
  const prompt = 'write a Python hello world script';
  const t1 = Date.now();
  const v1 = await callLayer1(prompt, url, model);
  const cold_ms = Date.now() - t1;
  const t2 = Date.now();
  const v2 = await callLayer1(prompt, url, model);
  const warm_ms = Date.now() - t2;
  console.log(JSON.stringify({ cold_ms, warm_ms, verdict_cold: v1, verdict_warm: v2 }));
})().catch(e => { console.error(e.message); process.exit(1); });
" 2>/dev/null > "$OUT/06-layer1-latency.json"
COLD=$(python3 -c "import json; print(json.load(open('$OUT/06-layer1-latency.json')).get('cold_ms','?'))")
WARM=$(python3 -c "import json; print(json.load(open('$OUT/06-layer1-latency.json')).get('warm_ms','?'))")
echo "cold=${COLD}ms, warm=${WARM}ms"

# Version consistency
echo -n "version check... "
EV1_VER=$(python3 -c "import json; print(json.load(open('$OUT/01-portal-paid.json')).get('routing_version','?'))")
EV3_VER=$(python3 -c "import json; print(json.load(open('$OUT/03-free-tier.json')).get('routing_version','?'))")
[ "$EV1_VER" = "$EV3_VER" ] || { echo "FAIL: version mismatch ev1=$EV1_VER ev3=$EV3_VER"; exit 1; }
echo "v$EV1_VER consistent"

echo ""
echo "=== ALL ASSERTIONS PASSED ==="
echo "Evidence at: $OUT"
