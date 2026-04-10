/**
 * Large-Scale Residual Distribution Benchmark
 * ═══════════════════════════════════════════════════════════════
 *
 * Produces publishable residual norm distribution stats at production
 * scale (d=768, N=1M) to back the LongMemEval #31 claim.
 *
 * DESIGN:
 *   - Phase 1: Compress 1M vectors at d=768, recording only residualNorms
 *     (streams — doesn't hold all vectors in memory simultaneously)
 *   - Phase 2: Distribution characterization (percentiles, CV, tail ratio)
 *   - Phase 3: R@k impact at N=10K and N=50K subsets
 *
 * HARDWARE: Designed for M4 Max 36GB. Peak ~6GB V8 heap.
 *
 * Run:
 *   npx tsx --max-old-space-size=16384 tests/benchmarks/residual-1m.ts
 *
 * Expected duration: ~20-30 minutes
 */

import {
  TurboQuantCompressor,
  PRISM_DEFAULT_CONFIG,
  type CompressedEmbedding,
} from "../../src/utils/turboquant.js";

// ─── Helpers ─────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianRandom(rng: () => number): number {
  const u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1 + 1e-15)) * Math.cos(2 * Math.PI * u2);
}

function randomUnitVector(d: number, rng: () => number): number[] {
  const v = Array.from({ length: d }, () => gaussianRandom(rng));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mean(arr: number[]): number {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function stddev(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ─── Configuration ───────────────────────────────────────────────

const CORPUS_SIZE = 1_000_000;
const D = 768;
const BATCH_SIZE = 10_000;     // Compress in batches, GC between
const PROGRESS_INTERVAL = 50_000;
const RAK_CORPUS_SIZES = [1_000, 10_000, 50_000];
const RAK_TRIALS = 30;

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Prism TurboQuant — 1M Vector Residual Distribution     ║");
  console.log("║  d=768, 4-bit, Householder + QJL                       ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Corpus:  ${formatNumber(CORPUS_SIZE)} vectors                               ║`);
  console.log(`║  Machine: M4 Max, 36GB unified memory                  ║`);
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const totalStart = Date.now();

  // ─── Phase 1: Compress 1M vectors, collect residualNorms ───────
  console.log("━━━ Phase 1: Compressing 1M vectors (d=768) ━━━\n");

  const compressor = new TurboQuantCompressor(PRISM_DEFAULT_CONFIG);
  const rng = mulberry32(2026);
  const residualNorms = new Float64Array(CORPUS_SIZE);

  const phase1Start = Date.now();
  let lastProgress = Date.now();

  for (let batch = 0; batch < CORPUS_SIZE; batch += BATCH_SIZE) {
    const batchEnd = Math.min(batch + BATCH_SIZE, CORPUS_SIZE);

    for (let i = batch; i < batchEnd; i++) {
      const vec = randomUnitVector(D, rng);
      const compressed = compressor.compress(vec);
      residualNorms[i] = compressed.residualNorm;
    }

    // Progress reporting
    if (batchEnd % PROGRESS_INTERVAL === 0 || batchEnd === CORPUS_SIZE) {
      const elapsed = Date.now() - phase1Start;
      const rate = batchEnd / (elapsed / 1000);
      const eta = (CORPUS_SIZE - batchEnd) / rate;
      const pct = ((batchEnd / CORPUS_SIZE) * 100).toFixed(1);
      const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
      console.log(
        `  [${pct}%] ${formatNumber(batchEnd)} vectors | ` +
        `${rate.toFixed(0)} vec/s | ETA ${formatDuration(eta * 1000)} | ` +
        `Heap: ${mem}MB`
      );
    }
  }

  const phase1Time = Date.now() - phase1Start;
  console.log(`\n  ✓ Phase 1 complete in ${formatDuration(phase1Time)}\n`);

  // ─── Phase 2: Distribution Characterization ────────────────────
  console.log("━━━ Phase 2: Distribution Analysis ━━━\n");

  // Sort a copy for percentile calculations
  const sorted = Array.from(residualNorms).sort((a, b) => a - b);

  const mu = mean(sorted);
  const sigma = stddev(sorted);
  const cv = sigma / mu;
  const p1 = percentile(sorted, 1);
  const p5 = percentile(sorted, 5);
  const p10 = percentile(sorted, 10);
  const p25 = percentile(sorted, 25);
  const p50 = percentile(sorted, 50);
  const p75 = percentile(sorted, 75);
  const p90 = percentile(sorted, 90);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  const p999 = percentile(sorted, 99.9);
  const minVal = sorted[0];
  const maxVal = sorted[sorted.length - 1];

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Residual Norm Distribution (d=768, 4-bit, N=1M)        ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Count:    ${formatNumber(CORPUS_SIZE).padEnd(12)}                             ║`);
  console.log(`║  Mean:     ${mu.toFixed(6).padEnd(12)}                             ║`);
  console.log(`║  StdDev:   ${sigma.toFixed(6).padEnd(12)}                             ║`);
  console.log(`║  CV:       ${cv.toFixed(4).padEnd(12)}                             ║`);
  console.log(`║  Min:      ${minVal.toFixed(6).padEnd(12)}                             ║`);
  console.log(`║  Max:      ${maxVal.toFixed(6).padEnd(12)}                             ║`);
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log("║  Percentile Distribution:                               ║");
  console.log(`║    P1:     ${p1.toFixed(6).padEnd(12)}                             ║`);
  console.log(`║    P5:     ${p5.toFixed(6).padEnd(12)}                             ║`);
  console.log(`║    P10:    ${p10.toFixed(6).padEnd(12)}                             ║`);
  console.log(`║    P25:    ${p25.toFixed(6).padEnd(12)}                             ║`);
  console.log(`║    P50:    ${p50.toFixed(6).padEnd(12)}                             ║`);
  console.log(`║    P75:    ${p75.toFixed(6).padEnd(12)}                             ║`);
  console.log(`║    P90:    ${p90.toFixed(6).padEnd(12)}                             ║`);
  console.log(`║    P95:    ${p95.toFixed(6).padEnd(12)}                             ║`);
  console.log(`║    P99:    ${p99.toFixed(6).padEnd(12)}                             ║`);
  console.log(`║    P99.9:  ${p999.toFixed(6).padEnd(12)}                             ║`);
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log("║  Tail Ratios:                                           ║");
  console.log(`║    P99/P50:    ${(p99 / p50).toFixed(4).padEnd(10)}                           ║`);
  console.log(`║    P99.9/P50:  ${(p999 / p50).toFixed(4).padEnd(10)}                           ║`);
  console.log(`║    Max/Min:    ${(maxVal / minVal).toFixed(4).padEnd(10)}                           ║`);
  console.log(`║    IQR:        ${(p75 - p25).toFixed(6).padEnd(10)}                           ║`);
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // ─── Phase 3: R@k by Residual Bucket ───────────────────────────
  console.log("━━━ Phase 3: R@k by Residual Bucket ━━━\n");

  // We need actual vectors + compressed for R@k tests, so we regenerate
  // smaller subsets. Can't hold 1M × 768 in memory.
  for (const corpusSize of RAK_CORPUS_SIZES) {
    console.log(`  Testing R@k at N=${formatNumber(corpusSize)}...`);
    const rakStart = Date.now();
    const rakRng = mulberry32(42);

    // Generate corpus
    const vectors: number[][] = [];
    const compressed: CompressedEmbedding[] = [];
    const norms: number[] = [];

    for (let i = 0; i < corpusSize; i++) {
      const vec = randomUnitVector(D, rakRng);
      vectors.push(vec);
      const c = compressor.compress(vec);
      compressed.push(c);
      norms.push(c.residualNorm);
    }

    // Split into buckets by residualNorm
    const sortedNorms = [...norms].sort((a, b) => a - b);
    const p50Thresh = percentile(sortedNorms, 50);
    const p95Thresh = percentile(sortedNorms, 95);

    const lowIndices = norms.map((n, i) => ({ n, i })).filter(x => x.n < p50Thresh).map(x => x.i);
    const highIndices = norms.map((n, i) => ({ n, i })).filter(x => x.n >= p95Thresh).map(x => x.i);

    // R@k tests
    let lowR1 = 0, lowR5 = 0, highR1 = 0, highR5 = 0;
    let globalR1 = 0, globalR5 = 0;

    for (let trial = 0; trial < RAK_TRIALS; trial++) {
      const query = randomUnitVector(D, rakRng);

      // Global R@k (full corpus)
      let trueMaxSim = -Infinity, trueMaxIdx = -1;
      for (let i = 0; i < corpusSize; i++) {
        const sim = cosineSim(query, vectors[i]);
        if (sim > trueMaxSim) { trueMaxSim = sim; trueMaxIdx = i; }
      }
      const allSims = compressed.map((c, i) => ({
        idx: i,
        sim: compressor.asymmetricCosineSimilarity(query, c),
      }));
      allSims.sort((a, b) => b.sim - a.sim);
      if (allSims[0].idx === trueMaxIdx) globalR1++;
      if (allSims.slice(0, 5).some(s => s.idx === trueMaxIdx)) globalR5++;

      // Low-residual bucket
      let trueMaxLow = -Infinity, trueMaxIdxLow = -1;
      for (const idx of lowIndices) {
        const sim = cosineSim(query, vectors[idx]);
        if (sim > trueMaxLow) { trueMaxLow = sim; trueMaxIdxLow = idx; }
      }
      const lowSims = lowIndices.map(idx => ({
        idx, sim: compressor.asymmetricCosineSimilarity(query, compressed[idx]),
      }));
      lowSims.sort((a, b) => b.sim - a.sim);
      if (lowSims[0].idx === trueMaxIdxLow) lowR1++;
      if (lowSims.slice(0, 5).some(s => s.idx === trueMaxIdxLow)) lowR5++;

      // High-residual bucket
      let trueMaxHigh = -Infinity, trueMaxIdxHigh = -1;
      for (const idx of highIndices) {
        const sim = cosineSim(query, vectors[idx]);
        if (sim > trueMaxHigh) { trueMaxHigh = sim; trueMaxIdxHigh = idx; }
      }
      const highSims = highIndices.map(idx => ({
        idx, sim: compressor.asymmetricCosineSimilarity(query, compressed[idx]),
      }));
      highSims.sort((a, b) => b.sim - a.sim);
      if (highSims[0].idx === trueMaxIdxHigh) highR1++;
      if (highSims.slice(0, 5).some(s => s.idx === trueMaxIdxHigh)) highR5++;
    }

    const rakTime = Date.now() - rakStart;

    console.log(`\n  ╔════════════════════════════════════════════════════╗`);
    console.log(`  ║  R@k Results — N=${formatNumber(corpusSize).padEnd(6)} d=768, 4-bit (${RAK_TRIALS} trials)  ║`);
    console.log(`  ╠════════════════════════════════════════════════════╣`);
    console.log(`  ║  Global (full corpus):                              ║`);
    console.log(`  ║    R@1 = ${((globalR1/RAK_TRIALS)*100).toFixed(1).padEnd(6)}%    R@5 = ${((globalR5/RAK_TRIALS)*100).toFixed(1).padEnd(6)}%          ║`);
    console.log(`  ║  Low residual (<P50):                               ║`);
    console.log(`  ║    R@1 = ${((lowR1/RAK_TRIALS)*100).toFixed(1).padEnd(6)}%    R@5 = ${((lowR5/RAK_TRIALS)*100).toFixed(1).padEnd(6)}%          ║`);
    console.log(`  ║  High residual (>P95):                              ║`);
    console.log(`  ║    R@1 = ${((highR1/RAK_TRIALS)*100).toFixed(1).padEnd(6)}%    R@5 = ${((highR5/RAK_TRIALS)*100).toFixed(1).padEnd(6)}%          ║`);
    console.log(`  ║  Delta R@5 (low-high): ${(((lowR5-highR5)/RAK_TRIALS)*100).toFixed(1).padEnd(6)} pp                  ║`);
    console.log(`  ║  Time: ${formatDuration(rakTime).padEnd(8)}                                  ║`);
    console.log(`  ╚════════════════════════════════════════════════════╝\n`);

    // Free memory before next size
    vectors.length = 0;
    compressed.length = 0;
    norms.length = 0;
  }

  // ─── Summary ───────────────────────────────────────────────────
  const totalTime = Date.now() - totalStart;
  const heapMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);

  console.log("━━━ Summary ━━━\n");
  console.log(`  Total time:       ${formatDuration(totalTime)}`);
  console.log(`  Peak heap:        ${heapMB} MB`);
  console.log(`  Vectors analyzed: ${formatNumber(CORPUS_SIZE)}`);
  console.log(`  CV:               ${cv.toFixed(4)}`);
  console.log(`  P99/P50 ratio:    ${(p99 / p50).toFixed(4)}`);
  console.log(`\n  Ready to post to LongMemEval #31 ✓\n`);
}

main().catch(console.error);
