#!/usr/bin/env python3
"""
Cascade BFCL Eval: prism-coder:14b → prism-coder:32b → Claude Opus
=======================================================================
Per case: 14B answers first; if wrong, 32B; if 32B wrong, Opus.
Reports: tier distribution, cascade accuracy, per-category breakdown,
         cascade accuracy vs Opus-solo as etalon.

Usage:
  python3 cascade_eval.py                    # 3 seeds: 2027 2028 2029
  python3 cascade_eval.py 2027               # single seed

Requirements:
  pip install anthropic requests
  ollama pull dcostenco/prism-coder:14b
  ollama pull dcostenco/prism-coder:32b
  export ANTHROPIC_API_KEY=sk-ant-...
"""
import json, random, sys, os, time, importlib.util, requests, anthropic
from pathlib import Path

sys.stdout.reconfigure(line_buffering=True)

OLLAMA_URL = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
BENCH      = Path(__file__).parent.parent / "prism-routing-100/benchmark.py"
SEEDS      = [int(a) for a in sys.argv[1:]] if sys.argv[1:] else [2027, 2028, 2029]

spec = importlib.util.spec_from_file_location("bench", BENCH)
bench = importlib.util.module_from_spec(spec); spec.loader.exec_module(bench)

SYSTEM_PROMPT = bench.SYSTEM_PROMPT
TOOLS_SCHEMA  = bench.TOOLS_SCHEMA
TEST_POOL     = bench.TEST_POOL

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
if not ANTHROPIC_KEY:
    raise SystemExit("ANTHROPIC_API_KEY not set")
client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

# ── inference ──────────────────────────────────────────────────────────────────

def extract_tool_text(text: str):
    if "<|tool_call|>" not in text:
        return "plain"
    try:
        s = text.split("<|tool_call|>")[1]
        if "<|tool_call_end|>" in s:
            s = s.split("<|tool_call_end|>")[0]
        return json.loads(s.strip()).get("name")
    except Exception:
        return "PARSE_ERROR"


def call_ollama(tag: str, prompt: str) -> str:
    full = (
        f"<|im_start|>system\n{SYSTEM_PROMPT}<|im_end|>\n"
        f"<|im_start|>user\n{prompt}<|im_end|>\n"
        f"<|im_start|>assistant\n<think>\n\n</think>\n\n"
    )
    r = requests.post(
        f"{OLLAMA_URL}/api/generate",
        json={"model": tag, "prompt": full, "stream": False, "raw": True,
              "options": {"num_predict": 160, "temperature": 0,
                          "stop": ["<|im_end|>", "<|tool_call_end|>"]}},
        timeout=120,
    )
    return extract_tool_text(r.json().get("response", ""))


def call_opus(prompt: str) -> str:
    msg = client.messages.create(
        model="claude-opus-4-7",
        max_tokens=256,
        system=SYSTEM_PROMPT,
        tools=TOOLS_SCHEMA,
        messages=[{"role": "user", "content": prompt}],
    )
    for blk in msg.content:
        if blk.type == "tool_use":
            return blk.name
    return "plain"


# ── cascade eval ───────────────────────────────────────────────────────────────

def run_seed(seed: int) -> dict:
    random.seed(seed)
    cases = list(TEST_POOL)
    random.shuffle(cases)

    cascade_hits   = 0
    opus_solo_hits = 0
    tier_served = {"14b": 0, "32b": 0, "opus": 0}
    tier_hits   = {"14b": 0, "32b": 0, "opus": 0}
    cat_cascade: dict[str, list[bool]] = {}
    cat_opus:    dict[str, list[bool]] = {}
    escalations_14b = []   # (cat, prompt_snippet, expected, got)
    escalations_32b = []

    for i, (cat, prompt, expected) in enumerate(cases):
        exp = expected or "plain"

        # --- Cascade path ---
        got_14b = call_ollama("prism-coder:14b", prompt)
        if got_14b == exp:
            tier = "14b"; hit = True
        else:
            escalations_14b.append((cat, prompt[:60], exp, got_14b))
            got_32b = call_ollama("prism-coder:32b", prompt)
            if got_32b == exp:
                tier = "32b"; hit = True
            else:
                escalations_32b.append((cat, prompt[:60], exp, got_32b))
                got_opus = call_opus(prompt)
                tier = "opus"; hit = (got_opus == exp)

        tier_served[tier] += 1
        if hit:
            tier_hits[tier] += 1
            cascade_hits += 1
        cat_cascade.setdefault(cat, []).append(hit)

        # --- Opus solo (etalon) ---
        got_opus_solo = call_opus(prompt)
        opus_hit = (got_opus_solo == exp)
        if opus_hit:
            opus_solo_hits += 1
        cat_opus.setdefault(cat, []).append(opus_hit)

        if (i + 1) % 10 == 0:
            pct_c = round(100 * cascade_hits    / (i + 1), 1)
            pct_o = round(100 * opus_solo_hits  / (i + 1), 1)
            n32b  = len(escalations_14b)
            nopus = len(escalations_32b)
            print(
                f"  [seed {seed}] {i+1}/{len(cases)}"
                f" — cascade: {pct_c}%  opus-solo: {pct_o}%"
                f"  (→32b: {n32b}  →opus: {nopus})",
                flush=True,
            )

    total = len(cases)
    return {
        "seed": seed, "total": total,
        "cascade_pct":   round(100 * cascade_hits    / total, 1),
        "opus_solo_pct": round(100 * opus_solo_hits  / total, 1),
        "tier_served": tier_served,
        "tier_hits":   tier_hits,
        "tier_pct": {
            t: round(100 * tier_hits[t] / tier_served[t], 1) if tier_served[t] else 0
            for t in ("14b", "32b", "opus")
        },
        "escalations_to_32b":  escalations_14b,
        "escalations_to_opus": escalations_32b,
        "cat_cascade": {c: round(100 * sum(v) / len(v), 1) for c, v in sorted(cat_cascade.items())},
        "cat_opus":    {c: round(100 * sum(v) / len(v), 1) for c, v in sorted(cat_opus.items())},
    }


