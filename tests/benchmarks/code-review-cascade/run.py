#!/usr/bin/env python3
"""Code-review cascade benchmark runner.

Tests 5 configurations on each case in cases.jsonl:

  A. local-14b-only    — single local model
  B. local-32b-only    — single local model
  C. local-union       — 14B ∪ 32B (no cloud)
  D. cloud-only        — Claude direct, no local
  E. cascade-validate  — local-union → cloud validator filters FPs + adds missed
  F. cascade-l3-loop   — cascade-validate, then re-validate if missed-bug count > 0

For each (case, config), records:
  - real_bugs_caught (out of total real_bugs)
  - false_positives raised
  - latency_ms
  - cost_estimate ($)
"""
import json, os, re, time
from pathlib import Path
import anthropic
import requests

CASES = Path(__file__).parent / "cases.jsonl"
OLLAMA = "http://localhost:11434"

REVIEW_PROMPT = """You are reviewing this {lang} code for REAL bugs.
Be STRICT — do NOT flag missing imports or style issues. Only flag bugs
that would cause incorrect behavior, security issues, or crashes.

```{lang}
{code}
```

Return a numbered list. Each entry: severity (high/med/low), one-line
description, fix hint. No preamble."""

VALIDATOR_PROMPT = """You are a strict code-review validator. The code below was reviewed by
2 local language models that produced these candidate issues.

Your job:
  1. For each LOCAL CANDIDATE — mark TRUE_POSITIVE or FALSE_POSITIVE with reason
  2. List REAL BUGS the locals MISSED (library gotchas, security holes, race conditions)
  3. Return STRICT JSON only — no preamble, no markdown:

{{
  "true_positives": [{{ "candidate": "...", "severity": "high|medium|low" }}],
  "false_positives": [{{ "candidate": "...", "why": "..." }}],
  "missed": [{{ "severity": "high|medium|low", "description": "...", "fix_hint": "..." }}]
}}

CODE ({lang}):
```{lang}
{code}
```

LOCAL CANDIDATES:
{candidates}
"""

# ── Local model call ─────────────────────────────────────────────────────────

def call_ollama(model: str, prompt: str, timeout: int = 90) -> tuple[str, float]:
    t0 = time.time()
    r = requests.post(f"{OLLAMA}/api/generate", json={
        "model": model, "prompt": prompt, "stream": False,
        "options": {"num_predict": 500, "temperature": 0},
    }, timeout=timeout)
    r.raise_for_status()
    return r.json().get("response", ""), (time.time() - t0) * 1000

# ── Cloud call ───────────────────────────────────────────────────────────────

CLAUDE_MODEL = "claude-sonnet-4-6"
INPUT_COST_PER_M = 3.0   # $3/M input tokens for sonnet
OUTPUT_COST_PER_M = 15.0

def call_claude(prompt: str, system: str = "") -> tuple[str, dict]:
    client = anthropic.Anthropic()
    t0 = time.time()
    msg = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=1500,
        system=system or "You are a strict code reviewer.",
        messages=[{"role": "user", "content": prompt}],
    )
    latency_ms = (time.time() - t0) * 1000
    in_tok = msg.usage.input_tokens
    out_tok = msg.usage.output_tokens
    cost = (in_tok * INPUT_COST_PER_M + out_tok * OUTPUT_COST_PER_M) / 1e6
    text = "\n".join(b.text for b in msg.content if hasattr(b, "text"))
    return text, {"latency_ms": latency_ms, "in_tok": in_tok, "out_tok": out_tok, "cost": cost}

# ── Scoring ──────────────────────────────────────────────────────────────────

