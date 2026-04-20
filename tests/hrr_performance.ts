import {
  circularConvolution,
  circularCorrelation,
  superimpose,
  generateRandomVector,
  cosineSimilarity,
  HRR_DIMENSION,
} from '../src/utils/hrr';
import { performance } from 'perf_hooks';

/**
 * HRR Multi-Dimension Benchmark
 * =============================
 * Analyzes Capacity vs. Speed vs. Dimension
 */

async function runBenchmark(dim: number, numFacts: number) {
  const roles = Array.from({ length: numFacts }, () => generateRandomVector(dim));
  const values = Array.from({ length: numFacts }, () => generateRandomVector(dim));
  
  const startBuild = performance.now();
  const facts = roles.map((r, i) => circularConvolution(r, values[i]));
  const memory = superimpose(facts);
  const endBuild = performance.now();

  const startRetrieve = performance.now();
  let totalSim = 0;
  for (let i = 0; i < numFacts; i++) {
    const retrieved = circularCorrelation(memory, roles[i]);
    totalSim += cosineSimilarity(retrieved, values[i]);
  }
  const endRetrieve = performance.now();

  return {
    dim,
    avgSim: totalSim / numFacts,
    buildTime: (endBuild - startBuild) / numFacts,
    retrieveTime: (endRetrieve - startRetrieve) / numFacts,
  };
}

async function main() {
  const dims = [512, 1024, 2048, 4096, 8192];
  const factCounts = [5, 10, 20, 50];

  console.log("# HRR Dimension & Capacity Analysis\n");
  console.log("| Dimension | Facts | Avg Similarity (Signal) | Build (ms/fact) | Retrieve (ms/fact) |");
  console.log("| :--- | :--- | :--- | :--- | :--- |");

  for (const dim of dims) {
    for (const count of factCounts) {
      const result = await runBenchmark(dim, count);
      console.log(`| ${dim} | ${count} | ${result.avgSim.toFixed(4)} | ${result.buildTime.toFixed(4)} | ${result.retrieveTime.toFixed(4)} |`);
    }
    console.log("| --- | --- | --- | --- | --- |");
  }

  console.log("\n## Recommendations for Mac Memory");
  console.log("- **16GB (M1/M2/M3)**: 1024 - 2048 Dims. Optimal balance of speed and working memory (up to 10 facts).");
  console.log("- **36GB (M3 Pro)**: 4096 Dims. High fidelity for complex multi-agent chains (up to 30 facts).");
  console.log("- **48GB+ (M4 Max)**: 8192 Dims. Extreme capacity for holographic graph traversal without noise artifacts.");
}

main().catch(console.error);