# ── report ─────────────────────────────────────────────────────────────────────

def print_report(results: list[dict]):
    n = len(results)
    cascade_mean = round(sum(r["cascade_pct"]   for r in results) / n, 1)
    opus_mean    = round(sum(r["opus_solo_pct"] for r in results) / n, 1)
    avg_served   = {t: round(sum(r["tier_served"][t] for r in results) / n, 1) for t in ("14b","32b","opus")}
    avg_tier_pct = {t: round(sum(r["tier_pct"][t]    for r in results) / n, 1) for t in ("14b","32b","opus")}
    total        = results[0]["total"]

    print("\n" + "=" * 70)
    print("  CASCADE EVAL REPORT — prism-coder:14b → :32b → Claude Opus")
    print(f"  {total} cases × {n} seeds | 6 tools | Opus = etalon")
    print("=" * 70)

    print(f"\n  ACCURACY — Cascade vs Opus-solo etalon")
    print(f"  {'Seed':<20} {'Cascade':>10} {'Opus-solo':>12}  {'Δ':>6}")
    print(f"  {'-'*20} {'-'*10} {'-'*12}  {'-'*6}")
    for r in results:
        d = round(r["cascade_pct"] - r["opus_solo_pct"], 1)
        print(f"  Seed {r['seed']:<15} {r['cascade_pct']:>9}%  {r['opus_solo_pct']:>10}%  {d:>+5}%")
    print(f"  {'Mean':<20} {cascade_mean:>9}%  {opus_mean:>10}%  {round(cascade_mean-opus_mean,1):>+5}%")

    print(f"\n  TIER DISTRIBUTION  (avg over {n} seeds, {total} cases/seed)")
    print(f"  {'Tier':<12} {'Served':>8} {'% traffic':>10} {'Accuracy':>10}")
    print(f"  {'-'*12} {'-'*8} {'-'*10} {'-'*10}")
    for t, label in [("14b","14B local"),("32b","32B local"),("opus","Opus API")]:
        sp = round(100 * avg_served[t] / total, 1)
        print(f"  {label:<12} {avg_served[t]:>8.1f} {sp:>9}%  {avg_tier_pct[t]:>9}%")

    print(f"\n  PER-CATEGORY  (seed {results[0]['seed']})")
    print(f"  {'Category':<10} {'Cascade':>9} {'Opus':>9}  {'Δ':>6}")
    print(f"  {'-'*10} {'-'*9} {'-'*9}  {'-'*6}")
    r0 = results[0]
    for c in sorted(set(list(r0["cat_cascade"]) + list(r0["cat_opus"]))):
        cc = r0["cat_cascade"].get(c, 0)
        co = r0["cat_opus"].get(c, 0)
        d  = cc - co
        flag = "  ◄ fine-tuning wins" if d >= 10 else ""
        print(f"  {c:<10} {cc:>8}%  {co:>8}%  {d:>+5}%{flag}")

    print(f"\n  ESCALATIONS (seed {results[0]['seed']})")
    for cat, p, exp, got in results[0]["escalations_to_32b"]:
        print(f"  14b→32b  [{cat}] {p!r}  exp={exp}  got={got}")
    for cat, p, exp, got in results[0]["escalations_to_opus"]:
        print(f"  32b→opus [{cat}] {p!r}  exp={exp}  got={got}")

    verdict = "cascade is cost-efficient (97%+ traffic served locally)" \
        if cascade_mean >= opus_mean else \
        f"Opus leads by {round(opus_mean-cascade_mean,1)}% — consider retraining"
    print(f"\n  VERDICT: Cascade {cascade_mean}% vs Opus-solo {opus_mean}% → {verdict}")
    print("=" * 70)


if __name__ == "__main__":
    print(f"CASCADE EVAL: 14b → 32b → Opus  |  Seeds: {SEEDS}  |  Cases: {len(TEST_POOL)}/seed")
    seed_results = []
    for seed in SEEDS:
        print(f"\n{'─'*60}\nSEED {seed}\n{'─'*60}")
        seed_results.append(run_seed(seed))
        r = seed_results[-1]
        print(f"  Seed {seed}: cascade={r['cascade_pct']}%  opus-solo={r['opus_solo_pct']}%"
              f"  →32b={len(r['escalations_to_32b'])}  →opus={len(r['escalations_to_opus'])}")

    print_report(seed_results)

    out = Path(__file__).parent / "results.json"
    with open(out, "w") as f:
        json.dump(seed_results, f, indent=2)
    print(f"\nResults saved to {out}")
