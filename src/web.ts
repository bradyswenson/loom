/**
 * Web browsing module for Loom.
 * Provides search and URL fetching with swappable providers.
 */

// --- Types ---

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  ok: boolean;
  results: SearchResult[];
  error?: string;
}

export interface FetchResult {
  ok: boolean;
  url: string;
  title?: string;
  text?: string;
  error?: string;
}

export type SearchProvider = "duckduckgo" | "tavily" | "serpapi";

// --- Configuration ---

const DEFAULT_PROVIDER: SearchProvider = "duckduckgo";

function getSearchProvider(): SearchProvider {
  const env = process.env.SEARCH_PROVIDER?.toLowerCase().trim();
  if (env === "tavily" || env === "serpapi") return env;
  return DEFAULT_PROVIDER;
}

// --- DuckDuckGo Implementation ---

/**
 * Search using DuckDuckGo Instant Answer API + lite search.
 * The instant answer API is free and doesn't require scraping.
 */
async function searchDuckDuckGo(query: string, maxResults = 5): Promise<SearchResponse> {
  try {
    // Use the instant answer API for quick facts
    const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

    const response = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Loom/1.0; +https://github.com/loom)",
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      return { ok: false, results: [], error: `HTTP ${response.status}` };
    }

    const data = await response.json() as DuckDuckGoResponse;
    const results = parseDuckDuckGoResponse(data, maxResults);

    console.log(`web: DuckDuckGo search for "${query}" returned ${results.length} results`);
    return { ok: true, results };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`web: DuckDuckGo search error:`, msg);
    return { ok: false, results: [], error: msg };
  }
}

interface DuckDuckGoResponse {
  Abstract?: string;
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  Image?: string;
  Heading?: string;
  Answer?: string;
  AnswerType?: string;
  Definition?: string;
  DefinitionSource?: string;
  DefinitionURL?: string;
  RelatedTopics?: Array<{
    Text?: string;
    FirstURL?: string;
    Result?: string;
  }>;
  Results?: Array<{
    Text?: string;
    FirstURL?: string;
    Result?: string;
  }>;
}

/**
 * Parse DuckDuckGo instant answer API response.
 */
function parseDuckDuckGoResponse(data: DuckDuckGoResponse, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Add main abstract if available
  if (data.AbstractText && data.AbstractURL) {
    results.push({
      title: data.Heading || data.AbstractSource || "DuckDuckGo",
      url: data.AbstractURL,
      snippet: data.AbstractText.slice(0, 300),
    });
  }

  // Add answer if available
  if (data.Answer && !results.length) {
    results.push({
      title: "Answer",
      url: `https://duckduckgo.com/?q=${encodeURIComponent(data.Answer)}`,
      snippet: data.Answer,
    });
  }

  // Add definition if available
  if (data.Definition && data.DefinitionURL) {
    results.push({
      title: data.DefinitionSource || "Definition",
      url: data.DefinitionURL,
      snippet: data.Definition,
    });
  }

  // Add related topics
  if (data.RelatedTopics) {
    for (const topic of data.RelatedTopics) {
      if (results.length >= maxResults) break;
      if (topic.FirstURL && topic.Text) {
        results.push({
          title: topic.Text.split(" - ")[0] || "Related",
          url: topic.FirstURL,
          snippet: topic.Text,
        });
      }
    }
  }

  // Add direct results
  if (data.Results) {
    for (const result of data.Results) {
      if (results.length >= maxResults) break;
      if (result.FirstURL && result.Text) {
        results.push({
          title: result.Text.split(" - ")[0] || "Result",
          url: result.FirstURL,
          snippet: result.Text,
        });
      }
    }
  }

  return results.slice(0, maxResults);
}

// --- Tavily Implementation (placeholder) ---

async function searchTavily(query: string, maxResults = 5): Promise<SearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, results: [], error: "TAVILY_API_KEY not set" };
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        include_answer: false,
      }),
    });

    if (!response.ok) {
      return { ok: false, results: [], error: `HTTP ${response.status}` };
    }

    const data = await response.json() as { results?: Array<{ title: string; url: string; content: string }> };
    const results: SearchResult[] = (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));

    console.log(`web: Tavily search for "${query}" returned ${results.length} results`);
    return { ok: true, results };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`web: Tavily search error:`, msg);
    return { ok: false, results: [], error: msg };
  }
}

