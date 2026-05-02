import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

export interface FreeSearchResult {
    title: string;
    url: string;
    snippet: string;
}

export interface LocalArticle {
    title: string;
    content: string; // Markdown content
    excerpt?: string;
    byline?: string;
}

/**
 * Searches Yahoo Web Search and parses the HTML results using Cheerio.
 * Yahoo provides a reliable HTML fallback that does not block basic automated browser requests.
 */
export async function searchYahooFree(query: string, limit: number = 5): Promise<FreeSearchResult[]> {
    const searchUrl = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`;

    const response = await fetch(searchUrl, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
        throw new Error(`Yahoo Search failed with status: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const results: FreeSearchResult[] = [];

    $('.algo').each((_, elem) => {
        if (results.length >= limit) return false;

        const rawUrl = $(elem).find('a').attr('href') || '';
        let url = rawUrl;
        
        // Yahoo wraps outbound links in a redirector. Decode the actual target URL.
        if (rawUrl.includes('/RU=')) {
            const afterRu = rawUrl.split('/RU=')[1];
            if (afterRu) {
                const targetUrl = afterRu.split('/RK=')[0];
                url = decodeURIComponent(targetUrl);
            }
        }

        const title = $(elem).find('h3').text().trim();
        const snippet = $(elem).find('.compText').text().trim();

        if (url && title) {
            results.push({ title, url, snippet });
        }
    });

    return results;
}

/**
 * Fetches an article's HTML, extracts clean content via Readability, 
 * and converts it to Markdown using Turndown.
 */
export async function scrapeArticleLocal(url: string): Promise<LocalArticle> {
    // SSRF protection: reject private/internal URLs.
    // Set PRISM_DEV_MODE=1 to allow loopback/private hosts during local dev
    // (testing against a local docs server, internal wiki, etc.). The flag
    // is intentionally OFF in production deploys.
    const devMode = process.env.PRISM_DEV_MODE === '1' || process.env.NODE_ENV === 'development';
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Invalid protocol');
        const host = parsed.hostname.toLowerCase();
        const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
        const isPrivate =
            host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.') ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.internal') || host.endsWith('.local');
        if (isLoopback && !devMode) {
            throw new Error('Loopback URLs not allowed in production (set PRISM_DEV_MODE=1 to allow)');
        }
        if (isPrivate) {
            // Private RFC1918 ranges are never allowed — even in dev mode they
            // can cross into other tenants' machines on a shared LAN.
            throw new Error('Private network URLs not allowed');
        }
    } catch (e) { throw new Error(`Invalid URL: ${e instanceof Error ? e.message : 'unknown'}`); }

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch article HTML: ${response.statusText}`);
    }

    const html = await response.text();
    
    // Create a virtual DOM for Readability to traverse
    const doc = new JSDOM(html, { url });
    
    // Extract the article content like Firefox Reader View
    const reader = new Readability(doc.window.document as unknown as Document);
    const article = reader.parse();

    if (!article) {
        throw new Error("Readability could not parse the article content.");
    }

    // Convert the cleaned HTML to Markdown
    const turndownService = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced'
    });
    const markdown = turndownService.turndown(article.content || '');

    return {
        title: article.title || 'Unknown Title',
        content: markdown,
        excerpt: article.excerpt || undefined,
        byline: article.byline || undefined
    };
}
