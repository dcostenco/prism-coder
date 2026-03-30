import {
  BRAVE_API_KEY,
  FIRECRAWL_API_KEY,
  TAVILY_API_KEY,
  PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN,
  PRISM_USER_ID,
  PRISM_SCHOLAR_TOPICS,
  PRISM_ENABLE_HIVEMIND
} from "../config.js";
import { getStorage } from "../storage/index.js";
import { debugLog } from "../utils/logger.js";
import { getLLMProvider } from "../utils/llm/factory.js";
import { randomUUID } from "node:crypto";
import { performWebSearchRaw } from "../utils/braveApi.js";
import { performTavilySearch, performTavilyExtract } from "../utils/tavilyApi.js";
import { getTracer } from "../utils/telemetry.js";
import { searchYahooFree, scrapeArticleLocal } from "./freeSearch.js";

interface FirecrawlScrapeResponse {
  success: boolean;
  data: {
    markdown?: string;
  };
}

// ─── Hivemind Integration Helpers ────────────────────────────

const SCHOLAR_PROJECT = "prism-scholar";
const SCHOLAR_ROLE = "scholar";

/**
 * Phase 1: Register the Scholar as a Hivemind agent and emit heartbeats.
 * Shows up on the Dashboard Radar as 🧠 with the current research topic.
 * Gracefully no-ops when Hivemind is disabled.
 */
