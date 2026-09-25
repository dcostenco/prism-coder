/**
 * Local-serving meter tests.
 *
 * The SQL is where this feature can go wrong in the expensive direction — by
 * counting something that saved nothing and reporting an inflated headline — so
 * these run against a REAL temp SQLite ledger via PRISM_INFER_LEDGER_DB_PATH
 * rather than a mock. A mocked aggregate would pass while the WHERE clause was
 * wrong, which is the only bug class that actually matters here.
 *
 * Deliberately absent: any test of a dollar figure. Prism reports tokens
 * because it cannot know host rates, which model a call displaced, or whether
 * the user is on a flat plan. `rendersNoCurrency` pins that as a contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendInferMetricBatch,
  queryLocalSavings,
  _resetInferLedgerForTest,
} from '../src/storage/inferMetricsLedger.js';
import {
  renderSavings,
  caveatsFor,
  abbreviate,
  windowStart,
  sessionSavings,
  type SavingsPeriod,
} from '../src/tools/savingsHandler.js';
import {
  recordInference,
  resetInferenceMetrics,
  getInferenceSnapshot,
} from '../src/utils/inferenceMetrics.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'savings-'));
  process.env.PRISM_INFER_LEDGER_DB_PATH = join(dir, 'test.db');
  _resetInferLedgerForTest();
  resetInferenceMetrics();
});

afterEach(async () => {
  delete process.env.PRISM_INFER_LEDGER_DB_PATH;
  _resetInferLedgerForTest();
  resetInferenceMetrics();
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // libsql-js#228 — see tests/infer-metrics-ledger.test.ts.
    if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '')) {
      throw error;
    }
  }
});

const local = (over: Record<string, unknown> = {}) => ({
  backend: 'ollama-9b', model: 'prism-coder:9b', used_cloud: false,
  prompt_tokens: 1_000, completion_tokens: 500, latency_ms: 900, ...over,
});

describe('queryLocalSavings — what counts as displaced', () => {
  it('sums prompt and completion tokens for locally-served calls', async () => {
    await appendInferMetricBatch([local(), local()]);
    const s = await queryLocalSavings();
    expect(s).not.toBeNull();
    expect(s!.local_calls).toBe(2);
    expect(s!.local_prompt_tokens).toBe(2_000);
    expect(s!.local_completion_tokens).toBe(1_000);
    expect(s!.local_total_tokens).toBe(3_000);
  });

  it('never counts cloud-served calls as savings', async () => {
    // A cloud fallback served the user from the cloud. It displaced nothing;
    // counting its tokens would invert the meaning of the headline.
    await appendInferMetricBatch([
      local(),
      { backend: 'cloud', model: 'synalux', used_cloud: true, prompt_tokens: 99_999, completion_tokens: 99_999 },
    ]);
    const s = await queryLocalSavings();
    expect(s!.local_total_tokens).toBe(1_500);
    expect(s!.cloud_calls).toBe(1);
    expect(s!.local_calls).toBe(1);
  });

  it('excludes refused calls — nothing was served, so nothing was displaced', async () => {
    // recordInference() writes the ledger row BEFORE its `backend === "refused"`
    // early return, so refusals are genuinely present in the table. If the SQL
    // forgets them, every refusal inflates the call count and (when tokens are
    // recorded) the token headline.
    await appendInferMetricBatch([
      local(),
      { backend: 'refused', model: null, used_cloud: false, prompt_tokens: 50_000, completion_tokens: 0 },
      { backend: 'ollama-9b', model: 'prism-coder:9b', used_cloud: false,
        gate_outcome: 'refused', prompt_tokens: 50_000, completion_tokens: 0 },
    ]);
    const s = await queryLocalSavings();
    expect(s!.local_calls).toBe(1);
    expect(s!.local_total_tokens).toBe(1_500);
    expect(s!.excluded_refusals).toBe(2);
  });

  it('keeps degraded-but-served calls — the user did get an answer', async () => {
    await appendInferMetricBatch([local({ gate_outcome: 'gate_failed_served' })]);
    const s = await queryLocalSavings();
    expect(s!.local_calls).toBe(1);
    expect(s!.excluded_refusals).toBe(0);
  });

  it('breaks down by model, local rows only', async () => {
    await appendInferMetricBatch([
      local({ model: 'prism-coder:9b' }),
      local({ model: 'prism-coder:4b', prompt_tokens: 10, completion_tokens: 20 }),
      { backend: 'cloud', model: 'prism-coder:9b', used_cloud: true, prompt_tokens: 77_777, completion_tokens: 1 },
    ]);
    const s = await queryLocalSavings();
    expect(s!.by_model['prism-coder:9b']).toEqual({ calls: 1, prompt_tokens: 1_000, completion_tokens: 500 });
    expect(s!.by_model['prism-coder:4b']).toEqual({ calls: 1, prompt_tokens: 10, completion_tokens: 20 });
  });

  it('honours the since-timestamp window', async () => {
    const now = Date.now();
    await appendInferMetricBatch([
      local({ ts: now - 60 * 86_400_000 }),   // 60 days ago
      local({ ts: now - 2 * 86_400_000 }),    // 2 days ago
    ]);
    const all = await queryLocalSavings();
    const month = await queryLocalSavings(windowStart('month', now));
    expect(all!.local_calls).toBe(2);
    expect(month!.local_calls).toBe(1);
  });

  it('discloses the VS Code panel share instead of folding it in silently', async () => {
    // Review O2: panel-playground rows ARE local serving, but "kept off your
    // cloud model" is a weaker claim for them, so the renderer must say what
    // share they are.
    await appendInferMetricBatch([
      local(),
      { ...local({ prompt_tokens: 300, completion_tokens: 100 }), caller: 'panel' },
    ]);
    const s = await queryLocalSavings();
    expect(s!.panel_local_calls).toBe(1);
    expect(s!.panel_local_tokens).toBe(400);
    const text = renderSavings(s!, 'all').text;
    expect(text).toMatch(/1 call\(s\) \(~400 tokens\) came from the VS Code panel playground/);
  });

  it('reports zero rather than throwing on an empty ledger', async () => {
    const s = await queryLocalSavings();
    expect(s!.local_calls).toBe(0);
    expect(s!.local_total_tokens).toBe(0);
    expect(s!.first_ts).toBeNull();
  });
});

describe('undercount honesty counters', () => {
  it('counts local rows carrying no token data at all', async () => {
    await appendInferMetricBatch([
      local(),
      { backend: 'ollama-9b', model: 'prism-coder:9b', used_cloud: false },
    ]);
    const s = await queryLocalSavings();
    expect(s!.local_calls).toBe(2);
    expect(s!.local_total_tokens).toBe(1_500);       // the untokened row adds nothing
    expect(s!.local_calls_without_tokens).toBe(1);   // ...and says so
    expect(caveatsFor(s!).join(' ')).toMatch(/real total is higher/i);
  });

  it('counts KV-cache hits, where Ollama reports 0 prompt tokens for real context', async () => {
    await appendInferMetricBatch([local({ prompt_tokens: 0, completion_tokens: 300 })]);
    const s = await queryLocalSavings();
    expect(s!.local_calls_with_cached_prompt).toBe(1);
    expect(caveatsFor(s!).join(' ')).toMatch(/undercounted/i);
  });

  it('emits no caveats when there is nothing to disclose', async () => {
    await appendInferMetricBatch([local()]);
    expect(caveatsFor((await queryLocalSavings())!)).toEqual([]);
  });
});

/**
 * The no-currency contract, shared so every rendered surface can assert it.
 *
 * Adversarial review C2 measured that the original two regexes passed
 * "≈4 dollars", "42 cents saved", "¥300", "0.42 EUR" — i.e. the guard only
 * killed the literal-$ mutant it was built against. This version covers
 * symbols, ISO codes, and spelled-out currency words, and the meta-test below
 * proves it against exactly those leaked shapes.
 */
