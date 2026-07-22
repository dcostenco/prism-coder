# Prism Browser local testing

`prism browser` is a packaged, agent-facing local browser runner powered by
Python Playwright. It is intended for repeatable development and acceptance
checks against applications you control. The npm package contains the runner,
so a separate app or DMG is not required.

## What it adds to Playwright

- **One CLI across agents.** Codex, Claude, Gemini, Cursor, and shell workflows
  can invoke the same structured commands when Prism is connected.
- **Persistent named profiles.** `--profile NAME` reuses Chromium state across
  launches instead of requiring every agent to build profile management.
- **Low-overhead multi-step sessions.** Pipe and REPL modes keep one browser
  session alive while several navigation, DOM, input, wait, and evaluation
  commands run.
- **Local preload helpers.** Repeatable `--inject` scripts run before page
  scripts, allowing deterministic feature flags, fixtures, capability shims,
  or instrumentation for localhost tests.
- **A constrained injection boundary.** Injection requires `--local-only`,
  which rejects public navigation and non-loopback subrequests.
- **Private audit records.** The runner stores a local audit trail with private
  filesystem permissions and removes URL credentials, query strings,
  fragments, common email/phone patterns, and injected source text.

These are orchestration and safety benefits. Prism Browser does not replace
Playwright Test: use raw Playwright when you need its complete fixture,
assertion, trace, project, or parallel-worker APIs. Compatibility patches are
best effort and are not a CAPTCHA-bypass guarantee.

## Install the local runtime

```bash
pip3 install playwright playwright-stealth
python3 -m playwright install chromium
```

The npm package supplies `scripts/dev/browse.py`; the Python runtime supplies
the browser engine. To use a specific Python installation, set
`PRISM_PYTHON=/absolute/path/to/python3`.

## Local acceptance flow

```bash
printf 'open http://127.0.0.1:3000\nwait-for #app\nread-dom #app\n' | \
  prism browser --headless --local-only --profile acceptance pipe
```

To install a helper before the application's own scripts:

```bash
prism browser \
  --headless \
  --local-only \
  --profile acceptance \
  --inject ./tests/browser-init.js \
  open http://127.0.0.1:3000
```

An injected file must be a regular, non-symlinked UTF-8 `.js` or `.mjs` file
no larger than 256 KiB. The audit log records its SHA-256 digest, not its path
or contents.

## Verified acceptance cases

The public test suite verifies that:

1. The npm allowlist contains the runner and the compiled CLI resolves it.
2. A named profile retains state across two separate Chromium launches.
3. Pipe commands share one live page session.
4. A preload helper is visible to the application's first page script.
5. A public subrequest and direct public navigation are blocked in
   `--local-only` mode.
6. Audit files use private permissions and omit tested URL secrets, PHI-like
   values, and injected source.
7. Missing Python/Playwright dependencies fail with an actionable error.

Run the focused contract with the repository watchdog:

```bash
MIN_FREE_GB=2 \
  /path/to/playwright-watchdog.sh \
  --exec npx vitest run tests/browser-cli.test.ts
```

The Synalux skill-routing tests separately verify that an authenticated paid
skill request can receive `local-browser`, while a free request does not. The
subscription controls skill delivery; the browser runtime still executes on
the user's machine.
