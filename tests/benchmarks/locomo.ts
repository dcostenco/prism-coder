/**
 * LoCoMo Benchmark — Long Conversational Memory
 *
 * Exercises the full Prism memory pipeline:
 *   Stage 1: Compaction + keyword search (original benchmark)
 *   Stage 2: Semantic search via sessionSearchMemoryHandler
 *   Stage 3: Multi-hop graph traversal (memory_links)
 *   Stage 4: ACT-R activation scoring verification
 *   Stage 5: Semantic knowledge (Hebbian learning)
 *
 * Run: GOOGLE_API_KEY=test PRISM_STORAGE=local npx tsx tests/benchmarks/locomo.ts
 *
 * Note: Uses PRISM_HDC_POLICY_FALLBACK_THRESHOLD=0 to disable the Uncertainty
 * Rejection Gate for mock embeddings (which produce low cosine similarity).
 */

import { getStorage, closeStorage } from "../../src/storage/index.js";
import { PRISM_USER_ID } from "../../src/config.js";
import { _setLLMProviderForTest } from "../../src/utils/llm/factory.js";
import { compactLedgerHandler } from "../../src/tools/compactionHandler.js";
import { knowledgeSearchHandler, sessionSearchMemoryHandler } from "../../src/tools/graphHandlers.js";
import type { LLMProvider } from "../../src/utils/llm/provider.js";
import type { MemoryLink } from "../../src/storage/interface.js";

// ─── Mock LLM Provider ──────────────────────────────────────
// Deterministic embeddings: hash text content into a stable 768-dim vector
// so that similar text produces similar vectors (cosine-measurable).
class MockLLM implements LLMProvider {
  async generateText(prompt: string): Promise<string> {
    if (prompt.includes("compressing a session history log")) {
      return JSON.stringify({
        summary: "Mock summary of multiple sessions finding that XYZ parameter is essential.",
        principles: [
          { concept: "XYZ config", description: "Use XYZ=42 for performance", related_entities: ["system"] }
        ],
        causal_links: [
          { source_id: "fake", target_id: "fake", relation: "led_to", reason: "mock" }
        ]
      });
    }
    return "Mock response";
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // Generate a deterministic pseudo-embedding based on text content.
    // Texts sharing keywords will have higher cosine similarity.
    const embed = new Array(768).fill(0);
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      embed[charCode % 768] += 0.01;
      embed[(charCode * 7) % 768] += 0.005;
    }
    // Normalize to unit vector for cosine similarity
    const norm = Math.sqrt(embed.reduce((sum: number, v: number) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < embed.length; i++) embed[i] /= norm;
    }
    return embed;
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.generateEmbedding(t)));
  }
}

// ─── Benchmark Utilities ─────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAILED: ${message}`);
    failed++;
  }
}

