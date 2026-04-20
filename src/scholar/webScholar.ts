import {
  BRAVE_API_KEY,
  FIRECRAWL_API_KEY,
  TAVILY_API_KEY,
  GOOGLE_SEARCH_API_KEY,
  GOOGLE_SEARCH_CX,
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
import { performGoogleSearch } from "../utils/googleSearchApi.js";
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
  } catch {}
}

async function hivemindHeartbeat(task: string): Promise<void> {
  if (!PRISM_ENABLE_HIVEMIND) return;
  try {
    const storage = await getStorage();
    await storage.heartbeatAgent(SCHOLAR_PROJECT, PRISM_USER_ID, SCHOLAR_ROLE, task);
  } catch {}
}

async function hivemindIdle(): Promise<void> {
  if (!PRISM_ENABLE_HIVEMIND) return;
  try {
    const storage = await getStorage();
    await storage.updateAgentStatus(SCHOLAR_PROJECT, PRISM_USER_ID, SCHOLAR_ROLE, "idle");
  } catch {}
}

async function hivemindBroadcast(topic: string, articleCount: number): Promise<void> {
  if (!PRISM_ENABLE_HIVEMIND) return;
  try {
    const storage = await getStorage();
    await storage.heartbeatAgent(
      SCHOLAR_PROJECT, PRISM_USER_ID, SCHOLAR_ROLE,
      `✅ Completed: "${topic}" — ${articleCount} articles synthesized`
    );
    console.error(`[WebScholar] 🐝 TELEPATHY: New research on "${topic}"`);
  } catch {}
}

async function selectTopic(): Promise<string> {
  const topics = PRISM_SCHOLAR_TOPICS;
  if (!topics || topics.length === 0) return "";
  const randomPick = topics[Math.floor(Math.random() * topics.length)];
  if (!PRISM_ENABLE_HIVEMIND) return randomPick;
  try {
    const storage = await getStorage();
    const allAgents = await storage.getAllAgents(PRISM_USER_ID);
    const activeTasks = allAgents
      .filter(a => a.role !== SCHOLAR_ROLE && a.status === "active" && a.current_task)
      .map(a => a.current_task!.toLowerCase());
    if (activeTasks.length === 0) return randomPick;
    const taskText = activeTasks.join(" ");
    const matched = topics.filter(t => taskText.includes(t.toLowerCase()));
    if (matched.length > 0) return matched[Math.floor(Math.random() * matched.length)];
  } catch {}
  return randomPick;
}

// ─── Core Pipeline ───────────────────────────────────────────

let isRunning = false;