function assertNoCurrency(text: string): void {
  expect(text).not.toMatch(/[$€£¥₹₩]/u);
  expect(text).not.toMatch(/\b(USD|EUR|GBP|JPY|CNY|INR|dollars?|euros?|pounds?|cents?|bucks?)\b/i);
  expect(text).not.toMatch(/\b(price|cost|money|saved you|per\s*Mtok|\d+(\.\d+)?\s*(k?usd|eur))\b/i);
}

describe('no-currency guard is not vacuous', () => {
  it('rejects every money-rendering shape the review measured as leaking', () => {
    for (const leak of [
      'saved you $4.20', '≈4 dollars', 'roughly 4 euros', '42 cents saved',
      '0.42 EUR', '0.42 GBP', '¥300', '₹30', 'price: 4.20', 'about 2 bucks',
      'cost equivalent 3.1', '$3.00/$15.00 per Mtok',
    ]) {
      expect(() => assertNoCurrency(`~510K tokens — ${leak}`), leak).toThrow();
    }
  });

  it('accepts the legitimate token vocabulary', () => {
    for (const ok of [
      '~510K tokens kept off your cloud model',
      '461,400 prompt + 48,400 completion',
      '53 call(s) served locally of 58 routed (91%)',
      'at most this much displacement, of at least this token volume',
    ]) {
      expect(() => assertNoCurrency(ok), ok).not.toThrow();
    }
  });
});

