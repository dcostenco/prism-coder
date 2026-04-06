import 'dotenv/config';
import { getLLMProvider } from './src/utils/llm/factory.js';

async function run() {
  console.log("🚀 Initializing Provider...");
  
  // Set fake text provider if needed, or rely on .env
  const provider = getLLMProvider();
  
  console.log("\n📡 Sending test embedding to Voyage API (voyage-code-3)...");
  const startTime = Date.now();
  const vector = await provider.generateEmbedding("Testing Voyage AI Integration for Prism MCP Architecture.");
  const duration = Date.now() - startTime;
  
  console.log(`\n✅ Success!`);
  console.log(`📊 Vector Dimensions: ${vector.length}`);
  console.log(`⏱️ Latency: ${duration}ms`);
}

run().catch(console.error);
