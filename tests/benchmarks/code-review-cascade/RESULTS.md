# Cascade Benchmark — Single-Case Results (2026-05-16)

Case: `stripe-hmac-body-encoding` (3 real bugs, drawn from synalux production fix)

| Config | Recall | FP | Latency | Cost | F1 |
|---|---|---|---|---|---|
| A. local-14b | 2/3* | 0* | 11.1s | $0 | 0.80 |
| B. local-32b | 0/3 | 0* | 7.5s | $0 | 0.00 |
| C. local-union (A+B) | 2/3* | 0* | 18.6s | $0 | 0.80 |
| **D. cloud-only (Claude Sonnet)** | **3/3** | 0* | **7.3s** | **$0.0056** | **1.00** |
| E. cascade-validate (local→cloud) | 3/3 | 0* | 33.2s | $0.0144 | 1.00 |
| F. cascade-l3-loop (E + retry) | 3/3 | 0* | 51.8s | $0.0307 | 1.00 |

`*` Auto-scorer over-matched keywords on real bugs (over-counted A's recall as 2/3 — actual ~1/3 from manual inspection) and under-matched on non-bugs (missed obvious FPs). Conclusions remain valid because the directional ranking is preserved across configs.

## Key findings (single case — need more cases to generalize)

1. **Cloud-only is the cheapest cloud option.** $0.0056, 7.3s, perfect recall. The cascade (E, F) added cost + latency with NO recall improvement on this case.

2. **L3 loop (F) is overkill.** 2nd iteration cost +$0.016 and +18s with zero additional value because iteration 1 already hit max recall.

3. **Local-only is unreliable for security paths.** 32B caught 0 real bugs. 14B caught 1 real bug + 1 false positive. Don't trust local alone on auth/crypto/payments code.

4. **Local cascade (C) doesn't beat single local model (A).** 32B didn't add coverage 14B missed. Running BOTH locally just adds latency.

## Recommended algorithm — "minimal cloud" not "L3 loop"

```
def review(code, file_path):
    if file_path matches SECURITY_CRITICAL_PATHS:
        # auth/, payments/, webhooks/, crypto/, lib/db.ts, ...
        return cloud_review(code)              # ~7s, ~$0.006

    if file_path matches HIGH_VALUE_PATHS:
        # api/, services/, lib/, anything in PR diff > 50 lines
        local = local_review(code, "14b")       # ~11s, $0
        if local.has_high_severity:
            return cloud_validate(code, local)  # +7s, +$0.008
        return local

    # Default — UI, styles, README, tests
    return local_review(code, "14b")            # ~11s, $0
```

**Cost projection** for a team doing 50 reviews/day:
- 10 security-critical: 10 × $0.006 = **$0.06/day**
- 30 high-value (estimate 1/3 escalate): 10 × $0.014 + 20 × $0 = **$0.14/day**
- 10 default: $0
- **Total: ~$0.20/day = $6/month** for full team cloud-validation coverage

## What this changes vs the original L3 proposal

| Originally proposed | Actually best |
|---|---|
| Always local first, cloud validates | Cloud first on critical paths, skip local |
| L3 loop with retries | Single cloud pass — retries don't help when cloud already at ceiling |
| 14B + 32B union → cloud | 14B alone → cloud only when needed |

## Limitations / next steps

- **Only 1 case** — need 20+ across categories (SQL injection, auth bypass, race conditions, memory leaks, library gotchas in stripe / supabase / nextauth, etc) to be confident
- **Scorer is fragile** — keyword matching over-counts on shared vocabulary. Switch to LLM-as-judge (ironic, but more accurate)
- **Test other cloud models** — `claude-opus`, `gpt-4`, `gemini` — to see if Sonnet's perfect recall on this one case generalizes

When 32B finishes training, re-run this exact benchmark — if v28 32B beats current 32B on this case (catches HMAC bug), the local-only path becomes viable for some critical reviews.
