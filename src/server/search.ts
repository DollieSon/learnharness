/**
 * The search engines' server composition (search port + model slots wave,
 * 2026-09-20): the Tavily + Brave adapters behind the core port
 * (core/search.ts) + the live-engine resolution the settings UI and the
 * agent-layer tool both read.
 *
 * Owner decisions (2026-09-20) baked in:
 *  - NO default engine: an engine is live iff its key is present (auth
 *    store or env — env wins, keyed via server/keys.ts keyValue).
 *  - Setting a key is ALL the user does — auto-detection: explicit
 *    agent.search.engine pins the preference (when BOTH keys are present
 *    the preference order is Tavily → Brave); without a pin, whichever
 *    engine has a key is the engine.
 *  - An explicit choice does NOT silently fall back to the other engine:
 *    engine pinned but its key missing = honestly unavailable (reason
 *    says so) — no guessing what the user meant.
 *
 * The adapters are injected dependencies (fetch-shaped) so the agent-layer
 * tool depends on the PORT only and tests never touch the network.
 */

import type { SearchEngineId, SearchHit, SearchProvider, SearchStatus } from "../core/search.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";
import { searxngBaseUrl, searxngLive, searxngProcessView } from "./searxng/process.ts";

/** The wire-callable shape the adapters close over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Tavily: POST https://api.tavily.com/search — Bearer auth in the
 *  Authorization header (the current documented scheme; the legacy
 *  api_key-in-body form is retired), query + max_results (0–20) in the
 *  JSON body. VERIFIED against docs.tavily.com's OpenAPI, 2026-09-20:
 *  response {results: [{title, url, content, score, …}]}, errors
 *  {detail: {error}}. */