def score(output: str, case: dict) -> dict:
    """Match found issues against real_bugs (fuzzy by tags + keywords) and non_bugs."""
    out_lower = output.lower()
    caught = []
    for bug in case["real_bugs"]:
        # Match if any tag OR distinctive keyword from description appears in output
        keywords = [
            *bug.get("tags", []),
            *re.findall(r"\b[a-z]{4,}\b", bug["description"].lower())[:5],
        ]
        # Require at least 2 distinctive keywords matched OR one strong signature
        sig = bug["description"].lower()[:30]
        hits = sum(1 for k in keywords if k in out_lower)
        if hits >= 2 or any(s in out_lower for s in [
            "hmac", "buffer", "arraybuffer", "req.text()",       # stripe-hmac case
            "idempot", "unique constraint", "23505",             # idempotency case
            "trailing whitespace", "newline in env",              # env-var case
        ]):
            # Check if any of bug's tags or sig actually relates to this output portion
            if hits >= 2 or any(t in out_lower for t in bug.get("tags", [])):
                caught.append(bug["description"][:60])
    fps = 0
    for nb in case.get("non_bugs", []):
        # First word of non-bug (usually the false-positive thing)
        first_phrase = nb.split("(")[0].strip().lower()
        if first_phrase[:15] in out_lower:
            fps += 1
    return {
        "real_caught": len(caught),
        "real_total": len(case["real_bugs"]),
        "false_positives": fps,
        "caught_list": caught,
    }

# ── Configurations ───────────────────────────────────────────────────────────

def config_A_14b(case):
    prompt = REVIEW_PROMPT.format(lang=case["language"], code=case["code"])
    out, lat = call_ollama("prism-coder:14b", prompt)
    s = score(out, case)
    s.update(latency_ms=lat, cost=0.0, raw=out[:400])
    return s

def config_B_32b(case):
    prompt = REVIEW_PROMPT.format(lang=case["language"], code=case["code"])
    out, lat = call_ollama("prism-coder:32b", prompt, timeout=180)
    s = score(out, case)
    s.update(latency_ms=lat, cost=0.0, raw=out[:400])
    return s

def config_C_local_union(case):
    a = config_A_14b(case)
    b = config_B_32b(case)
    return {
        "real_caught": min(a["real_total"], len(set(a["caught_list"] + b["caught_list"]))),
        "real_total":  a["real_total"],
        "false_positives": a["false_positives"] + b["false_positives"],
        "latency_ms":  a["latency_ms"] + b["latency_ms"],
        "cost": 0.0,
        "_a": a, "_b": b,
    }

def config_D_cloud_only(case):
    prompt = REVIEW_PROMPT.format(lang=case["language"], code=case["code"])
    out, meta = call_claude(prompt)
    s = score(out, case)
    s.update(latency_ms=meta["latency_ms"], cost=meta["cost"], raw=out[:400])
    return s

def config_E_cascade_validate(case):
    a = config_A_14b(case)
    b = config_B_32b(case)
    candidates = (a.get("raw","") + "\n---\n" + b.get("raw",""))[:2500]
    prompt = VALIDATOR_PROMPT.format(
        lang=case["language"], code=case["code"], candidates=candidates)
    out, meta = call_claude(prompt)
    try:
        # Strip ```json fences if any
        cleaned = re.sub(r"^```(?:json)?\n?|```$", "", out.strip(), flags=re.MULTILINE).strip()
        parsed = json.loads(cleaned)
        tp = parsed.get("true_positives", [])
        fp = parsed.get("false_positives", [])
        missed = parsed.get("missed", [])
        # Use cloud's union of TP + missed for final scoring
        merged_text = (
            " ".join(t.get("candidate","")+" "+t.get("severity","") for t in tp) + " " +
            " ".join(m.get("description","")+" "+m.get("fix_hint","") for m in missed)
        )
        s = score(merged_text, case)
        s.update(
            latency_ms=a["latency_ms"]+b["latency_ms"]+meta["latency_ms"],
            cost=meta["cost"],
            raw_local_count=len(tp)+len(fp),
            cloud_tp=len(tp), cloud_fp=len(fp), cloud_missed=len(missed),
        )
        return s
    except Exception as e:
        return {"real_caught": 0, "real_total": len(case["real_bugs"]),
                "false_positives": 0, "latency_ms": 0, "cost": meta["cost"],
                "error": str(e), "raw": out[:300]}

