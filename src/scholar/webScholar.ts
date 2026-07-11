import {
  BRAVE_API_KEY, FIRECRAWL_API_KEY, GOOGLE_SEARCH_API_KEY,
  GOOGLE_SEARCH_CX, SEMANTIC_SCHOLAR_API_KEY,
  PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN, PRISM_USER_ID,
  PRISM_SCHOLAR_TOPICS, PRISM_ENABLE_HIVEMIND,
} from "../config.js";
import { getStorage } from "../storage/index.js";
import { debugLog } from "../utils/logger.js";
import { getLLMProvider } from "../utils/llm/factory.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { performWebSearchRaw } from "../utils/braveApi.js";
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

  // Filter out topics already researched in the last 24h
  const uncovered: string[] = [];
  for (const t of topics) {
    if (!(await hasRecentResearch(t, SCHOLAR_PROJECT, PRISM_USER_ID, 24))) {
      uncovered.push(t);
    }
  }
  if (uncovered.length === 0) {
    debugLog("[WebScholar] All topics researched in last 24h — sleeping until tomorrow");
    return "";
  }

  const pick = uncovered[Math.floor(Math.random() * uncovered.length)];
  if (!PRISM_ENABLE_HIVEMIND) return pick;
  try {
    const storage = await getStorage();
    const allAgents = await storage.getAllAgents(PRISM_USER_ID);
    const activeTasks = allAgents
      .filter(a => a.role !== SCHOLAR_ROLE && a.status === "active" && a.current_task)
      .map(a => a.current_task!.toLowerCase());
    if (activeTasks.length === 0) return pick;
    const taskText = activeTasks.join(" ");
    const matched = uncovered.filter(t => taskText.includes(t.toLowerCase()));
    if (matched.length > 0) return matched[Math.floor(Math.random() * matched.length)];
  } catch {}
  return pick;
}

// ─── Dedup + Cross-Process Lock ─────────────────────────────

async function hasRecentResearch(topic: string, project: string, userId: string, windowHours: number = 24): Promise<boolean> {
  try {
    const storage = await getStorage();
    const entries = await storage.getLedgerEntries({
      project,
      user_id: userId,
      event_type: "learning",
      limit: 20,
    }) as Array<{ summary?: string; created_at?: string }>;
    const cutoff = new Date(Date.now() - windowHours * 3600_000).toISOString();
    return entries.some(
      e => (e.created_at ?? "") > cutoff && (e.summary ?? "").startsWith(`Research: ${topic}\n`)
    );
  } catch {
    return false;
  }
}

const LOCK_PATH = join(homedir(), ".prism-mcp", "scholar.lock");
const LOCK_STALE_MS = 10 * 60_000;

function acquireFileLock(): boolean {
  try {
    const lockDir = dirname(LOCK_PATH);
    if (!existsSync(lockDir)) mkdirSync(lockDir, { recursive: true });

    const lockContent = `${process.pid}\n${new Date().toISOString()}`;

    // Fast path: exclusive create — no lock exists.
    try {
      writeFileSync(LOCK_PATH, lockContent, { flag: "wx" });
      return true;
    } catch (wxErr: any) {
      if (wxErr?.code !== "EEXIST") return false;
    }

    // Lock exists — check if stale.
    let stat;
    try { stat = statSync(LOCK_PATH); } catch { return false; }
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false;

    // Stale lock — atomic takeover via rename.
    // Write our identity to a temp file, then rename over the lock.
    // rename() is atomic on POSIX; no window where the lock is absent.
    const tmpLock = `${LOCK_PATH}.${process.pid}`;
    try {
      writeFileSync(tmpLock, lockContent, { flag: "wx" });
      renameSync(tmpLock, LOCK_PATH);
    } catch {
      try { unlinkSync(tmpLock); } catch { /* cleanup */ }
      return false;
    }

    // Verify we own the lock (another process may have renamed over us).
    try {
      const owner = readFileSync(LOCK_PATH, "utf-8").split("\n")[0];
      if (owner !== String(process.pid)) return false;
    } catch { return false; }

    return true;
  } catch {
    return false;
  }
}

function releaseFileLock(): void {
  try {
    if (!existsSync(LOCK_PATH)) return;
    const content = readFileSync(LOCK_PATH, "utf-8");
    const lockPid = parseInt(content.split("\n")[0], 10);
    if (lockPid === process.pid) {
      unlinkSync(LOCK_PATH);
    }
  } catch {}
}

// ─── Core Pipeline ───────────────────────────────────────────

