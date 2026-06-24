import { getStorage } from "../../src/storage/index.js";
import { PRISM_USER_ID } from "../../src/config.js";
import { sessionSearchMemoryHandler } from "../../src/tools/graphHandlers.js";
import { sessionSaveLedgerHandler } from "../../src/tools/ledgerHandlers.js";
import { getLLMProvider } from "../../src/utils/llm/factory.js";
import { sanitizeForLog } from "../../src/utils/logger.js";
import { stdin } from "node:process";

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stdin.setEncoding("utf-8");
    stdin.on("data", chunk => { data += chunk; });
    stdin.on("end", () => resolve(data));
    stdin.on("error", err => reject(err));
  });
}

async function run() {
  const inputData = await readStdin();
  const sample = JSON.parse(inputData);
  
  const evidence = sample.evidence || "";
  const trigger = sample.trigger || sample.question_input || "";
  const PROJECT = "locomo-plus-eval";

  const storage = await getStorage();
  
  // 1. Clear database
  try {
      await storage.deleteLedger({ project: `eq.${PROJECT}` });
  } catch (e) {}

  // 2. Inject evidence and embedding into memory synchronously
  const result = await storage.saveLedger({
      project: PROJECT,
      conversation_id: "locomo-1",
      summary: evidence,
      user_id: PRISM_USER_ID,
      todos: [],
      files_changed: [],
      decisions: [],
      keywords: [],
      role: "global",
  });

  const savedEntry = Array.isArray(result) ? result[0] : result;
  const entryId = (savedEntry as any)?.id;
  if (entryId) {
      const provider = getLLMProvider();
      const embedding = await provider.generateEmbedding(evidence);
      const patchData: Record<string, unknown> = {
          embedding: JSON.stringify(embedding),
      };
      try {
          const { getDefaultCompressor, serialize } = await import("../../src/utils/turboquant.js");
          const compressor = getDefaultCompressor();
          const compressed = compressor.compress(embedding);
          const buf = serialize(compressed);

          patchData.embedding_compressed = buf.toString("base64");
          patchData.embedding_format = `turbo${compressor.bits}`;
          patchData.embedding_turbo_radius = compressed.radius;
      } catch (turboErr: any) {
          console.error("TurboQuant failed:", turboErr);
      }
      await storage.patchLedger(entryId, patchData);
  }

  const allEntries = await storage.getLedgerEntries({ project: `eq.${PROJECT}` });
  console.error("DEBUG DB STATE:", JSON.stringify(allEntries, null, 2));

  // 3. Retrieve relevant memory using Prism's graph search
  const searchRes = await sessionSearchMemoryHandler({ query: trigger, project: PROJECT, similarity_threshold: 0.0 });
  let retrievedContext = "";
  if (!searchRes.isError && searchRes.content?.[0] && 'text' in searchRes.content[0]) {
      retrievedContext = searchRes.content[0].text;
  }
  
  console.error("DEBUG: searchRes =", JSON.stringify(searchRes, null, 2));

  // 4. Ask the LLM (Gemini) using the retrieved context
  const prompt = `You are answering a question based on a memory-aware dialogue system.
Context retrieved from memory:
${retrievedContext}

Question:
${trigger}

Answer concisely.`;

  const provider = getLLMProvider();
  const prediction = await provider.generateText(prompt);
  console.log(prediction);
  process.exit(0);
}

run().catch(e => {
  console.error("Error:", sanitizeForLog(String(e)));
  process.exit(1);
});