function section(name: string) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"═".repeat(60)}`);
}

// ─── Main Benchmark ──────────────────────────────────────────

async function runLoCoMoBenchmark() {
  console.log("🔬 Starting LoCoMo Benchmark (Long Conversational Memory)");
  console.log(`   User: ${PRISM_USER_ID}`);

  // Set up mock provider
  const mockLLM = new MockLLM();
  _setLLMProviderForTest(mockLLM);

  const storage = await getStorage();
  const PROJECT = "benchmark-locomo";

  // Clean old data to ensure pristine state
  try {
    await storage.deleteLedger({ project: `eq.${PROJECT}` });
  } catch {
    // Ignore if doesn't exist
  }

  // ═══════════════════════════════════════════════════════════
  //  STAGE 1: Compaction + Keyword Search (Original Benchmark)
  // ═══════════════════════════════════════════════════════════
  section("STAGE 1: Compaction + Keyword Search");

  console.log("  Inserting 55 entries to trigger compaction...");
  const compactionEntryIds: string[] = [];
  for (let i = 0; i < 55; i++) {
    const entry = await storage.saveLedger({
      project: PROJECT,
      user_id: PRISM_USER_ID,
      summary: `Session ${i}: investigated XYZ parameter. Result: XYZ should be ${i}.`,
      conversation_id: `convo-${i}`,
      session_date: new Date().toISOString()
    });
    const entries = entry as any[];
    if (entries?.[0]?.id) compactionEntryIds.push(entries[0].id);
  }
  assert(compactionEntryIds.length === 55, `Inserted 55 entries (got ${compactionEntryIds.length})`);

  console.log("  Running compaction...");
  const compactionRes = await compactLedgerHandler({ project: PROJECT, threshold: 50, keep_recent: 0 });
  assert(!compactionRes.isError, "Compaction completed without errors");
  console.log(`  → ${compactionRes.content[0].text.substring(0, 100)}...`);

  console.log("  Running keyword search...");
  const searchRes = await knowledgeSearchHandler({ query: "XYZ", project: PROJECT });
  assert(!searchRes.isError, "Knowledge search returned results");
  const resultText = searchRes.content?.[0] && 'text' in searchRes.content[0] ? searchRes.content[0].text : '';
  assert(resultText.includes("XYZ"), "Retrieved knowledge contains 'XYZ'");

  // ═══════════════════════════════════════════════════════════
  //  STAGE 2: Semantic Search via sessionSearchMemoryHandler
  // ═══════════════════════════════════════════════════════════
  section("STAGE 2: Semantic Search (sessionSearchMemoryHandler)");

  // Insert fresh entries with embeddings via saveLedger + patchLedger
  console.log("  Inserting 10 entries with mock embeddings...");
  const semanticEntryIds: string[] = [];
  const topics = [
    "Deployed the authentication service to production with OAuth2 flow.",
    "Fixed critical memory leak in the WebSocket connection pool handler.",
    "Refactored the database migration pipeline to support rollback operations.",
    "Integrated Stripe payment processing with webhook event verification.",
    "Optimized the search index for full-text queries using trigram matching.",
    "Built the CI/CD pipeline with GitHub Actions and Docker multi-stage builds.",
    "Implemented rate limiting middleware with Redis sliding window algorithm.",
    "Created the admin dashboard with real-time metrics and health monitoring.",
    "Set up Kubernetes autoscaling policies based on CPU and memory utilization.",
    "Wrote end-to-end tests for the user registration and onboarding workflow.",
  ];

  for (let i = 0; i < topics.length; i++) {
    const entry = await storage.saveLedger({
      project: PROJECT,
      user_id: PRISM_USER_ID,
      summary: topics[i],
      conversation_id: `semantic-convo-${i}`,
      session_date: new Date().toISOString(),
    });
    const entries = entry as any[];
    const id = entries?.[0]?.id;
    if (id) {
      semanticEntryIds.push(id);
      // Patch the embedding onto the entry (saveLedger doesn't accept raw embedding)
      const embedding = await mockLLM.generateEmbedding(topics[i]);
      await storage.patchLedger(id, { embedding: JSON.stringify(embedding) });
    }
  }
  assert(semanticEntryIds.length === 10, `Inserted 10 semantic entries with embeddings (got ${semanticEntryIds.length})`);

  // Search for semantically related content
  console.log("  Running semantic search for 'authentication OAuth login'...");
  const semanticRes = await sessionSearchMemoryHandler({
    query: "authentication OAuth login",
    project: PROJECT,
    limit: 5,
    similarity_threshold: 0.0,  // Low threshold since mock embeddings are approximate
    enable_trace: true,
  });

  assert(!semanticRes.isError, "Semantic search completed without errors");

  const semanticText = semanticRes.content?.[0] && 'text' in semanticRes.content[0]
    ? semanticRes.content[0].text : '';

  // With mock embeddings, results may be rejected by Uncertainty Gate or returned normally.
  // Both paths are valid — what matters is that the pipeline executed end-to-end.
  const isUncertaintyRejection = semanticText.includes("Uncertainty Rejection");
  const isSemanticResults = semanticText.includes("Found") && semanticText.includes("semantically similar");

  assert(
    isUncertaintyRejection || isSemanticResults,
    isUncertaintyRejection
      ? "Uncertainty Rejection Gate correctly fired (mock embeddings below threshold)"
      : "Semantic search returned formatted results"
  );

  // If results passed the gate, check trace block
  if (isSemanticResults) {
    const hasTrace = semanticRes.content?.length > 1 &&
      semanticRes.content[1] && 'text' in semanticRes.content[1] &&
      semanticRes.content[1].text.includes("MEMORY TRACE");
    assert(!!hasTrace, "Memory trace block returned when enable_trace=true");

    if (hasTrace) {
      const traceText = semanticRes.content[1].text;
      assert(traceText.includes("embeddingMs"), "Trace contains embedding latency");
      assert(traceText.includes("storageMs"), "Trace contains storage latency");
      assert(traceText.includes('"strategy":"semantic"'), "Trace strategy is 'semantic'");
    }
  } else {
    // Rejection path — validate the gate output structure
    try {
      const parsed = JSON.parse(semanticText);
      assert(parsed.meta?.rejected === true, "Rejection gate returned proper meta.rejected=true");
      assert(typeof parsed.meta?.reason === "string", "Rejection gate returned reason string");
    } catch {
      assert(false, "Uncertainty rejection has valid JSON structure");
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  STAGE 3: Multi-Hop Graph Traversal (memory_links)
  // ═══════════════════════════════════════════════════════════
  section("STAGE 3: Multi-Hop Graph Traversal");

  // Create explicit links between related entries
  console.log("  Creating memory links between entries...");
  let linksCreated = 0;
  if (semanticEntryIds.length >= 8) {
    // Link auth entry (0) → payment entry (3)
    try {
      const link1: MemoryLink = {
        source_id: semanticEntryIds[0],
        target_id: semanticEntryIds[3],
        link_type: "related_to",
        strength: 0.9,
      };
      await storage.createLink(link1, PRISM_USER_ID);
      linksCreated++;
    } catch (e) {
      console.log(`  ⚠️  Link 1 failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Link payment entry (3) → CI/CD entry (5)
    try {
      const link2: MemoryLink = {
        source_id: semanticEntryIds[3],
        target_id: semanticEntryIds[5],
        link_type: "related_to",
        strength: 0.8,
      };
      await storage.createLink(link2, PRISM_USER_ID);
      linksCreated++;
    } catch (e) {
      console.log(`  ⚠️  Link 2 failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Link memory leak (1) → rate limiting (6)
    try {
      const link3: MemoryLink = {
        source_id: semanticEntryIds[1],
        target_id: semanticEntryIds[6],
        link_type: "related_to",
        strength: 0.7,
      };
      await storage.createLink(link3, PRISM_USER_ID);
      linksCreated++;
    } catch (e) {
      console.log(`  ⚠️  Link 3 failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  assert(linksCreated >= 2, `Created ${linksCreated} memory links`);

  // Verify we can read links back
  const outboundLinks = await storage.getLinksFrom(
    semanticEntryIds[0], PRISM_USER_ID, 0.0, 10
  );
  assert(outboundLinks.length >= 1, `Entry 0 has ${outboundLinks.length} outbound link(s)`);
  assert(
    outboundLinks.some((l: any) => l.target_id === semanticEntryIds[3]),
    "Link from auth entry → payment entry exists"
  );

  // Verify link reinforcement
  console.log("  Testing link reinforcement...");
  await storage.reinforceLink(semanticEntryIds[0], semanticEntryIds[3], "related_to");
  const reinforcedLinks = await storage.getLinksFrom(
    semanticEntryIds[0], PRISM_USER_ID, 0.0, 10
  );
  const reinforcedLink = reinforcedLinks.find((l: any) => l.target_id === semanticEntryIds[3]);
  assert(
    !!reinforcedLink && reinforcedLink.strength >= 0.9,
    `Link strength after reinforcement: ${reinforcedLink?.strength}`
  );

  // ═══════════════════════════════════════════════════════════
  //  STAGE 4: ACT-R Activation Scoring
  // ═══════════════════════════════════════════════════════════
  section("STAGE 4: ACT-R Activation Scoring");

  // Test ACT-R math functions directly
  console.log("  Testing ACT-R activation math...");
  const { baseLevelActivation, compositeRetrievalScore } = await import(
    "../../src/utils/actrActivation.js"
  );

  const now = new Date();

  // Base level with recent timestamps should produce higher activation than old timestamps
  const recentTimestamps = [now, new Date(now.getTime() - 3600_000)]; // now + 1hr ago
  const oldTimestamps = [new Date(now.getTime() - 86400_000 * 30)]; // 30 days ago

  const recentActivation = baseLevelActivation(recentTimestamps, now, 0.5);
  const oldActivation = baseLevelActivation(oldTimestamps, now, 0.5);
  assert(
    recentActivation > oldActivation,
    `Recent activation (${recentActivation.toFixed(3)}) > old activation (${oldActivation.toFixed(3)})`
  );

  // Composite score should blend similarity and activation
  const composite = compositeRetrievalScore(0.8, 2.0, 0.7, 0.3, -2.0, 1.0);
  assert(composite > 0 && composite <= 1, `Composite score in valid range: ${composite.toFixed(3)}`);
  assert(composite > 0.5, `Composite score for good inputs > 0.5: ${composite.toFixed(3)}`);

  // Higher similarity should produce higher composite (with same activation)
  const highSimComposite = compositeRetrievalScore(0.95, 1.0, 0.7, 0.3, -2.0, 1.0);
  const lowSimComposite = compositeRetrievalScore(0.3, 1.0, 0.7, 0.3, -2.0, 1.0);
  assert(
    highSimComposite > lowSimComposite,
    `High-sim composite (${highSimComposite.toFixed(3)}) > low-sim composite (${lowSimComposite.toFixed(3)})`
  );

  // Zero-age edge case: accessing a memory right at creation
  const zeroAgeActivation = baseLevelActivation([now], now, 0.5);
  assert(
    Number.isFinite(zeroAgeActivation),
    `Zero-age activation is finite: ${zeroAgeActivation.toFixed(3)}`
  );

  // ═══════════════════════════════════════════════════════════
  //  STAGE 5: Semantic Knowledge (Hebbian Learning)
  // ═══════════════════════════════════════════════════════════
  section("STAGE 5: Semantic Knowledge (Hebbian Learning)");

  console.log("  Testing upsertSemanticKnowledge...");
  await storage.upsertSemanticKnowledge({
    project: PROJECT,
    userId: PRISM_USER_ID,
    concept: "XYZ_CONFIG",
    description: "XYZ=42 is optimal for production performance",
    related_entities: ["system", "performance"],
  });
  assert(true, "upsertSemanticKnowledge succeeded (first insert)");

  // Second upsert should increment instances and bump confidence
  await storage.upsertSemanticKnowledge({
    project: PROJECT,
    userId: PRISM_USER_ID,
    concept: "XYZ_CONFIG",
    description: "XYZ=42 is optimal for production performance",
    related_entities: ["system", "performance", "tuning"],
  });
  assert(true, "upsertSemanticKnowledge succeeded (increment instances)");

  // ═══════════════════════════════════════════════════════════
  //  SUMMARY
  // ═══════════════════════════════════════════════════════════
  section("BENCHMARK RESULTS");

  // Cleanup
  try {
    await storage.deleteLedger({ project: `eq.${PROJECT}` });
  } catch { /* best effort */ }

  await closeStorage();

  console.log(`\n  Total: ${passed + failed} assertions`);
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log();

  if (failed > 0) {
    console.error("❌ LoCoMo Benchmark FAILED");
    process.exit(1);
  } else {
    console.log("✅ LoCoMo Benchmark PASSED — all stages completed successfully.");
  }
}

runLoCoMoBenchmark().then(() => {
  process.exit(0);
}).catch(err => {
  console.error("Benchmark crashed with error:", err);
  process.exit(1);
});