let isRunning = false;

export async function runWebScholar(overrideTopic?: string, overrideProject?: string): Promise<string> {
  if (isRunning) {
    debugLog("[WebScholar] Skipped: already running in this process");
    return "Skipped: already running";
  }

  if (!acquireFileLock()) {
    debugLog("[WebScholar] Skipped: another instance holds the lock");
    return "Skipped: another instance is running";
  }

  isRunning = true;
  const tracer = getTracer();
  const span = tracer.startSpan("background.web_scholar");

  try {
    const useGoogle = !!(GOOGLE_SEARCH_API_KEY && GOOGLE_SEARCH_CX);
    const useBraveFirecrawl = !useGoogle && !!(BRAVE_API_KEY && FIRECRAWL_API_KEY);
    const useFreeFallback = !useGoogle && !useBraveFirecrawl;

    const topic = overrideTopic || await selectTopic();
    const project = overrideProject || SCHOLAR_PROJECT;

    if (!topic) {
      span.setAttribute("scholar.skipped_reason", "no_topics");
      return "No topics configured";
    }

    if (await hasRecentResearch(topic, project, PRISM_USER_ID)) {
      debugLog(`[WebScholar] Skipped: "${topic}" already researched in last 24h`);
      span.setAttribute("scholar.skipped_reason", "dedup");
      return `Skipped: "${topic}" already researched recently`;
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
    } else {
      // Parallel Academic Discovery (PubMed + ERIC + Semantic Scholar)
      const academicCount = Math.ceil(PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN / 2);
      const academicResults = await Promise.all([
        searchPubMed(topic, academicCount).catch(() => []),
        searchERIC(topic, academicCount).catch(() => []),
        searchSemanticScholar(topic, academicCount).catch(() => [])
      ]);
      urls = [...new Set(academicResults.flat())].slice(0, PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN);
      
      // Final fallback to Yahoo if no academic results
      if (urls.length === 0) {
        const ddgResults = await searchYahooFree(topic, PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN);
        urls = ddgResults.map(r => r.url).filter(Boolean);
      }
    }

    if (urls.length === 0) return `No articles found for "${topic}"`;

    await hivemindHeartbeat(`Scraping ${urls.length} articles on: ${topic}`);

    const scrapedTexts: string[] = [];

    for (const url of urls) {
      try {
        const article = await scrapeArticleLocal(url);
        scrapedTexts.push(`Source: ${url}\nTitle: ${article.title}\n\n${article.content.slice(0, 15_000)}`);
      } catch {}
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
      conversation_id: `scholar-${randomUUID().slice(0, 8)}`,
      user_id: PRISM_USER_ID,
      role: "scholar",
      summary: `Research: ${topic}\n\n${summary}`,
      keywords: [topic, "research", "auto-scholar"],
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
    releaseFileLock();
    isRunning = false;
    span.end();
  }
}

// ─── Research Task Bridge (Watcher) ───────────────────────────

async function searchPubMed(query: string, count: number): Promise<string[]> {
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmode=json&retmax=${count}`;
  try {
    const searchResp = await fetch(searchUrl, { signal: AbortSignal.timeout(15_000) });
    if (!searchResp.ok) throw new Error("PubMed Search failed");
    const searchData = await searchResp.json();
    const pmids: string[] = searchData.esearchresult?.idlist || [];
    return pmids.map(pmid => `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`);
  } catch (err) {
    debugLog(`[WebScholar] PubMed search error: ${err}`);
    return [];
  }
}

async function searchERIC(query: string, count: number): Promise<string[]> {
  const url = `https://api.ies.ed.gov/eric/?search=${encodeURIComponent(query)}&rows=${count}&format=json`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error("ERIC Search failed");
    const data = await resp.json();
    return (data.response?.docs || []).map((doc: any) => `https://eric.ed.gov/?id=${doc.id}`);
  } catch (err) {
    debugLog(`[WebScholar] ERIC search error: ${err}`);
    return [];
  }
}

async function searchSemanticScholar(query: string, count: number): Promise<string[]> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${count}&fields=url`;
  try {
    const headers: Record<string, string> = {};
    if (SEMANTIC_SCHOLAR_API_KEY) headers["x-api-key"] = SEMANTIC_SCHOLAR_API_KEY;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error("Semantic Scholar Search failed");
    const data = await resp.json();
    return (data.data || []).map((paper: any) => paper.url).filter(Boolean);
  } catch (err) {
    debugLog(`[WebScholar] Semantic Scholar search error: ${err}`);
    return [];
  }
}

