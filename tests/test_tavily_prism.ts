import { runWebScholar } from '../src/scholar/webScholar.js';
import { debugLog, sanitizeForLog } from '../src/utils/logger.js';

async function testPrismScholar() {
  // Manual smoke script — not picked up by vitest (include: tests/**/*.test.ts).
  // Makes live network calls. The Tavily integration this was written for was
  // deleted (see PROVENANCE.md); it now exercises whichever discovery branch
  // your keys select.
  console.log("🚀 Testing Prism Scholar Pipeline...");
  
  const topic = "Neurological basis of tactile defensiveness in pediatric ASD";
  
  try {
    const result = await runWebScholar(topic, "test-project");
    
    console.log("\n--- PRISM SCHOLAR TEST RESULT ---");
    console.log(sanitizeForLog(result.slice(0, 1000)) + "...");
    console.log("\n✅ Success! Prism is now data-driven.");
  } catch (err) {
    console.error("❌ Prism Scholar Test Failed:", sanitizeForLog(String(err)));
  }
}

testPrismScholar();