// --- SerpAPI Implementation (placeholder) ---

async function searchSerpApi(query: string, maxResults = 5): Promise<SearchResponse> {
  const apiKey = process.env.SERPAPI_KEY?.trim();
  if (!apiKey) {
    return { ok: false, results: [], error: "SERPAPI_KEY not set" };
  }

  try {
    const params = new URLSearchParams({
      q: query,
      api_key: apiKey,
      engine: "google",
      num: String(maxResults),
    });

    const response = await fetch(`https://serpapi.com/search?${params}`);
    if (!response.ok) {
      return { ok: false, results: [], error: `HTTP ${response.status}` };
    }

    const data = await response.json() as { organic_results?: Array<{ title: string; link: string; snippet: string }> };
    const results: SearchResult[] = (data.organic_results || []).slice(0, maxResults).map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
    }));

    console.log(`web: SerpAPI search for "${query}" returned ${results.length} results`);
    return { ok: true, results };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`web: SerpAPI search error:`, msg);
    return { ok: false, results: [], error: msg };
  }
}

// --- URL Fetching ---

/**
 * Fetch a URL and extract its main text content.
 */
export async function fetchUrl(url: string): Promise<FetchResult> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Loom/1.0; +https://github.com/loom)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      return { ok: false, url, error: `HTTP ${response.status}` };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return { ok: false, url, error: `Unsupported content type: ${contentType}` };
    }

    const html = await response.text();
    const { title, text } = extractContent(html);

    console.log(`web: fetched ${url}, extracted ${text.length} chars`);
    return { ok: true, url, title, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`web: fetch error for ${url}:`, msg);
    return { ok: false, url, error: msg };
  }
}

/**
 * Extract title and main text content from HTML.
 */
function extractContent(html: string): { title: string; text: string } {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";

  // Remove script, style, nav, header, footer, aside elements
  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");

  // Try to find article or main content
  const articleMatch = cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = cleaned.match(/<main[^>]*>([\s\S]*?)<\/main>/i);

  const content = articleMatch?.[1] || mainMatch?.[1] || cleaned;

  // Strip remaining HTML tags
  let text = content
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  // Limit length
  if (text.length > 15000) {
    text = text.slice(0, 15000) + "...";
  }

  return { title, text };
}

// --- Public API ---

/**
 * Search the web using the configured provider.
 */
export async function search(query: string, maxResults = 5): Promise<SearchResponse> {
  const provider = getSearchProvider();

  switch (provider) {
    case "tavily":
      return searchTavily(query, maxResults);
    case "serpapi":
      return searchSerpApi(query, maxResults);
    case "duckduckgo":
    default:
      return searchDuckDuckGo(query, maxResults);
  }
}

/**
 * Search and summarize: search for a query, then fetch top result(s) for more context.
 */
export async function searchAndFetch(query: string, fetchTop = 1): Promise<{
  ok: boolean;
  searchResults: SearchResult[];
  fetchedContent: FetchResult[];
  error?: string;
}> {
  const searchResponse = await search(query);

  if (!searchResponse.ok || searchResponse.results.length === 0) {
    return {
      ok: false,
      searchResults: [],
      fetchedContent: [],
      error: searchResponse.error || "No results found",
    };
  }

  const fetchedContent: FetchResult[] = [];
  const toFetch = searchResponse.results.slice(0, fetchTop);

  for (const result of toFetch) {
    const fetched = await fetchUrl(result.url);
    fetchedContent.push(fetched);
  }

  return {
    ok: true,
    searchResults: searchResponse.results,
    fetchedContent,
  };
}

/**
 * Get the current search provider name.
 */
export function getProviderName(): string {
  return getSearchProvider();
}

/**
 * Check if web capabilities are available.
 */
export function isConfigured(): boolean {
  const provider = getSearchProvider();

  switch (provider) {
    case "tavily":
      return !!process.env.TAVILY_API_KEY;
    case "serpapi":
      return !!process.env.SERPAPI_KEY;
    case "duckduckgo":
    default:
      return true; // DuckDuckGo doesn't need an API key
  }
}
