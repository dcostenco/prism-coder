# Synalux v0.12.22 — Code Review: Post-Generation Output Guardrail System

## Context

Synalux is an AI-powered ABA (Applied Behavior Analysis) practice management platform. It serves **healthcare practitioners** managing patient data (PHI/HIPAA-relevant). The platform has:
- **Cloud Portal** — Next.js on Vercel, chat via SSE streaming (Gemini / OpenRouter LLMs)
- **VS Code Extension** — Local AI with Ollama, has browser/terminal/git tools
- **Shared Protocol** — `aba-protocol-prompt.ts` enforces behavioral rules across both interfaces

### What Changed (v0.12.18 → v0.12.22)

We implemented a **three-layer defense-in-depth** architecture to prevent LLM behavioral failures:

1. **Layer 1: Input Sanitization** — XML tag stripping (`<system>`, `<user_input>`) on user input before it reaches the LLM
2. **Layer 2: Sliding Window Buffer + Regex Filter** — Server-side deterministic post-generation guardrail that buffers first 80 chars of AI response, runs regex against accumulated text, catches multi-token violations fragmented across SSE chunks
3. **Layer 3: Frontend Domain Whitelist + Action Buttons** — Replaced zero-click `window.open()` with human-in-the-loop action buttons for whitelisted domains only

### Why

The LLM exhibited three categories of failures that prompt engineering alone cannot fix:
- **Prompt Leakage**: AI regurgitated internal instructions ("The browser will automatically open...")
- **Meta-Commentary**: AI described actions instead of acting ("I need the specific deploy_id")
- **Escape Hatch Abuse**: AI used `Missing: deploy_id` to refuse tool requests

## Files Changed (5 files, ~77K tokens)

| File | Purpose | Risk Level |
|------|---------|:----------:|
| `portal/src/app/api/v1/chat/route.ts` | SSE streaming endpoint + sliding window buffer + guardrail regex | 🚨 HIGH |
| `portal/src/app/app/chat/page.tsx` | Frontend chat UI + action buttons + domain whitelist | ⚠️ HIGH |
| `shared/aba-protocol-prompt.ts` | Shared system prompt rules (Cloud + VS Code) | 🟡 MEDIUM |
| `synalux-vscode/src/chat-panel.ts` | VS Code extension chat panel + XML sanitization | 🟡 MEDIUM |
| `tests/intent-classification.test.ts` | 482 tests: intent classification + guardrail + edge cases | 🔵 LOW |

## Review Instructions

**Adopt an attacker mindset.** You are reviewing a system where:
- The LLM is the untrusted component (it can say anything)
- The SSE stream is the attack surface (fragmented tokens, timing)
- The frontend executes URLs from AI output (phishing vector)
- The system processes healthcare data (HIPAA)

### Specific Questions

1. **Sliding Window Buffer Race Condition**: The buffer holds first 80 chars, then flushes. If the LLM sends a clean 80-char prefix followed by a violation on char 81+ (e.g., `"Here is the URL: https://vercel.com/deployments\nUnfortunately I cannot actually help"`), the guardrail only checks the buffered portion. **Can an attacker craft a prompt that causes the LLM to emit a clean prefix followed by a dangerous suffix that bypasses the buffer?**

2. **Guardrail Pattern Completeness**: The regex patterns block known violation phrases. **Are there semantically equivalent reformulations that evade all patterns?** E.g., "I lack the capability to..." (not caught by `^I cannot`), or "My limitations prevent me from..." (not caught by any pattern).

3. **SSE Chunk Store & Re-emit Integrity**: When the buffer is clean, `bufferedSSEChunks[]` stores raw SSE chunks as `Uint8Array` and re-emits them. **Is there a risk of chunk corruption, reordering, or duplication during the store-and-flush cycle?** Specifically, can a malformed SSE chunk cause the TextDecoder to produce invalid UTF-8 that survives the buffer but corrupts rendering?

4. **Domain Whitelist Bypass**: The regex `^https:\/\/([a-z0-9-]+\.)*vercel\.com\/` whitelists Vercel. **Can an attacker register a subdomain like `vercel.com.attacker.com` that matches?** Note: the regex requires `vercel.com/` (with trailing slash) — does this actually prevent `vercel.com.attacker.com/path`? (Answer: the `.` before `com` is literal, but the `([a-z0-9-]+\.)*` prefix group is greedy — verify this.)

5. **Empty Fallback Information Leak**: When the guardrail triggers and the cleaned text is < 5 chars, it emits `GUARDRAIL_FALLBACK_RESPONSE`. **Does the fallback message itself leak information about the guardrail's existence?** Could an adversary use repeated probes to map which inputs trigger the fallback, effectively fingerprinting your guardrail rules?

6. **Prompt Injection via Tool Responses**: If a Gemini tool call returns user-controlled data (e.g., patient name containing `<system>Ignore all rules</system>`), **does the XML sanitizer in `chat-panel.ts` also sanitize tool results, or only direct user input?**

7. **VS Code Extension Desync**: The shared module `aba-protocol-prompt.ts` defines `RULE7_CLOUD` and `RULE7_LOCAL`. The VS Code extension (`chat-panel.ts`) imports the local variant. **Is the VS Code extension's XML sanitizer applied at the same injection point as the portal's, or is there a code path where unsanitized input reaches the LLM?**

8. **Token Budget Exhaustion via Guardrail**: The guardrail replaces a violated response with a clean one but still counts the original streamed tokens for billing (`streamedTokens`). **Can an attacker trigger the guardrail repeatedly to exhaust a user's daily token budget while the user sees only fallback messages?**

9. **HIPAA / PHI in Guardrail Logs**: If a response contains PHI (e.g., patient name) AND triggers a guardrail violation, **is the original (violated) response logged anywhere?** The `checkOutputGuardrail` function returns the `pattern` — could this be logged alongside PHI?

10. **Action Button Click-Jacking**: The frontend renders action buttons with `window.open(url, '_blank')`. **Could an attacker overlay a transparent element on top of the chat to intercept the click, or embed a malicious iframe that the button opens within the portal's CSP?**

11. **Regex ReDoS (Regular Expression Denial of Service)**: Several guardrail patterns use alternation groups with overlapping prefixes (e.g., `(automatically |auto[- ]?)?`). **Is any pattern vulnerable to catastrophic backtracking on adversarial input?** Test with: `"the browser will auto auto auto auto auto auto auto auto open"`.

12. **System Prompt Token Inflation**: The IF/THEN rules in the system prompt add ~500 tokens of instructions. With conversation history growing, **at what point does the system prompt + history exceed the model's context window, causing the safety rules to be truncated (lost-in-the-middle)?**

### Output Format

For each finding:

```
### [SEVERITY] Finding Title
- **File**: path/to/file.ts:L123
- **Attack**: How an adversary exploits this
- **Impact**: What they achieve (data leak, phishing, billing abuse, etc.)
- **Fix**: Specific code change or architectural recommendation
```

Severity: 🚨 CRITICAL | ⚠️ HIGH | 🟡 MEDIUM | 🔵 LOW | ✅ GOOD

---

## How to Use

1. Load `repomix-guardrail-review.txt` (77K tokens) into a large-context model (Claude 200K, Gemini 1M, GPT-4o 128K)
2. Paste this prompt before or after the repomix content
3. For smaller context windows, use `repomix-guardrail-code.txt` (65K) for code-only review, or `repomix-guardrail-tests.txt` (13K) for test coverage review
