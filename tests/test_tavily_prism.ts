import { runWebScholar } from '../src/scholar/webScholar.js';
import { debugLog } from '../src/utils/logger.js';

async function testPrismScholar() {
  console.log("🚀 Testing Prism Scholar Pipeline with Tavily...");
  
  const topic = "Neurological basis of tactile defensiveness in pediatric ASD";
  
  try {
    const result = await runWebScholar(topic, "test-project");
    
    console.log("\n--- PRISM SCHOLAR TEST RESULT ---");
    console.log(result.slice(0, 1000) + "...");
    console.log("\n✅ Success! Prism is now data-driven.");
  } catch (err) {
    console.error("❌ Prism Scholar Test Failed:", err);
  }
}

testPrismScholar();