def config_F_cascade_l3_loop(case):
    """L3 loop: if cloud missed > 0, re-run with cloud's findings injected."""
    r1 = config_E_cascade_validate(case)
    # Re-run only if cloud reported missed bugs (signal local was incomplete)
    if r1.get("cloud_missed", 0) == 0:
        r1["iterations"] = 1
        return r1
    # Iteration 2 — give cloud another shot with its own previous output
    a = config_A_14b(case)
    b = config_B_32b(case)
    extra = "\nNOTE: previous iteration found %d missed bugs — be extra strict for library-specific gotchas." % r1.get("cloud_missed", 0)
    candidates = (a.get("raw","") + "\n---\n" + b.get("raw","") + extra)[:2700]
    prompt = VALIDATOR_PROMPT.format(
        lang=case["language"], code=case["code"], candidates=candidates)
    out, meta = call_claude(prompt)
    try:
        cleaned = re.sub(r"^```(?:json)?\n?|```$", "", out.strip(), flags=re.MULTILINE).strip()
        parsed = json.loads(cleaned)
        tp = parsed.get("true_positives", [])
        missed = parsed.get("missed", [])
        merged_text = (
            " ".join(t.get("candidate","")+" "+t.get("severity","") for t in tp) + " " +
            " ".join(m.get("description","")+" "+m.get("fix_hint","") for m in missed)
        )
        s = score(merged_text, case)
        s.update(
            latency_ms=r1["latency_ms"] + meta["latency_ms"],
            cost=r1["cost"] + meta["cost"],
            iterations=2,
        )
        return s
    except Exception as e:
        r1["iterations"] = 2
        r1["loop_error"] = str(e)
        return r1

# ── Main ─────────────────────────────────────────────────────────────────────

CONFIGS = {
    "A.local-14b":    config_A_14b,
    "B.local-32b":    config_B_32b,
    "C.local-union":  config_C_local_union,
    "D.cloud-only":   config_D_cloud_only,
    "E.cascade-validate": config_E_cascade_validate,
    "F.cascade-l3-loop":  config_F_cascade_l3_loop,
}

def main():
    cases = [json.loads(l) for l in CASES.read_text().splitlines() if l.strip()]
    results = []
    for case in cases:
        print(f"\n=== Case: {case['id']} ({len(case['real_bugs'])} real bugs) ===")
        for name, fn in CONFIGS.items():
            print(f"  {name}…", flush=True)
            try:
                r = fn(case)
                r["case"] = case["id"]
                r["config"] = name
                results.append(r)
                f1 = (2 * r["real_caught"] / r["real_total"]) / (1 + (r["false_positives"] / max(1, r["real_total"])))
                print(f"    recall={r['real_caught']}/{r['real_total']}  fp={r['false_positives']}  lat={r['latency_ms']:.0f}ms  cost=${r['cost']:.4f}")
            except Exception as e:
                print(f"    ERROR: {e}")
                results.append({"case": case["id"], "config": name, "error": str(e)})

    # Summary
    print("\n" + "="*70)
    print(f"{'Config':25} {'Recall':10} {'FP':>5} {'Lat':>8} {'Cost':>9} {'F1':>6}")
    print("="*70)
    for r in results:
        if "error" in r:
            print(f"{r['config']:25} ERROR: {r['error'][:30]}")
            continue
        recall = r["real_caught"] / r["real_total"]
        precision = r["real_caught"] / max(1, r["real_caught"] + r["false_positives"])
        f1 = 2 * recall * precision / max(1e-9, recall + precision)
        print(f"{r['config']:25} {r['real_caught']}/{r['real_total']:<7} "
              f"{r['false_positives']:>5} {r['latency_ms']:>7.0f}ms ${r['cost']:>7.4f} {f1:>6.2f}")

    Path(__file__).parent.joinpath("results.json").write_text(json.dumps(results, indent=2))
    print(f"\n→ Full results saved to {Path(__file__).parent}/results.json")

if __name__ == "__main__":
    main()
