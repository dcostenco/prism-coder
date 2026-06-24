import { runWebScholar } from "./src/scholar/webScholar.js";
import { PRISM_SCHOLAR_TOPICS } from "./src/config.js";
import { sanitizeForLog } from "./src/utils/logger.js";

// Force API keys empty inside the process env overrides if they were set
process.env.BRAVE_API_KEY = "";
process.env.FIRECRAWL_API_KEY = "";

// Ensure topics are set
if (!PRISM_SCHOLAR_TOPICS || PRISM_SCHOLAR_TOPICS.length === 0) {
    process.env.PRISM_SCHOLAR_TOPICS = "quantum computing";
}

console.log("Starting Web Scholar without API keys...");
runWebScholar().then(() => {
    console.log("Finished Web Scholar fallback test.");
    process.exit(0);
}).catch(err => {
    console.error("Test failed:", sanitizeForLog(String(err)));
    process.exit(1);
});