describe('rendering', () => {
  const render = async (period: SavingsPeriod = 'all') =>
    renderSavings((await queryLocalSavings())!, period).text;

  it('states both axes of the basis without contradicting itself', async () => {
    // Adversarial review C3: the first cut said "upper bound" three lines above
    // "the real total is higher" about the same number. The fix names the axes:
    // measured tokens are a floor; displacement is the upper-bound assumption.
    await appendInferMetricBatch([local()]);
    const text = await render();
    expect(text).toMatch(/token count is measured — a floor/i);
    expect(text).toMatch(/prism cannot observe the call your host would have made/i);
    expect(text).toMatch(/at most this much displacement, of at least this token volume/i);
    expect(text).not.toMatch(/upper bound on displacement/i); // the old unreconciled phrasing
  });

  it('reports tokens and never a currency figure', async () => {
    // The contract from the design decision: prism cannot know host rates,
    // which model a call displaced, or whether the user is on a flat plan, so
    // it must not render money. A future edit that adds "$" here is a
    // regression, not a feature.
    await appendInferMetricBatch([local({ prompt_tokens: 4_000_000, completion_tokens: 1_000_000 })]);
    const text = await render();
    expect(text).toMatch(/tokens kept off your cloud model/i);
    assertNoCurrency(text);
  });

  it('shows the local share of routed calls', async () => {
    await appendInferMetricBatch([
      local(), local(), local(),
      { backend: 'cloud', model: 'synalux', used_cloud: true, prompt_tokens: 1, completion_tokens: 1 },
    ]);
    expect(await render()).toMatch(/3 call\(s\) served locally of 4 routed \(75%\)/);
  });

  it('guides the user instead of showing a bare zero when nothing ran', async () => {
    const text = await render();
    expect(text).toMatch(/No calls served locally yet/i);
    expect(text).not.toMatch(/tokens kept off/i);
  });

  it('abbreviates large token counts without inventing precision', () => {
    expect(abbreviate(999)).toBe('999');
    expect(abbreviate(1_500)).toBe('1.5K');
    expect(abbreviate(4_200_000)).toBe('4.2M');
    expect(abbreviate(0)).toBe('0');
    // Review O1: rounding at a unit boundary must promote, never print "1000K".
    expect(abbreviate(999_999)).toBe('1.0M');
    expect(abbreviate(999_499)).toBe('999K');
    expect(abbreviate(1_000_000)).toBe('1.0M');
    expect(abbreviate(NaN)).toBe('0');
    expect(abbreviate(-5)).toBe('0');
    // Round-2 review: billion scale must not render "1000M".
    expect(abbreviate(999_999_999)).toBe('1.0B');
    expect(abbreviate(1_500_000_000)).toBe('1.5B');
    expect(abbreviate(999_499_000)).toBe('999M');
  });
});