async function hivemindRegister(topic: string): Promise<void> {
  if (!PRISM_ENABLE_HIVEMIND) return;
  try {
    const storage = await getStorage();
    await storage.registerAgent({
      project: SCHOLAR_PROJECT,
      user_id: PRISM_USER_ID,
      role: SCHOLAR_ROLE,
      agent_name: "Web Scholar",
      status: "active",
      current_task: `Researching: ${topic}`,
    });
    debugLog(`[WebScholar] 🐝 Registered on Hivemind Radar (topic: ${topic})`);
  } catch (err) {
    debugLog(`[WebScholar] Hivemind registration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function hivemindHeartbeat(task: string): Promise<void> {
  if (!PRISM_ENABLE_HIVEMIND) return;
  try {
    const storage = await getStorage();
    await storage.heartbeatAgent(SCHOLAR_PROJECT, PRISM_USER_ID, SCHOLAR_ROLE, task);
  } catch { /* non-fatal */ }
}

async function hivemindIdle(): Promise<void> {
  if (!PRISM_ENABLE_HIVEMIND) return;
  try {
    const storage = await getStorage();
    await storage.updateAgentStatus(SCHOLAR_PROJECT, PRISM_USER_ID, SCHOLAR_ROLE, "idle");
  } catch { /* non-fatal */ }
}

/**
 * Phase 2: Broadcast a Telepathy alert after a successful research run.
 * Active dev/qa agents will see "[🐝 SCHOLAR]" in their next tool response.
 * Uses console.error to log the broadcast — the Watchdog sweep will pick up
 * the Scholar's state change and generate alerts for active agents.
 */
async function hivemindBroadcast(topic: string, articleCount: number): Promise<void> {
  if (!PRISM_ENABLE_HIVEMIND) return;
  try {
    const storage = await getStorage();
    // Update Scholar's current_task so the Watchdog and Dashboard show the result
    await storage.heartbeatAgent(
      SCHOLAR_PROJECT, PRISM_USER_ID, SCHOLAR_ROLE,
      `✅ Completed: "${topic}" — ${articleCount} articles synthesized`
    );

    // Log the broadcast — visible to operators watching the process
    console.error(
      `[WebScholar] 🐝 TELEPATHY: New research on "${topic}" — ` +
      `${articleCount} articles synthesized. Active agents will see results in knowledge search.`
    );
  } catch (err) {
    debugLog(`[WebScholar] Telepathy broadcast failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Phase 3: Task-aware topic selection.
 * If Hivemind is active, check what other agents are working on and
 * bias toward configured topics that overlap with their active tasks.
 * Falls back to random selection if no matches or Hivemind is off.
 */
async function selectTopic(): Promise<string> {
  const topics = PRISM_SCHOLAR_TOPICS;
  if (!topics || topics.length === 0) return "";

  // Default: random pick
  const randomPick = topics[Math.floor(Math.random() * topics.length)];

  if (!PRISM_ENABLE_HIVEMIND) return randomPick;

  try {
    const storage = await getStorage();
    const allAgents = await storage.getAllAgents(PRISM_USER_ID);
    const activeTasks = allAgents
      .filter(a => a.role !== SCHOLAR_ROLE && a.status === "active" && a.current_task)
      .map(a => a.current_task!.toLowerCase());

    if (activeTasks.length === 0) return randomPick;

    // Find configured topics that match keywords in active agent tasks
    const taskText = activeTasks.join(" ");
    const matched = topics.filter(t => taskText.includes(t.toLowerCase()));

    if (matched.length > 0) {
      const chosen = matched[Math.floor(Math.random() * matched.length)];
      debugLog(`[WebScholar] 🐝 Task-aware topic: "${chosen}" (matched from active agent tasks)`);
      return chosen;
    }
  } catch (err) {
    debugLog(`[WebScholar] Task-aware selection failed (non-fatal), using random: ${err instanceof Error ? err.message : String(err)}`);
  }

  return randomPick;
}

// ─── Core Pipeline ───────────────────────────────────────────

/**
 * Runs the Web Scholar pipeline:
 * 1. Picks a topic (task-aware when Hivemind is on)
 * 2. Registers on the Hivemind Radar
 * 3. Searches Brave for recent articles
 * 4. Scrapes articles as markdown using Firecrawl
 * 5. Summarizes the findings via LLM
 * 6. Injects the summary directly into Prism's semantic ledger
 * 7. Broadcasts a Telepathy alert to active agents
 */
let isRunning = false;

export async function runWebScholar(): Promise<void> {
  if (isRunning) {
    debugLog("[WebScholar] Skipped: already running");
    return;
  }
  isRunning = true;
  const tracer = getTracer();
  const span = tracer.startSpan("background.web_scholar");
  
  try {
    // Pipeline priority:
    //   1. Brave + Firecrawl (when both keys present)
    //   2. Tavily Search + Extract (when TAVILY_API_KEY set but Brave/Firecrawl missing)
    //   3. Yahoo + Readability free fallback (no paid keys)
    const useBraveFirecrawl = !!(BRAVE_API_KEY && FIRECRAWL_API_KEY);
    const useTavily = !useBraveFirecrawl && !!TAVILY_API_KEY;
    const useFreeFallback = !useBraveFirecrawl && !useTavily;

    if (!PRISM_SCHOLAR_TOPICS || PRISM_SCHOLAR_TOPICS.length === 0) {
      debugLog("[WebScholar] Skipped: No topics configured in PRISM_SCHOLAR_TOPICS");
      span.setAttribute("scholar.skipped_reason", "no_topics");
      return;
    }

    // 1. Pick a topic (task-aware when Hivemind is active)
    const topic = await selectTopic();
    if (!topic) {
      span.setAttribute("scholar.skipped_reason", "no_topics");
      return;
    }
    debugLog(`[WebScholar] 🧠 Starting research on topic: "${topic}"`);
    span.setAttribute("scholar.topic", topic);

    // 2. Register on Hivemind Radar
    await hivemindRegister(topic);

    // 3. Search for articles
    await hivemindHeartbeat(`Searching for: ${topic}`);
    let urls: string[] = [];

    if (useBraveFirecrawl) {
      const braveResponse = await performWebSearchRaw(topic, PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN);
      const braveData = JSON.parse(braveResponse);
      urls = (braveData.web?.results || []).map((r: any) => r.url).filter(Boolean);
    } else if (useTavily) {
      debugLog("[WebScholar] Using Tavily Search for URL discovery");
      const tavilyResults = await performTavilySearch(TAVILY_API_KEY!, topic, PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN);
      urls = tavilyResults.map(r => r.url).filter(Boolean);
    } else {
      debugLog("[WebScholar] API keys missing, falling back to Local Free Search (Yahoo + Readability)");
      const ddgResults = await searchYahooFree(topic, PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN);
      urls = ddgResults.map(r => r.url).filter(Boolean);
    }

    if (urls.length === 0) {
      debugLog(`[WebScholar] No articles found for "${topic}"`);
      span.setAttribute("scholar.skipped_reason", "no_search_results");
      return;
    }

    debugLog(`[WebScholar] Found ${urls.length} articles. Scraping...`);
    span.setAttribute("scholar.articles_found", urls.length);

    // 4. Scrape each URL
    await hivemindHeartbeat(`Scraping ${urls.length} articles on: ${topic}`);
    const scrapedTexts: string[] = [];

    if (useTavily) {
      // Tavily Extract: batch all URLs at once (up to 20)
      try {
        debugLog(`[WebScholar] Extracting ${urls.length} URLs via Tavily Extract`);
        const extracted = await performTavilyExtract(TAVILY_API_KEY!, urls);
        for (const item of extracted) {
          if (item.rawContent) {
            const trimmed = item.rawContent.slice(0, 15_000);
            scrapedTexts.push(`Source: ${item.url}\n\n${trimmed}\n\n---\n`);
          }
        }
      } catch (err) {
        console.error("[WebScholar] Tavily Extract failed:", err);
      }
    } else {
      for (const url of urls) {
        if (useFreeFallback) {
          try {
            debugLog(`[WebScholar] Scraping local fallback: ${url}`);
            const article = await scrapeArticleLocal(url);
            const trimmed = article.content.slice(0, 15_000);
            scrapedTexts.push(`Source: ${url}\nTitle: ${article.title}\n\n${trimmed}\n\n---\n`);
          } catch (err) {
            console.error(`[WebScholar] Failed to locally scrape ${url}:`, err);
          }
        } else {
          try {
            debugLog(`[WebScholar] Scraping Firecrawl: ${url}`);
            const scrapeRes = await fetch("https://api.firecrawl.dev/v1/scrape", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${FIRECRAWL_API_KEY}`
              },
              body: JSON.stringify({
                url,
                formats: ["markdown"],
              })
            });

            if (!scrapeRes.ok) {
              console.error(`[WebScholar] Firecrawl failed for ${url}: ${scrapeRes.status}`);
              continue;
            }

            const result = (await scrapeRes.json()) as FirecrawlScrapeResponse;
            if (result.success && result.data?.markdown) {
              const trimmed = result.data.markdown.slice(0, 15_000);
              scrapedTexts.push(`Source: ${url}\n\n${trimmed}\n\n---\n`);
            }
          } catch (err) {
            console.error(`[WebScholar] Failed to scrape ${url}:`, err);
          }
        }
      }
    }

    if (scrapedTexts.length === 0) {
      debugLog(`[WebScholar] Could not extract markdown from any articles.`);
      span.setAttribute("scholar.skipped_reason", "all_scrapes_failed");
      return;
    }

    span.setAttribute("scholar.articles_scraped", scrapedTexts.length);

    // 5. Summarize findings using LLM
    await hivemindHeartbeat(`Synthesizing ${scrapedTexts.length} articles on: ${topic}`);
    debugLog(`[WebScholar] Summarizing ${scrapedTexts.length} articles...`);
    const combinedText = scrapedTexts.join("\n");
    const prompt = `You are an AI research assistant. You have been asked to research the topic: "${topic}".
Read the following scraped web articles and write a comprehensive, markdown-formatted report summarizing the key findings, trends, and actionable insights. Focus heavily on facts, data, and actual content. Do NOT just list the articles. Synthesize the information.

### Scraped Articles:
${combinedText}`;

    const llm = getLLMProvider();
    const summary = await llm.generateText(prompt);

    // 6. Inject the summary back into Prism memory
    await hivemindHeartbeat(`Saving research to ledger: ${topic}`);
    const storage = await getStorage();
    await storage.saveLedger({
      id: randomUUID(),
      project: "prism-scholar",
      conversation_id: "scholar-bg-" + Date.now(),
      user_id: PRISM_USER_ID,
      role: "scholar",
      summary: `Autonomous Web Scholar Research: ${topic}\n\n${summary}`,
      keywords: [topic, "research", "autonomous", "scholar"],
      event_type: "learning",
      importance: 7,
      created_at: new Date().toISOString()
    });

    debugLog(`[WebScholar] ✅ Research complete and saved to ledger under project 'prism-scholar'.`);
    span.setAttribute("scholar.success", true);

    // 7. Broadcast Telepathy alert to active agents
    await hivemindBroadcast(topic, scrapedTexts.length);

  } catch (err) {
    console.error("[WebScholar] Pipeline failed:", err);
    span.setAttribute("scholar.error", String(err));
  } finally {
    await hivemindIdle();
    isRunning = false;
    span.end();
  }
}
