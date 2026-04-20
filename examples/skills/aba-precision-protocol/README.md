# ABA Precision Protocol — Example Skill

This directory contains an example Prism skill that demonstrates how to encode behavioral rules as both human-readable instructions and executable test suites.

## Contents

| File | Purpose |
|------|---------|
| `SKILL.md` | The skill definition — 3 ABA-based rules for agent precision execution |
| `RESULTS.md` | Before/after cognitive behavior analysis from real production incidents |

## What This Skill Does

The ABA (Applied Behavior Analysis) Precision Protocol establishes three foundational rules for agent behavior:

1. **Observable Goals** — Every task must have a measurable, verifiable outcome. Inter-observer agreement ≥80%.
2. **Slow & Precise Execution** — One step at a time. Verify each step. Stop on error, fix, then continue.
3. **Prevent Intermittent Reinforcement** — Uncaught mistakes create wrong behavioral patterns that strengthen over time. Catch errors immediately.

## Test Suite

The protocol includes a 24-test Vitest suite at [`tests/v43-aba-precision.test.ts`](../../../tests/v43-aba-precision.test.ts) that verifies:

- Vague goals are rejected, observable goals are accepted
- Execution stops on verification failure (never skips)
- Intermittent reinforcement of wrong patterns is detected at low/high/critical levels
- The exact regression scenario (Apr 15, 2026) is encoded

## Using This as a Template

To create your own behavioral skill:

1. Define the rules as clear, observable behavioral criteria
2. Write anti-patterns (what NOT to do) with concrete examples
3. Write correct patterns (what TO do) with concrete examples
4. Encode the rules as executable tests
5. Include real regression scenarios from actual failures

## Origin

Created during a 2-day production debugging session where an AI agent exhibited intermittent reinforcement of wrong behaviors — asking permission for obvious bugs, dismissing user reports without reading code, and batching changes without verification. A BCBA (Board Certified Behavior Analyst) identified the root cause as classical intermittent reinforcement and prescribed these ABA-based correction protocols.
