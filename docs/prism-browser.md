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
  which rejects public navigation, non-loopback subrequests, service workers,
  and WebSocket/EventSource/WebRTC egress.
- **Private audit records.** The runner stores a local audit trail with private
  filesystem permissions and removes URL credentials, query strings,
  fragments, common email/phone patterns, record identifiers in URL paths, and
  injected source text.
- **Failure signals instead of silence.** Console errors, uncaught page
  exceptions, and failed requests are captured and attached to command output.
  An HTTP status of 400 or higher, an empty screenshot frame, and a failed
  assertion each produce a non-zero exit.

These are orchestration and safety benefits. Prism Browser does not replace
Playwright Test: use raw Playwright when you need its complete fixture,
assertion, trace, project, or parallel-worker APIs. Compatibility patches are
best effort and are not a CAPTCHA-bypass guarantee.

## Assertions and exit codes

A command reports `status: "ok"` only when it actually succeeded. Anything else
(`failed`, `error`, `timeout`) marks the run, and `pipe` exits non-zero.

```bash
printf '%s\n' \
  'open http://127.0.0.1:3000' \
  'assert-title Dashboard' \
  'assert-text #status Ready' \
  'assert-count [data-row] 12' \
  'assert-no-page-errors' \
  | prism browser --headless --fast --fail-fast pipe
```

`eval` returns the native JSON value with its type, so results are machine
readable:

```json
{"status": "ok", "result": {"a": 1}, "type": "dict", "serializable": true}
```

`assert-eval` is the assertion form — `eval` alone never fails a run, because a
falsy expression is a legitimate result. Use `--fail-fast` for test runs so a
failed navigation cannot be followed by commands that silently target the
previous page.

A trailing backslash continues a command onto the next line, which makes
multi-line JavaScript and multi-line input text expressible. Quoted arguments
are parsed with shell-style quoting, so `type "div > .cell" "two words"` works.

## Hermetic runs

Persistent profiles are convenient for interactive work and wrong for tests:
state carries between runs and makes them order dependent. For test runs use

- `--ephemeral-profile` — a throwaway profile directory, removed on exit.
- `--storage-state PATH` — seed cookies and localStorage from a Playwright
  storage-state file, so authenticated flows skip the login UI.
- `save-storage PATH` — write the current state back out.
- `--fast` — skip the human-latency emulation (per-character typing and
  inter-action pauses), which otherwise dominates a test's wall clock.

`--trace PATH`, `--video DIR`, and `--har PATH` record Playwright artifacts for
a failing run.

## Phones and tablets

A desktop run never matches `(pointer: coarse)` and reads every
`env(safe-area-inset-*)` as 0, so CSS written for touchscreens, and layouts
that pad the iPhone status area and home indicator, cannot show up at a phone
size alone. Emulate the device instead:

- `--device NAME` — a measured iPhone or iPad in portrait: viewport, pixel
  ratio, touch, and safe area. `iphone-se`, `iphone-17`, `iphone-air`,
  `iphone-17-pro-max`, `ipad-a16`, `ipad-pro-13`. The values were read from a
  full-screen web view on iOS 26.5 simulators.
- `--touch` — a touchscreen: `(pointer: coarse)` and `(hover: none)` match,
  touch events exist, and the page's meta viewport is honoured.
- `--device-scale-factor N` — the device pixel ratio, for example `3`.
- `--safe-area T,R,B,L` — `env(safe-area-inset-*)` in CSS pixels, for example
  `62,0,34,0`. On iOS a page reads the insets only if its meta viewport sets
  `viewport-fit=cover`; without it an iPhone 17 reports 0. Chromium applies
  them either way, so check that your page sets it.

Flags given explicitly override the preset, so
`--device iphone-17 --viewport 874x402 --safe-area T,R,B,L` is the same phone
turned sideways. Landscape insets were not measured and are not part of the
presets: put the values your device reports in place of `T,R,B,L`, because
without `--safe-area` the portrait insets still apply. The engine stays
Chromium, and the user agent stays the desktop one, so pages that branch on the
user-agent string still take their desktop path.

```bash
printf '%s\n' \
  'open http://127.0.0.1:3000/app' \
  'assert-eval matchMedia("(pointer: coarse)").matches' \
  'screenshot phone.png' \
  | prism browser --headless --fast --ephemeral-profile --local-only --device iphone-17 pipe
```

## Multiple pages

A popup (OAuth, payment, print preview) opens a new page. `pages` lists them,
`switch-page N` makes one active, and `close-page` disposes of it. Without
switching, commands continue to target the original page.

## Fingerprint patches

`--stealth full` applies playwright-stealth, a CDP
`Emulation.setUserAgentOverride` carrying full `userAgentMetadata`, and a
supplementary init script. The CDP override is what keeps `navigator.userAgent`,
`navigator.userAgentData`, and the `Sec-CH-UA` request headers consistent;
rewriting headers through request interception does not work, because Chromium
re-adds client hints after interception.

Applied layers are verified rather than assumed. The runner probes the page for
UA/brand/platform/webdriver agreement at startup and again after the first real
navigation, and `--stealth full` fails with an actionable error when a requested
layer cannot be applied. Pass `--allow-degraded-stealth` to proceed anyway, or
`--stealth light` to skip the library layer deliberately. The `fingerprint`
command reports the current state.

These patches do not disable site isolation, client-side phishing detection, or
popup blocking. Profiles hold live authenticated cookies, and trading away those
mitigations for a fingerprint delta is the wrong exchange.

## Profile maintenance

Persistent profiles accumulate. `prism browser profiles` lists them by size and
age; `--prune-older-than DAYS` reports what is stale and deletes it only when
`--yes` is also passed.

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