export async function runWebScholar(overrideTopic?: string, overrideProject?: string): Promise<string> {
  if (isRunning) {
    debugLog("[WebScholar] Skipped: already running");
    return "Skipped: already running";
  }
  isRunning = true;
  const tracer = getTracer();
  const span = tracer.startSpan("background.web_scholar");
  
  try {
    const useGoogle = !!(GOOGLE_SEARCH_API_KEY && GOOGLE_SEARCH_CX);
    const useBraveFirecrawl = !useGoogle && !!(BRAVE_API_KEY && FIRECRAWL_API_KEY);
    const useTavily = !useGoogle && !useBraveFirecrawl && !!TAVILY_API_KEY;
    const useFreeFallback = !useGoogle && !useBraveFirecrawl && !useTavily;

    const topic = overrideTopic || await selectTopic();
    const project = overrideProject || SCHOLAR_PROJECT;
    
    if (!topic) {
      span.setAttribute("scholar.skipped_reason", "no_topics");
      return "No topics configured";
    }

    debugLog(`[WebScholar] 🧠 Starting research on: "${topic}"`);
    await hivemindRegister(topic);

    await hivemindHeartbeat(`Searching for: ${topic}`);
    let urls: string[] = [];

    if (useGoogle) {
      const googleResults = await performGoogleSearch(GOOGLE_SEARCH_API_KEY!, GOOGLE_SEARCH_CX!, topic, PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN);
      urls = googleResults.map(r => r.url).filter(Boolean);
    } else if (useBraveFirecrawl) {
      const braveResponse = await performWebSearchRaw(topic, PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN);
      const braveData = JSON.parse(braveResponse);
      urls = (braveData.web?.results || []).map((r: any) => r.url).filter(Boolean);
    } else if (useTavily) {
      const tavilyResults = await performTavilySearch(TAVILY_API_KEY!, topic, PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN);
      urls = tavilyResults.map(r => r.url).filter(Boolean);
    } else {
      const ddgResults = await searchYahooFree(topic, PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN);
      urls = ddgResults.map(r => r.url).filter(Boolean);
    }

    if (urls.length === 0) return `No articles found for "${topic}"`;

    await hivemindHeartbeat(`Scraping ${urls.length} articles on: ${topic}`);
    const scrapedTexts: string[] = [];

    if (useTavily) {
      const extracted = await performTavilyExtract(TAVILY_API_KEY!, urls);
      for (const item of extracted) {
        if (item.rawContent) scrapedTexts.push(`Source: ${item.url}\n\n${item.rawContent.slice(0, 15_000)}`);
      }
    } else {
      for (const url of urls) {
        try {
          const article = await scrapeArticleLocal(url);
          scrapedTexts.push(`Source: ${url}\nTitle: ${article.title}\n\n${article.content.slice(0, 15_000)}`);
        } catch {}
      }
    }

    if (scrapedTexts.length === 0) return "All scrapes failed";

    await hivemindHeartbeat(`Synthesizing ${scrapedTexts.length} articles on: ${topic}`);
    const prompt = `You are an AI research assistant. Topic: "${topic}". Read these articles and write a comprehensive report.\n\n${scrapedTexts.join("\n---\n")}`;
    const llm = getLLMProvider();
    const summary = await llm.generateText(prompt);

    const storage = await getStorage();
    await storage.saveLedger({
      id: randomUUID(),
      project: project,
      conversation_id: "scholar-" + Date.now(),
      user_id: PRISM_USER_ID,
      role: "scholar",
      summary: `Research: ${topic}\n\n${summary}`,
      keywords: [topic, "research"],
      event_type: "learning",
      importance: 7,
      created_at: new Date().toISOString()
    });

    await hivemindBroadcast(topic, scrapedTexts.length);
    return summary;

  } catch (err) {
    console.error("[WebScholar] Pipeline failed:", err);
    return `Error: ${err}`;
  } finally {
    await hivemindIdle();
    isRunning = false;
    span.end();
  }
}

// ─── Research Task Bridge (Watcher) ───────────────────────────

let watcherInterval: ReturnType<typeof setInterval> | null = null;

export async function startScholarWatcher(): Promise<void> {
  if (watcherInterval) return;
  debugLog("[WebScholar] Starting bridge watcher (polling for research_tasks)");
  
  watcherInterval = setInterval(async () => {
    try {
      const storage = await getStorage();
      const pending = await storage.listPendingResearchTasks();
      
      for (const task of pending) {
        debugLog(`[WebScholar] Bridge pickup: Task ${task.id} (topic: ${task.topic})`);
        
        await storage.updateResearchTask(task.id, { status: 'RUNNING' });
        
        try {
          const result = await runWebScholar(task.topic, task.project);
          await storage.updateResearchTask(task.id, { 
            status: 'COMPLETED',
            result_summary: result.slice(0, 1000) // snippet
          });
        } catch (err: any) {
          await storage.updateResearchTask(task.id, { 
            status: 'FAILED',
            error_message: err.message || String(err)
          });
        }
      }
    } catch (err) {
      debugLog(`[WebScholar] Bridge poll failed: ${err}`);
    }
  }, 10_000); // Poll every 10 seconds
}

export function stopScholarWatcher(): void {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
  }
}