describe('session view', () => {
  it('splits prompt/completion from local-only accumulators, not by subtraction', () => {
    // Regression guard. The first cut derived local prompt tokens as
    // cloudTokensSavedEst - totalCompletionTokens, but totalCompletionTokens
    // spans cloud calls too, so any cloud call corrupted the split. The cloud
    // call below has a large completion count precisely to catch that.
    recordInference({ backend: 'ollama-9b', model_picked: 'prism-coder:9b', used_cloud: false,
      latency_ms: 100, prompt_tokens: 1_000, completion_tokens: 200 });
    recordInference({ backend: 'cloud', model_picked: 'synalux', used_cloud: true,
      latency_ms: 100, prompt_tokens: 5_000, completion_tokens: 9_000 });

    const s = sessionSavings();
    expect(s.local_prompt_tokens).toBe(1_000);
    expect(s.local_completion_tokens).toBe(200);
    expect(s.local_total_tokens).toBe(1_200);
    expect(s.cloud_calls).toBe(1);
  });

  it('attributes per-model tokens to local serves only', () => {
    // Same model name on both sides is the case byModel cannot express.
    recordInference({ backend: 'ollama-9b', model_picked: 'shared-name', used_cloud: false,
      latency_ms: 10, prompt_tokens: 100, completion_tokens: 10 });
    recordInference({ backend: 'cloud', model_picked: 'shared-name', used_cloud: true,
      latency_ms: 10, prompt_tokens: 99_999, completion_tokens: 99_999 });

    const s = sessionSavings();
    expect(s.by_model['shared-name']).toEqual({ calls: 1, prompt_tokens: 100, completion_tokens: 10 });
    // The mixed map still holds both, which is why the meter does not read it.
    expect(getInferenceSnapshot().byModel['shared-name']!.calls).toBe(2);
  });

  it('marks the headline (est.) and discloses divergence when prompt tokens are estimated', () => {
    // Review C1 (HIGH): a KV-cache hit records prompt_tokens=0 but the session
    // view estimates the submitted prompt from its text, so the same call can
    // read >10x higher in 'session' than in 'month'/'all'. The first cut
    // hardcoded the session caveat counters to zero, so it structurally could
    // not disclose this. Now it must.
    recordInference({ backend: 'ollama-9b', model_picked: 'prism-coder:9b', used_cloud: false,
      latency_ms: 100, prompt_tokens: 0, completion_tokens: 300,
      prompt_text: 'x'.repeat(11_000) });

    const s = sessionSavings();
    expect(s.local_calls_with_estimated_prompt).toBe(1);
    expect(s.local_prompt_tokens).toBeGreaterThan(1_000); // the estimate, not the measured 0

    const text = renderSavings(s, 'session').text;
    expect(text).toMatch(/\(est\.\) tokens kept off your cloud model/);
    expect(text).toMatch(/ESTIMATED from prompt text rather than measured/);
    expect(text).toMatch(/can sit above or below the month\/all views/);
    // The measured-floor claim must NOT appear when the number is an estimate.
    expect(text).not.toMatch(/a floor/i);
    expect(text).toMatch(/of roughly this token volume/);
  });

  it('keeps the measured-floor wording when no session call was estimated', () => {
    recordInference({ backend: 'ollama-9b', model_picked: 'prism-coder:9b', used_cloud: false,
      latency_ms: 100, prompt_tokens: 800, completion_tokens: 200 });
    const s = sessionSavings();
    expect(s.local_calls_with_estimated_prompt).toBe(0);
    const text = renderSavings(s, 'session').text;
    expect(text).not.toMatch(/\(est\.\)/);
    expect(text).toMatch(/a floor/i);
  });

  it('counts session calls that recorded no tokens at all', () => {
    recordInference({ backend: 'ollama-9b', model_picked: 'prism-coder:9b', used_cloud: false,
      latency_ms: 100 });
    const s = sessionSavings();
    expect(s.local_calls_without_tokens).toBe(1);
    expect(s.local_total_tokens).toBe(0);
  });

  it('shows the real session span, never "no local calls yet" above real calls', () => {
    // Round-2 review: sessionSavings() hardcoded first_ts/last_ts to null, so
    // a populated session rendered "THIS SESSION (no local calls yet)" directly
    // above "2 call(s) served locally" — a visible self-contradiction.
    recordInference({ backend: 'ollama-9b', model_picked: 'prism-coder:9b', used_cloud: false,
      latency_ms: 100, prompt_tokens: 800, completion_tokens: 200 });
    const s = sessionSavings();
    expect(s.first_ts).not.toBeNull();
    const text = renderSavings(s, 'session').text;
    expect(text).not.toMatch(/no local calls yet/);
    expect(text).toMatch(/THIS SESSION \(\d{4}-\d{2}-\d{2}/);
  });

  it('excludes refusals from the session accumulators', () => {
    recordInference({ backend: 'refused', model_picked: null, used_cloud: false,
      latency_ms: 10, prompt_tokens: 50_000, completion_tokens: 0 });
    const s = sessionSavings();
    expect(s.local_calls).toBe(0);
    expect(s.local_total_tokens).toBe(0);
  });
});

describe('windowStart', () => {
  it('bounds week/month to trailing 7/30 days and leaves all/session unbounded', () => {
    const now = 1_800_000_000_000;
    expect(windowStart('week', now)).toBe(now - 7 * 86_400_000);
    expect(windowStart('month', now)).toBe(now - 30 * 86_400_000);
    expect(windowStart('all', now)).toBeUndefined();
    expect(windowStart('session', now)).toBeUndefined();
  });

  it('lets a custom day count override the named period', () => {
    const now = 1_800_000_000_000;
    expect(windowStart('all', now, 14)).toBe(now - 14 * 86_400_000);
    expect(windowStart('month', now, 3)).toBe(now - 3 * 86_400_000);
    // Nonsense day counts fall back to the named period, never a bad window.
    expect(windowStart('all', now, 0)).toBeUndefined();
    expect(windowStart('all', now, NaN)).toBeUndefined();
    expect(windowStart('month', now, -5)).toBe(now - 30 * 86_400_000);
  });

  it('filters and labels a weekly window end to end', async () => {
    const now = Date.now();
    await appendInferMetricBatch([
      local({ ts: now - 2 * 86_400_000 }),
      local({ ts: now - 10 * 86_400_000 }),  // inside month, outside week
    ]);
    const week = await queryLocalSavings(windowStart('week', now));
    expect(week!.local_calls).toBe(1);
    expect(renderSavings(week!, 'week').text).toMatch(/LAST 7 DAYS/);
    const custom = await queryLocalSavings(windowStart('all', now, 14));
    expect(custom!.local_calls).toBe(2);
    expect(renderSavings(custom!, 'all', 14).text).toMatch(/LAST 14 DAYS/);
  });
});

describe('follow-ups with the conversation (history_turns > 0)', () => {
  // Older rows carry no refusal_layer: omit the key rather than pass undefined.
  const refused = (layer: string | undefined, over: Record<string, unknown> = {}) => ({
    backend: 'refused', model: null, used_cloud: false, gate_outcome: 'refused',
    refusal_reason: 'layer1_reserved', history_turns: 2,
    ...(layer ? { refusal_layer: layer } : {}), ...over,
  });

  it('counts follow-ups answered locally, refused, and sent to cloud, and nothing else', async () => {
    await appendInferMetricBatch([
      local({ history_turns: 2 }),
      local({ history_turns: 4 }),
      local({ history_turns: 2, backend: 'ollama-4b', model: 'prism-coder:4b' }),
      local(), // single-turn: not a follow-up
      refused('prompt'), refused('prompt'), refused('isolated'), refused(undefined),
      refused('context', { history_turns: 0 }), // single-turn refusal: not a follow-up
      { backend: 'cloud', model: 'synalux', used_cloud: true, history_turns: 2, prompt_tokens: 10, completion_tokens: 10 },
    ]);
    const f = (await queryLocalSavings())!.followups!;
    expect(f.served_local).toBe(3);
    expect(f.served_local_9b).toBe(2);
    expect(f.refused).toBe(4);
    expect(f.cloud).toBe(1);
    expect(f.refused_by_layer).toEqual({ prompt: 2, isolated: 1, unrecorded: 1 });
  });

  it('respects the period window', async () => {
    await appendInferMetricBatch([local({ history_turns: 2 }), refused('context')]);
    const later = Date.now() + 60_000;
    const f = (await queryLocalSavings(later))!.followups!;
    expect([f.served_local, f.refused, f.cloud]).toEqual([0, 0, 0]);
  });

  it('renders the follow-up line with refusals by stage in plain words', async () => {
    await appendInferMetricBatch([
      local({ history_turns: 2 }), local({ history_turns: 2 }),
      refused('isolated'), refused('prompt'), refused('prompt'), refused('context'),
    ]);
    const text = renderSavings((await queryLocalSavings())!, 'all').text;
    expect(text).toContain('Follow-ups with your conversation:');
    expect(text).toContain('2 answered locally (2 by the 9b) · 4 refused by the on-device screen · 0 sent to cloud');
    expect(text).toContain('Refusals by stage: follow-up alone 2 · earlier turn alone 1 · turns together 1');
  });

  it('still shows refused follow-ups when nothing at all was served locally', async () => {
    await appendInferMetricBatch([refused('context'), refused('context')]);
    const text = renderSavings((await queryLocalSavings())!, 'all').text;
    expect(text).toContain('No calls served locally yet.');
    expect(text).toContain('0 answered locally · 2 refused by the on-device screen · 0 sent to cloud');
  });

  it('prints no follow-up block when no call carried history', async () => {
    await appendInferMetricBatch([local(), local()]);
    const text = renderSavings((await queryLocalSavings())!, 'all').text;
    expect(text).not.toContain('Follow-ups');
  });
});

describe('follow-ups: review fixes', () => {
  const refused = (over: Record<string, unknown>) => ({
    backend: 'refused', model: null, used_cloud: false, gate_outcome: 'refused', history_turns: 2, ...over,
  });

  it('counts plan refusals apart from the on-device screen, and keeps them out of the stage breakdown', async () => {
    await appendInferMetricBatch([
      refused({ refusal_reason: 'multi_turn_not_in_plan' }),
      refused({ refusal_reason: 'history_over_plan_cap' }),
      refused({ refusal_reason: 'layer1_reserved', refusal_layer: 'context' }),
    ]);
    const s = (await queryLocalSavings())!;
    expect(s.followups).toMatchObject({ refused: 1, refused_by_plan: 2 });
    expect(s.followups!.refused_by_layer).toEqual({ context: 1 });
    const text = renderSavings(s, 'all').text;
    expect(text).toContain('1 refused by the on-device screen');
    expect(text).toContain("2 refused by your plan's multi-turn limits");
  });

  it('counts a 9b by its tag, and never a 19b', async () => {
    await appendInferMetricBatch([
      local({ history_turns: 2, model: 'dcostenco/prism-coder:9b' }),
      local({ history_turns: 2, model: 'prism-coder:19b' }),
      local({ history_turns: 2, model: null, backend: 'ollama-9b' }),
    ]);
    const f = (await queryLocalSavings())!.followups!;
    expect(f.served_local).toBe(3);
    expect(f.served_local_9b).toBe(2);
  });

  it('names the screening-limit stage in plain words', async () => {
    await appendInferMetricBatch([refused({ refusal_reason: 'layer1_uncertain', refusal_layer: 'budget' })]);
    expect(renderSavings((await queryLocalSavings())!, 'all').text).toContain('Refusals by stage: screening limit 1');
  });
});

describe('follow-ups: every history row is counted exactly once', () => {
  it('a refusal with no recorded reason still counts as a screen refusal (NULL must not vanish)', async () => {
    await appendInferMetricBatch([
      local({ history_turns: 2 }),
      { backend: 'refused', model: null, used_cloud: false, gate_outcome: 'refused', history_turns: 2, refusal_layer: 'prompt' },
      { backend: 'refused', model: null, used_cloud: false, gate_outcome: 'refused', history_turns: 2, refusal_reason: 'multi_turn_not_in_plan' },
      { backend: 'cloud', model: 'synalux', used_cloud: true, history_turns: 2, prompt_tokens: 1, completion_tokens: 1 },
    ]);
    const f = (await queryLocalSavings())!.followups!;
    expect(f.refused).toBe(1);
    expect(f.refused_by_layer).toEqual({ prompt: 1 });
    expect(f.served_local + f.refused + f.refused_by_plan + f.cloud).toBe(4);
  });
});
