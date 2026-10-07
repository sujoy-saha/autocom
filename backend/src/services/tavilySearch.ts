import { config } from "../config.js";

export interface WebSearchResult {
  title: string;
  url: string;
  /** Short excerpt of the page content relevant to the query. */
  content: string;
}

interface TavilyApiResponse {
  results?: { title?: string; url?: string; content?: string }[];
}

/**
 * Runs a live web search via Tavily (https://tavily.com), an LLM-oriented
 * search API that returns a short, relevant content snippet per result
 * (rather than raw HTML), which is what the Replenishment and ChatBot
 * agents want to reason/answer from directly.
 *
 * Implemented as a plain `fetch` call against Tavily's REST endpoint rather
 * than pulling in its SDK, keeping this a small, dependency-free leaf module
 * consistent with the rest of the codebase's "no extra moving parts" style.
 *
 * Gracefully degrades to an empty result set (never throws) when
 * TAVILY_API_KEY is unset or the request fails, so callers can treat "no
 * results" and "search disabled" identically and fall back to their
 * existing non-search behavior.
 */
export async function webSearch(query: string, maxResults = 3): Promise<WebSearchResult[]> {
  if (config.isDemoSearch) {
    return [];
  }

  try {
    const response = await fetch(`${config.tavilyBaseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: config.tavilyApiKey,
        query,
        max_results: maxResults,
        search_depth: "basic",
      }),
    });

    if (!response.ok) {
      console.warn(`[tavilySearch] Tavily API returned ${response.status} for query "${query}"`);
      return [];
    }

    const data = (await response.json()) as TavilyApiResponse;
    return (data.results ?? [])
      .slice(0, maxResults)
      .map((r) => ({
        title: r.title ?? "Untitled",
        url: r.url ?? "",
        // Keep snippets short — these get embedded in agent log notes and
        // chat replies, not displayed as a full search results page.
        content: (r.content ?? "").slice(0, 300),
      }));
  } catch (err) {
    console.warn(`[tavilySearch] search failed for query "${query}": ${(err as Error).message}`);
    return [];
  }
}
