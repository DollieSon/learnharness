/**
 * The search-provider port (search port + model slots wave, 2026-09-20).
 *
 * Search engines are pluggable behind ONE seam: the settings record names a
 * preferred engine (agent.search.engine — optional), keys live in the auth
 * store (the curated key catalog), and the server composes the live adapter.
 *
 * Owner decisions baked here:
 *  - NO default engine in the factory record: an engine is live iff its
 *    key is present. With a key, the engine auto-activates (the user never
 *    chooses an engine to make search work — setting the key is enough);
 *    agent.search.engine is only an explicit preference.
 *  - Nothing silently falls back: no engine live = search is honestly
 *    unavailable (the tool says so). Research remains available keylessly
 *    through web_fetch for known URLs.
 *
 * Pure types, the engine table + protocol docs only (browser-safe, no node
 * imports): the adapters are server-side (src/server/search.ts) and arrive
 * as injected dependencies — the agent-layer tool depends on THIS port only.
 */

/** One search result row — the shape every adapter must produce (the
 *  researcher's tool contract; same fields the old Google adapter emitted). */
export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

/** The KEYED search engines (API key = live), in automatic preference
 * order. Keep existing preferences stable when adding an engine: an
 * explicit pin always wins. The app-managed local SearXNG engine (blog
 * review plan M2, owner 2026-11-06) is not keyed and sits outside this
 * list; when it is live it leads the automatic order. */
export const SEARCH_ENGINES = [
	{ id: "tavily", label: "Tavily", envVar: "TAVILY_API_KEY" },
	{ id: "brave", label: "Brave", envVar: "BRAVE_API_KEY" },
	{ id: "exa", label: "Exa", envVar: "EXA_API_KEY" },
	{ id: "firecrawl", label: "Firecrawl", envVar: "FIRECRAWL_API_KEY" },
	{ id: "ollama", label: "Ollama", envVar: "OLLAMA_API_KEY" },
] as const;

/** A keyed engine's id. */
export type KeyedSearchEngineId = (typeof SEARCH_ENGINES)[number]["id"];

/** Every engine id: the local SearXNG engine plus the keyed catalog. */
export type SearchEngineId = "searxng" | KeyedSearchEngineId;

/** Every engine id, SearXNG first (the automatic order). */
export const SEARCH_ENGINE_IDS: readonly SearchEngineId[] = ["searxng", ...SEARCH_ENGINES.map((engine) => engine.id)];

/** The read/write guards' membership check (settings record + PUT body). */
export function isSearchEngineId(value: unknown): value is SearchEngineId {
	return value === "searxng" || SEARCH_ENGINES.some((engine) => engine.id === value);
}

/** Blog review settings (blog review plan M3): both default OFF. */
export interface BlogSettings {
	autoShareFullText?: boolean;
	injectionCheck?: boolean;
}

/** The settings record's search section (agent.search). `engine` is an
 *  optional explicit pin; `searxng.enabled` turns the app-managed local
 *  engine on (absent = off, owner 2026-11-06). */
export interface SearchSettings {
	engine?: SearchEngineId;
	searxng?: { enabled: boolean };
}

/** Same-origin intent header on every SearXNG control request. */
export const SEARXNG_INTENT_HEADER = "x-learnharness-searxng";

/** The app-managed SearXNG engine as the Settings panel sees it. */
export interface SearxngStatus {
	enabled: boolean;
	/** Docker Desktop: CLI missing, daemon down, or ready to run containers. */
	docker: "ready" | "not-installed" | "not-running";
	/** The pinned image (docker pull = "Install"). */
	image: { ref: string; installed: boolean; approxSizeMb: number };
	/** An image pull in progress (the last progress line), or null. */
	pull: { detail: string } | null;
	/** The last failed pull's message, or null. */
	pullError: string | null;
	/** The container this app runs while it is open. */
	process: { phase: "stopped" | "starting" | "running" | "error"; error: string | null };
}

/** A live search engine: an id (for status/labels) + one operation. The
 *  adapters own their wire protocol (fetch, timeouts, error mapping) —
 *  callers see only this. `search` throws on failure (adapters map HTTP
 *  errors to clear Error messages); the tool layer catches and reports. */
export interface SearchProvider {
	id: SearchEngineId;
	search(query: string, count: number): Promise<SearchHit[]>;
}

/** Why search is (un)available — the honest status the UI and the tool
 *  layer explain from. `engine` is the ACTIVE engine when live. */
export interface SearchStatus {
	available: boolean;
	/** The active engine (null when unavailable). */
	engine: SearchEngineId | null;
	/** The one-line reason for the state (status text for the UI). */
	reason: string;
}
