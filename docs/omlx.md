# Local coding with oMLX

Prism's **Auto** coding preference chooses configured oMLX for eligible text-only
coding drafts on Apple Silicon; otherwise it chooses Ollama. You can save a
different preference or override it for each task. The model runs locally;
the host still inspects the output and runs its own checks. Explicit oMLX calls
never substitute Ollama or cloud inference when admission or generation fails.

## Before installing

- Complete [Prism setup](../README.md#get-started),
  then use the [Prism integration of oMLX](https://github.com/dcostenco/omlx).
  Stock oMLX, including the upstream app and Homebrew package, does not supply
  the control routes this Prism path requires.
- The pinned integration below uses upstream **v0.7.1**. It requires Apple
  Silicon, macOS 15+, and Python 3.11–3.13. Full Xcode and its Metal toolchain
  are needed to build native kernels; Command Line Tools alone are insufficient.
- Allow storage for the drafting model, the required classifier, and caches.
  Model downloads, loaded memory, and cache space are different quantities.
  The classifier alone occupies about **9.2 GB while loaded**. The comparison
  below ran on a **48 GiB Apple M5 Max**; that is a tested machine, not a minimum
  hardware guarantee.
- Ollama does not need to be running for oMLX tasks. Prism observes its residency
  when available and refuses contention; it never starts Ollama or unloads
  another job's models to make room.

## Dashboard setup and backend preference

Open `prism dashboard`, then **Settings → Local Coding**. The panel provides:

- **Preferred coding backend:** Auto, oMLX, or Ollama. Auto prefers configured
  oMLX for text-only code calls with the top model ceiling. Explicit smaller
  ceilings stay on Ollama. Images and tool routing retain their supported path.
- **oMLX connection:** your existing server, or a separate Prism-managed install.
- **Coder and reviewer models:** independent selectors for oMLX and Ollama,
  populated automatically from the selected servers' installed inventories.
  The same model can serve both roles. Choose **Use backend default** to leave
  a role unassigned. Replacing a model version requires a new selection and save,
  with no code or skill edit.
- **Memory information:** reported weight size, loaded memory when available,
  a conservative cold-load estimate and current available RAM. Missing metadata
  stays unknown. Estimates do not guarantee peak fit; context, buffers and other
  jobs affect admission. Checking inventory does not load or download models.

Save the preference and use **Check saved connection** to check the saved
server, model advertisement, required classifier, and control-route availability.
Updated Prism processes read the versioned preference for each new task without
restarting. Older processes and rollback retain their previous legacy settings;
new saves do not overwrite those records. `PRISM_LOCAL_CODING_BACKEND=auto|omlx|ollama` overrides the saved
backend; an explicit task `local_backend` overrides both. A broken selected
oMLX configuration fails rather than silently substituting a backend.

Code requests use `local_role: "coder"` (the default) or `"reviewer"` to select
the saved model for the effective backend. Omitting the role defaults the model
lookup to coder while preserving legacy token/time budgets. An explicit role
defaults to 4,096 tokens/600 seconds on oMLX or 1,024 tokens/300 seconds on Ollama;
explicit budgets override these defaults. `local_model` overrides the role's
assignment on either backend. An explicit backend still uses its saved role
unless a model override is also supplied. Missing selected models are refused;
an inventory inspection failure means availability is unknown, not that a model
was removed. General inference, classifiers, embeddings and vision retain their
existing selection paths.

Selected Ollama models must report completion capability, parameter count and
the architecture metadata needed for memory estimates. Nominal parameter size
is rounded to billions for the plan/caller ceiling; complexity hints do not
override saved choices. The selected path pins context to at most 4,096 tokens
for generation and auxiliary calls. Unknown required metadata refuses admission
rather than falling back to a named tier. The ordinary unassigned tier walk
retains its existing behavior.

For a new installation, choose **Install oMLX + recommended models**. It requires
Apple Silicon, macOS 15+, Python 3.11–3.13, 32 GiB unified memory, and 40 GiB free
disk. This optional starter pack downloads about 25 GB and does not restrict
the installed models you can assign above. Review the linked model licenses
first. Installation is opt-in; npm postinstall never downloads these models.
Progress shows the current stage. **Retry / resume setup** resumes interrupted
downloads and skips completed runtime/model stages. Retry checks disk space for
the unfinished models plus a safety margin, so it can require less than the
initial 40 GiB.

The managed runtime and models live under `~/.prism-mcp/omlx/`, separate from
`~/.omlx/`. It pins the source/model revisions below, uses generic kernels,
loopback port 8001, a private API key, 32K context, 4K output, a 2K writer thinking
budget, chunked prefill, idle eviction, and a 10 GB SSD cache cap. Speculative
features stay disabled. After installation, select **Start managed oMLX**, then
choose **Prism-managed installation** and save. Existing servers remain running;
an occupied port is an error, not permission to stop its owner.

Terminal equivalents after installing Prism:

```bash
prism local status
prism local install
prism local start
prism local backend auto
# Or choose: prism local backend omlx / prism local backend ollama
```

Use the dashboard to choose the connection and model. Managed connection settings
ignore external `OMLX_*` overrides; those continue to apply to the existing-server
connection. The 27B ceiling must be permitted by both the task and plan. A model
advertisement or successful setup is not a coding-quality qualification.

The dashboard workflow is tested with controlled downloads/provider state. A
fresh-machine full download/install has not yet been qualified.

## Install and configure

For a new source installation, use an isolated Python environment:

```bash
git clone https://github.com/dcostenco/omlx.git
cd omlx
git checkout 8fd50b6a2515adba2f0a740600a7b9ac056077cd
python3.11 -m venv .venv
source .venv/bin/activate
make install PYTHON="$VIRTUAL_ENV/bin/python"
```

Without full Xcode, use `make install-no-kernels` instead of `make install`.
Some model families then use slower generic paths; do not compare that install's
speed directly with a kernel-enabled result. See the integration's
[installation notes](https://github.com/dcostenco/omlx/blob/8fd50b6a2515adba2f0a740600a7b9ac056077cd/README.md#from-source).

Download the required classifier and the tested dense drafting model. These
commands pin model revisions and use directory names matching the examples:

```bash
hf download dcostenco/prism-coder-9b-mlx-8bit \
  --revision 923f646aca17cfce6b96084ab1608e1c142655a1 \
  --local-dir "$HOME/.omlx/models/prism-coder-9b-mlx-8bit"
hf download Jundot/Qwen3.8-27B-oQ4e-mtp \
  --revision 49c1d60367d976a730a725ea3bbed32a8e94b878 \
  --local-dir "$HOME/.omlx/models/Qwen3.8-27B-oQ4e-mtp"
```

`hf` comes from the installation's `huggingface-hub` dependency. Review each
model's license and storage requirements on its model card before downloading.

Set `OMLX_API_KEY` in your terminal to the API key you want this server and
Prism to share, then start the server in that environment:

```bash
: "${OMLX_API_KEY:?Set OMLX_API_KEY to your oMLX API key first}"
omlx serve --model-dir "$HOME/.omlx/models" \
  --host 127.0.0.1 --port 8000 --api-key "$OMLX_API_KEY"
```

If oMLX is already serving, use its existing API key and model directory;
do not start a second server on the same port. **The `--api-key` option does not
save the key to `settings.json`.** Add the same `OMLX_API_KEY` to your host's
Prism MCP server environment, unless that key is already saved in oMLX's
`~/.omlx/settings.json` authentication settings. Prism prefers the environment
variable over the saved key, so remove or update a stale environment value.
A variable set in a terminal does not update an already-running desktop host;
reconnect its MCP server after changing the environment. At
`http://127.0.0.1:8000/admin`, configure the following before the first Prism call:

1. Enable **chunked prefill** (`scheduler.chunked_prefill: true` in
   `~/.omlx/settings.json`). Cancellation during prefill must be provable.
2. Set each model's context window explicitly (for example, 32,768 tokens).
   Prism reads
   `max_context_window` from `~/.omlx/model_settings.json` or the global
   sampling settings; an unknown window is refused.
3. Give the drafting model a thinking budget smaller than the total output
   budget. A 2,048-token thinking budget with a 4,096-token output cap was used
   in the comparison. This is an inference setting, not a quality guarantee.
4. Disable **MTP/VLM MTP, DFlash, and speculative prefill** for this pinned
   owned-job integration. The `-mtp` checkpoint suffix means prediction heads
   are included; it does not prove this execution path supports them. Unsupported
   variants are refused with `omlx_not_admitted`. oMLX may enable MTP
   automatically when discovering `-mtp` checkpoints; check the model settings
   after downloading them.
5. Keep normal memory guards and idle eviction enabled. Do not force the
   classifier and drafting model to remain resident together. Leave room for
   context/KV cache and other applications. For Flash-Next on this integration,
   the tested variant uses PLE SSD and expert offload with PLE gather-ahead off.

See the fork's [control-route and memory notes](https://github.com/dcostenco/omlx/blob/8fd50b6a2515adba2f0a740600a7b9ac056077cd/PRISM.md).
The upstream retry/resumed-prefill output-loss condition described there has
not been qualified as fixed by the stable upgrade.

## Verify the connection and first draft

With the server running, use a second terminal with the same API key:

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer $OMLX_API_KEY" \
  http://127.0.0.1:8000/v1/models
```

Confirm both `prism-coder-9b-mlx-8bit` and `Qwen3.8-27B-oQ4e-mtp` appear.
An OpenAI-compatible model listing alone does not prove the Prism control
routes work. From your connected host, ask it to call the **MCP tool**
`prism_infer` with these arguments (this is not a shell command):

```json
{
  "prompt": "Return only a Python function stable_unique(values: list[int]) -> list[int] that retains first-occurrence order, returns a fresh list, and does not mutate the input. Inputs are ordinary integers. No imports or I/O.",
  "mode": "code",
  "local_backend": "omlx",
  "local_model": "Qwen3.8-27B-oQ4e-mtp",
  "max_tokens": 4096,
  "timeout_ms": 180000,
  "cloud_fallback": false,
  "verify": false,
  "route_guard": "local",
  "escalation": "report"
}
```

The result must identify `backend: "omlx"`, the requested `model_picked`,
`used_cloud: false`, a successful `gate_outcome`, and nonempty code. Refused or
degraded output is not a successful draft. Inspect the code, then check that
`[3, 1, 3, 2, 1]` produces `[3, 1, 2]`, empty input returns a new empty list,
and the original list remains unchanged. A successful inference gate does not
mean the code passed those checks.

For a local advisory review, use the managed `prism-local-code` helper with a
saved or explicit installed reviewer model. Host reviewers are selected separately;
there is no automatic cloud fallback or automatic reviewer approval.

## Tested models and trade-offs

These are identified deployments, not a promise that every quantization or
oMLX-compatible model has been qualified through Prism. Use the exact model ID
advertised by your server; an oMLX model ID is not an Ollama tag.

| Model / weights | Role and benefit observed | Limits |
|---|---|---|
| [Prism 9B MLX 8-bit](https://huggingface.co/dcostenco/prism-coder-9b-mlx-8bit) | Required safety classifier for this path | Separate from the writer; about 9.2 GB loaded |
| [Jundot Qwen3.8-27B oQ4e](https://huggingface.co/Jundot/Qwen3.8-27B-oQ4e-mtp/tree/49c1d60367d976a730a725ea3bbed32a8e94b878) | Faster dense writer in this comparison; can also supply advisory review | Same-model writing/review is not independent assurance |
| [Jundot Flash-Next oQ4e](https://huggingface.co/Jundot/Qwen3.8-Flash-Next-oQ4e-mtp/tree/c4ddfb54a967a9bc74d7da16425f55f0872f8aac) | Found all ten faulty cases in the base review set | Slower reviews here; substantial weight/offload storage; retired from the local trial to reclaim space |
| [Flash-Next IQ3_S GGUF](https://huggingface.co/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF/tree/ed59f92082b1e93c0e96d60a8b11aab089b52f09/IQ3_S), [Strata](https://github.com/Niko1221/Strata) | Strong coding checks and faster review than Flash oQ4e in these runs | Separate experimental Metal runtime, **not** a native oMLX backend/model ID; requires its qualified trial adapter |

Strata is the serving engine; IQ3_S and oQ4e are different quantizations of
Flash-Next. Results used a **pinned, patched Strata Metal trial and its owned
adapter**, not the linked upstream repository as published. Prism's
`prism_infer` cannot select Strata. The separate trial does
not run Prism's classifier, entitlement, or output-policy ladder; it is not a
production Prism backend. Use its qualified owned adapter, not an unguarded HTTP
substitute, and retain host review of reserved work.
Downloading the GGUF does not make it an oMLX drafting model. Its
two IQ3_S shards total about 83.6 GB before the separate expert cache; the tested
installation did not save total disk space versus the oQ4e weights alone.

## Observed coding and review results

Internal results completed **2026-10-20**, on Apple M5 Max / 48 GiB. These are
small deployment comparisons, not independent benchmark rankings. **Both counts
and timings below come from controlled workers** that omit Prism's classifier,
entitlement, and output-policy ladder. They do not qualify native `prism_infer`
reliability. Timings are warm, serial request durations, not end-to-end MCP
latency or tokens/second.

An earlier native Prism/MCP integration cohort produced **10 usable reports
from 19 attempts**, including admission, classifier, and transport failures.
That cohort predates the current stable upgrade; the full cohort has not been
rerun against it. Successful individual smoke tests do not replace that missing
suite qualification.

| Coding deployment | First-draft checks | Source/boundary audit | Median initial request |
|---|---:|---:|---:|
| Qwen3.5-27B 4-bit, oMLX | 28/30 | 27/30 | 112.8 s |
| Qwen3.8-27B oQ4e, oMLX | 29/30 | 27/30 | 79.9 s |
| Flash-Next IQ3_S, Strata Metal trial | 30/30 | 29/30 | 110.8 s |

The Qwen3.5 score includes a disclosed, uniformly applied adapter correction.
The stricter audit includes synthetic runtime-boundary requirements, some also
missed by the legacy references. Qwen3.8's observed median was about 29% lower
than Qwen3.5's; the one-task check difference does not establish a broad
coding-quality upgrade. Strata led these checks but was slower than Qwen3.8.

| Advisory reviewer | Faulty cases found | Usable reports | Median attempt |
|---|---:|---:|---:|
| Qwen3.8-27B oQ4e | 9/10 | 19/20 | 75.5 s |
| Flash-Next oQ4e, oMLX | 10/10 | 20/20 | 204.4 s |
| Flash-Next IQ3_S, Strata | 9/10 | 18/20 | 97.3 s |

One ambiguous control was excluded uniformly from false-candidate comparisons.
On delivered unambiguous base controls, confirmed false candidates were one
for Qwen and zero for Flash/Strata. Qwen and Flash delivered nine such controls,
Strata eight; unusable reports remain failures.

On a separate blinded set of 16 saved drafts (15 distinct packets, only one
known defective draft), both Flash and Strata returned 15 usable reports.
Strata found the defect; Flash missed it. Confirmed false candidates were zero
for Strata and two for Flash. Strata's median was 103.7 seconds
versus Flash's 209.3 seconds. One confirmed Strata finding enabled one Qwen
repair; this is not a fresh end-to-end coder/reviewer benchmark or a universal
reviewer winner.

The tested patched Strata Metal build used argmax despite a requested temperature of
one, so identical repeat runs are not independent sampled evidence. Runtime,
model, quantization, decoding, cache, and background-work differences remain
confounded. Keep raw evaluation cases and outputs private. Choose per task,
retain host tests/review, and treat every local finding as advisory.

## Runtime behavior and failure handling

`prism_infer` uses the saved coding preference for unoverridden eligible code
calls. For an explicitly selected code or advisory reviewer draft, pass `local_backend: "omlx"`,
`mode: "code"`, and optionally `local_model` with the exact advertised model ID.
This path authenticates `/v1/models` before classification;
an unavailable, unauthenticated, or mismatched model refuses without substitution.
It reads `OMLX_API_KEY` or the local `~/.omlx/settings.json` key, and model/context
settings from `~/.omlx/model_settings.json`; `OMLX_MODEL` and a loopback-only
`OMLX_BASE_URL` can select local configuration. Redirects are refused.

**Requires** the [stable Prism integration of oMLX](https://github.com/dcostenco/omlx),
based on upstream `v0.7.1` with Prism's control routes
([pinned installation and settings](#install-and-configure)). With stock
oMLX every call is refused. Generation runs as an owned
job through those routes, so a timeout or cancel is reported only once the
server confirms the request stopped. An unconfirmed stop refuses later calls
(`omlx_stop_unproved`, `omlx_provider_busy`).

Before classification, Prism checks whether Ollama has resident models. It
refuses contention without unloading them. A positively closed local listener
is accepted as no running Ollama server; timeouts, malformed responses, and
other unknown state are refused. It never starts the Ollama daemon. An OS-owned loopback
lease on port 19438 excludes other candidate MCP processes; ordinary calls within
one process share this lease. A busy lease refuses (`omlx_resource_busy`) before
classification, and process exit releases it without lock-file
cleanup. In-process inference and classification wait while an oMLX call owns
the device. Unknown Ollama state, newly loaded Ollama weights, or available
memory below a 2 GiB reserve aborts/withholds the generation. Model caches and
daemons remain in place. Legacy/unmodified MCP processes do not honor the lease;
their contention is observed and rejected by the watcher.

**Safety screen.** The classifier on this path is the public
`dcostenco/prism-coder-9b-mlx-8bit`, installed under the name
`prism-coder-9b-mlx-8bit` in oMLX's model folder (about 9.2 GB while loaded).
Layer 1's rules only refuse here; the classifier reads everything else, and a
prompt over 4,000 characters is read whole in 3,600-character windows (the most
severe verdict stands), never as an excerpt. A classifier failure, an unreadable
answer, or a missing classifier refuses the call; there is no keyword or Ollama
fallback. Each classifier read is bounded by 90 seconds and by the call's
remaining `timeout_ms`, so a classifier that macOS paged out during a long idle
is waited for rather than refused, and an oversize prompt read in windows
cannot outlast the call budget; the first unrecoverable read ends the
classification.

Configured oMLX sampling and reasoning are preserved unless `temperature` or
`think` is explicit, including through repairs. Generic thinking-disable retries
are disabled for oMLX, so a model with no thinking budget in oMLX's model
settings can spend its whole answer reasoning and is refused `think_only`: give
it a budget there, or pass `think: false`. The legacy 300-second budget (600
seconds with an explicit `local_role`) bounds oMLX generation, repairs and
history answer checks; `timeout_ms` may override it
up to 900 seconds. Context sizing uses conservative UTF-8 bytes and the
configured window.

The same entitlement, reserved-content, history, quality, output-safety, and
verification policies apply. Explicit oMLX never falls back to Ollama/cloud
inference. `cloud_fallback: false`, `verify: false`, and `route_guard: "local"`
keep content-bearing cloud channels disabled for a local draft. Result metadata
reports `backend: "omlx"`, the selected model, tokens, and `gate_outcome`.
The MCP envelope carries this public metadata in `structuredContent` alongside
the existing human header/output text; `next_step` remains available in both.
Runtime authentication and internal verifier traces are excluded.
A draft is advisory and requires independent host review; it is not final sign-off.
