# Discovery channels — state and actions

Verified 2026-08-06. Baseline to measure against: **npm 1,762 downloads/week**
(2026-07-30 → 2026-08-05, api.npmjs.org).

The canonical one-line description (keep every surface consistent with this):

> Persistent session memory for AI coding agents — local-first, with on-device
> inference, associative recall, and drift detection. Works with Claude Code,
> Cursor, and Codex.

| Channel | State (verified) | Action |
|---|---|---|
| npm (`prism-mcp-server`) | ✅ published; keywords were 62 (spam signal), description was jargon | Fixed in this PR (12 keywords, plain description) |
| MCP Registry (`io.github.dcostenco/prism-coder`) | ✅ listed, but search is **name-only** — `memory` returns 0 hits | Description fixed here for downstream full-text indexes; registry search itself can't be fixed without a rename (breaks the pin — don't) |
| GitHub repo desc/topics | was jargon ("Hivemind, LLM fleet") | ✅ updated live 2026-08-06 via `gh repo edit` |
| Glama | schema allows `maintainers` only; listing derives from GitHub repo desc | Covered by the repo-description fix; verify listing after next crawl |
| Smithery | ❌ absent (`prism-coder`/`dcostenco` → 0; the listed "PRISM" is philongevity's, unrelated) | Submit at smithery.ai (account-bound — owner action) |
| `punkpeye/awesome-mcp-servers` (~60k★) | ⚠️ was stale (dead repo link, wrong-product badge) | ✅ update PR filed: [punkpeye#11632](https://github.com/punkpeye/awesome-mcp-servers/pull/11632) |
| `wong2/awesome-mcp-servers` | ❌ absent; **does not accept PRs** — submissions via the mcpservers.org/submit web form | Owner action: submit the canonical line via the form |
| mcp.so / PulseMCP | unverified | Check; submit only if registry syndication hasn't carried it |
| `.well-known/mcp.json` | **not a real discovery spec** — verified against MCP docs | No action; do not invent the file |
| Codex | no third-party directory exists (`openai/plugins` = examples only) | Hand out the two-liner (README/npm/site):<br>`codex plugin marketplace add dcostenco/prism-coder`<br>`codex plugin add synalux-prism@prism` |
| Claude community marketplace | submitted, pending review; published listing snapshots the **form text** (measured: 4/5 approved plugins differ from repo at pinned SHA) | If listing shows old copy post-approval, amend via plugin review out-of-band |

## Paste-ready: `punkpeye/awesome-mcp-servers` (UPDATE the existing line)

Replace the existing `dcostenco/prism-mcp` line with:

```markdown
- [dcostenco/prism-coder](https://github.com/dcostenco/prism-coder) 📇 🏠 🍎 🪟 🐧 - Persistent session memory for AI coding agents — local-first, with on-device inference, associative recall, and drift detection. Works with Claude Code, Cursor, and Codex.
```

PR note: "Updates a stale entry: repo moved to prism-coder; the old line's Glama
badge pointed at a different server (dcostenco/BCBA)."

## Paste-ready: mcpservers.org/submit (covers wong2's list)

Use the canonical description above; repo URL `https://github.com/dcostenco/prism-coder`.

## Paste-ready: amendment to Claude plugin review (submission shows old copy)

The pending `claude-community` submission snapshots the form text, so the
listing will publish with the pre-#128 description unless amended. Send via
the submission confirmation email / plugin-review channel:

> Subject: synalux-prism (pending review) — updated description
>
> While our submission for `synalux-prism` (repo
> `dcostenco/prism-coder`, path `plugins/prism`) is pending review, we
> refreshed the plugin description in the repo's `.claude-plugin/plugin.json`.
> If the published listing uses the form text rather than the manifest, please
> use the manifest description (current on `main`). No other change — same
> slug, same repo, same path. Thanks!

## Measurement

Re-check ~2 weeks after the external listings land:
- npm weekly downloads vs the 1,762 baseline
- Glama/Smithery full-text search for "session memory" surfaces Prism
- GitHub repo traffic (`gh api repos/dcostenco/prism-coder/traffic/views`)
