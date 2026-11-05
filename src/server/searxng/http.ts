/**
 * HTTP boundary for the app-managed SearXNG engine (blog review plan M2):
 * status, install (image pull), retry (re-converge — e.g. after starting
 * Docker Desktop), and a test search.
 *
 * Same-origin browser intent (the local Whisper precedent): every call
 * carries `x-learnharness-searxng: 1` and no cross-site fetch metadata. This
 * is not user authentication; the desktop proxy capability still applies.
 */
import { SEARXNG_INTENT_HEADER, type SearxngStatus } from "../../core/search.ts";
import { subscriptionRequestOrigin } from "../web-subscription-http.ts";
import { searxngProvider } from "../search.ts";
import { searxngBaseUrl, searxngStatus, startSearxngPull, syncSearxng } from "./process.ts";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function error(message: string, status: number) {
	return Response.json({ error: message }, { status, headers: HEADERS });
}

function authorized(request: Request, method: "GET" | "POST"): boolean {
	const origin = subscriptionRequestOrigin(request);
	if (request.method !== method || !origin || request.headers.get(SEARXNG_INTENT_HEADER) !== "1") return false;
	if (request.headers.get("sec-fetch-site") === "cross-site") return false;
	const supplied = request.headers.get("origin");
	return method === "GET" ? !supplied || supplied === origin : supplied === null || supplied === origin;
}

const FORBIDDEN = "SearXNG controls require a same-origin LearnHarness request.";

export async function searxngStatusResponse(request: Request): Promise<Response> {
	if (!authorized(request, "GET")) return error(FORBIDDEN, 403);
	return Response.json(await searxngStatus(), { headers: HEADERS });
}

export async function searxngInstallResponse(request: Request): Promise<Response> {
	if (!authorized(request, "POST")) return error(FORBIDDEN, 403);
	const started = await startSearxngPull();
	if (!started.ok) return error(started.error, 409);
	return Response.json(await searxngStatus(), { status: 202, headers: HEADERS });
}

export async function searxngRetryResponse(request: Request): Promise<Response> {
	if (!authorized(request, "POST")) return error(FORBIDDEN, 403);
	await syncSearxng(undefined, { freshProbe: true });
	return Response.json(await searxngStatus(), { headers: HEADERS });
}

export interface SearxngTestResult {
	ok: boolean;
	count?: number;
	sample?: Array<{ title: string; url: string }>;
	error?: string;
	status: SearxngStatus;
}

export async function searxngTestResponse(request: Request): Promise<Response> {
	if (!authorized(request, "POST")) return error(FORBIDDEN, 403);
	let result: Omit<SearxngTestResult, "status">;
	try {
		const hits = await searxngProvider(() => searxngBaseUrl()).search("how does a search engine work", 5);
		result = { ok: true, count: hits.length, sample: hits.slice(0, 3).map(({ title, url }) => ({ title, url })) };
	} catch (caught) {
		result = { ok: false, error: caught instanceof Error ? caught.message : "SearXNG test search failed." };
	}
	return Response.json({ ...result, status: await searxngStatus() } satisfies SearxngTestResult, { headers: HEADERS });
}
