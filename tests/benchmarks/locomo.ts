import { getStorage } from "../../src/storage/index.js";
import { PRISM_USER_ID } from "../../src/config.js";
import { _setLLMProviderForTest } from "../../src/utils/llm/factory.js";
import { compactLedgerHandler } from "../../src/tools/compactionHandler.js";
import { knowledgeSearchHandler } from "../../src/tools/graphHandlers.js";
import type { LLMProvider } from "../../src/utils/llm/provider.js";

// Mock LLM provider for tests
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
     const embed = new Array(768).fill(0.01);
     // Slightly vary embedding depending on prompt so not all exact same
     embed[0] = text.length / 1000.0;
     return embed;
  }
}

async function runLoCoMoBenchmark() {
  console.log("Starting LoCoMo Benchmark...");
  
  // Set up mock provider
  _setLLMProviderForTest(new MockLLM());

  const storage = await getStorage();
  const PROJECT = "benchmark-locomo";

  // Clean old data to ensure pristine state
  try {
      await storage.deleteLedger({ project: `eq.${PROJECT}` });
  } catch (e) {
      // Ignore if doesn't exist
  }

  console.log("Inserting 55 entries to trigger compaction...");
  for (let i = 0; i < 55; i++) {
     await storage.saveLedger({
         project: PROJECT,
         user_id: PRISM_USER_ID,
         summary: `Session ${i}: investigated XYZ parameter. Result: XYZ should be ${i}.`,
         conversation_id: `convo-${i}`,
         session_date: new Date().toISOString()
     });
  }

  console.log("Running compaction...");
  const compactionRes = await compactLedgerHandler({ project: PROJECT, threshold: 50, keep_recent: 0 });
  console.log("Compaction completed:", compactionRes.content[0].text);

  console.log("Verifying semantic knowledge extraction...");
  
  // Test retrieval accuracy via multi-hop
  console.log("Running knowledge search...");
  const searchRes = await knowledgeSearchHandler({ query: "XYZ", project: PROJECT });
  
  if (searchRes.isError) {
      console.error("Benchmark failed during search:", searchRes);
      process.exit(1);
  }

  const resultText = searchRes.content?.[0] && 'text' in searchRes.content[0] ? searchRes.content[0].text : '';
  if (!resultText.includes("XYZ")) {
      console.error("Benchmark failed: retrieved knowledge did not contain 'XYZ'");
      console.error("Actual output:", JSON.stringify(searchRes, null, 2));
      process.exit(1);
  }
  
  console.log("LoCoMo Benchmark completed successfully.");
}

runLoCoMoBenchmark().then(() => {
  process.exit(0);
}).catch(err => {
  console.error("Benchmark failed with error:", err);
  process.exit(1);
});