export function tavilyProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "tavily",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.tavily.com/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, max_results: Math.min(count, 20) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				// Their error body is {detail: {error: "…"}} — surface the
				// message when present, else the raw slice.
				let detail = body.slice(0, 200);
				try {
					const parsed = JSON.parse(body) as { detail?: { error?: string } };
					if (parsed.detail?.error) detail = parsed.detail.error.slice(0, 200);
				} catch {
					/* keep the raw slice */
				}
				throw new Error(`Tavily search API ${resp.status}: ${detail}`);
			}
			const data = (await resp.json()) as {
				results?: Array<{ title?: string; url?: string; content?: string }>;
			};
			return (data.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.content ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** Brave: GET https://api.search.brave.com/res/v1/web/search with the
 *  key in the X-Subscription-Token header. VERIFIED against Brave's
 *  dashboard docs, 2026-09-20: count max 20; response
 *  {web: {results: [{title, url, description, …}]}}. */
export function braveProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "brave",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(Math.min(count, 20)));
			const resp = await fetchFn(url.toString(), {
				headers: {
					accept: "application/json",
					"x-subscription-token": apiKey,
				},
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				throw new Error(`Brave search API ${resp.status}: ${body.slice(0, 200)}`);
			}
			const data = (await resp.json()) as {
				web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
			};
			return (data.web?.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.description ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** SearXNG (blog review plan M2, owner 2026-11-06): the app-managed local
 *  engine — GET {base}/search?q=…&format=json (JSON output is switched on
 *  by the settings.yml this app writes). Response {results: [{title, url,
 *  content, …}], unresponsive_engines: [[name, reason], …]}. `baseUrl`
 *  resolves (and if needed starts) the running container per search. */
export function searxngProvider(baseUrl: () => Promise<string>, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "searxng",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL("/search", await baseUrl());
			url.searchParams.set("q", query);
			url.searchParams.set("format", "json");
			const resp = await fetchFn(url.toString(), {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				throw new Error(`SearXNG search ${resp.status}: ${body.slice(0, 200)}`);
			}
			const data = (await resp.json()) as {
				results?: Array<{ title?: string; url?: string; content?: string }>;
				unresponsive_engines?: Array<[string, string]>;
			};
			const hits = (data.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.slice(0, Math.min(count, 20))
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.content ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
			if (hits.length === 0 && data.unresponsive_engines?.length) {
				const names = data.unresponsive_engines.map(([name, why]) => `${name} (${why})`).join(", ");
				throw new Error(`SearXNG found nothing — its upstream engines did not answer: ${names.slice(0, 300)}`);
			}
			return hits;
		},
	};
}

/** The KEYED engines, in PREFERENCE order (both keys present, no explicit
 *  pin → the first keyed engine wins; owner decision 2026-09-20: Tavily
 *  first — the AI-native search API the wave chose). SearXNG, when live,
 *  leads the auto order ahead of these (owner, 2026-11-06). */
const ENGINE_ORDER: ReadonlyArray<{ id: Exclude<SearchEngineId, "searxng">; envVar: string }> = [
	{ id: "tavily", envVar: "TAVILY_API_KEY" },
	{ id: "brave", envVar: "BRAVE_API_KEY" },
];

/** The engine's key (env-or-file; env wins) — null when the engine is
 *  not keyed, which by owner decision means NOT LIVE. */
function engineKey(id: Exclude<SearchEngineId, "searxng">): string | null {
	const envVar = ENGINE_ORDER.find((e) => e.id === id)?.envVar;
	const value = envVar ? keyValue(envVar) : undefined;
	return value ? value : null;
}

/** SearXNG's state for resolution: the settings switch, whether it is up
 *  (running or starting), and why not when it is enabled but down. */
export interface SearxngResolutionState {
	enabled: boolean;
	live: boolean;
	error?: string | null;
}

/** Resolve the search state PURELY from the given pins (testable): the
 *  explicit engine (if pinned) wins but must be live (SearXNG) or keyed;
 *  absent pin → SearXNG when live, else the first keyed engine in
 *  preference order. Never throws. */
export function resolveSearchEngineFor(
	pinned: SearchEngineId | undefined,
	/** Per-engine live keys (absent engine = absent property is fine). */
	keys: Partial<Record<SearchEngineId, string | undefined>>,
	searxng: SearxngResolutionState = { enabled: false, live: false },
): SearchStatus & { key: string | null } {
	const searxngDown = searxng.enabled && !searxng.live
		? `SearXNG is enabled but not running${searxng.error ? `: ${searxng.error}` : ""}`
		: null;
	if (pinned === "searxng") {
		if (searxng.live) return { available: true, engine: "searxng", reason: "search engine: searxng (chosen)", key: null };
		return {
			available: false,
			engine: null,
			reason: searxngDown ?? 'search engine is set to "searxng" but SearXNG is turned off — enable it in Settings → Agent',
			key: null,
		};
	}
	const pinnedKey = pinned ? keys[pinned] ?? null : null;
	if (pinned) {
		if (!pinnedKey) {
			return {
				available: false,
				engine: null,
				reason: `search engine is set to "${pinned}" but its API key is missing — set the ${pinned === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY"} key`,
				key: null,
			};
		}
		return { available: true, engine: pinned, reason: `search engine: ${pinned} (chosen)`, key: pinnedKey };
	}
	if (searxng.live) return { available: true, engine: "searxng", reason: "search engine: searxng (auto)", key: null };
	for (const { id } of ENGINE_ORDER) {
		const key = keys[id] ?? null;
		if (key) {
			return {
				available: true,
				engine: id,
				reason: `search engine: ${id} (auto)${searxngDown ? ` — ${searxngDown}` : ""}`,
				key,
			};
		}
	}
	return {
		available: false,
		engine: null,
		reason: searxngDown ?? "no search engine configured — enable local SearXNG or set a Tavily or Brave search API key",
		key: null,
	};
}

function liveResolution(): SearchStatus & { key: string | null } {
	const enabled = effectiveSettings().agent.search?.searxng?.enabled === true;
	return resolveSearchEngineFor(
		effectiveSettings().agent.search?.engine,
		{
			tavily: engineKey("tavily") ?? undefined,
			brave: engineKey("brave") ?? undefined,
		},
		{ enabled, live: searxngLive(), error: searxngProcessView().error },
	);
}

/** The live search state (the honest availability signal): reads the
 *  settings record's pin + the auth store fresh each call, so a key saved
 *  mid-session activates on the next check (no restart). */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = liveResolution();
	return { available, engine, reason };
}

/** Search available at all? (the settings UI's gray-out signal + the
 *  researcher's enable/disable pin — Teacher stream's rewiring reads this.) */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer (Teacher stream) calls this once per search, so key
 *  rotations take effect immediately. */
export function searchProvider(): SearchProvider | null {
	const resolved = liveResolution();
	if (!resolved.available) return null;
	if (resolved.engine === "searxng") return searxngProvider(() => searxngBaseUrl());
	if (!resolved.key) return null;
	return resolved.engine === "tavily" ? tavilyProvider(resolved.key) : braveProvider(resolved.key);
}
