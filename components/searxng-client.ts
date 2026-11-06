"use client";

/**
 * The window's side of the app-managed SearXNG engine (blog review plan M2):
 * status / install / retry / test calls, each carrying the same-origin intent
 * header the server requires. The window never talks to SearXNG itself.
 */
import { SEARXNG_INTENT_HEADER, type SearxngStatus } from "@/src/core";

const HEADERS = { [SEARXNG_INTENT_HEADER]: "1" } as const;

export interface SearxngTestResult {
	ok: boolean;
	count?: number;
	sample?: Array<{ title: string; url: string }>;
	error?: string;
	status: SearxngStatus;
}

async function readError(response: Response): Promise<string> {
	const body = (await response.json().catch(() => ({}))) as { error?: unknown };
	return typeof body.error === "string" ? body.error : `SearXNG request failed (HTTP ${response.status})`;
}

export async function fetchSearxngStatus(signal?: AbortSignal): Promise<SearxngStatus> {
	const response = await fetch("/api/search/searxng/status", { cache: "no-store", headers: HEADERS, signal });
	if (!response.ok) throw new Error(await readError(response));
	return (await response.json()) as SearxngStatus;
}

async function post<T>(path: string): Promise<T> {
	const response = await fetch(`/api/search/searxng/${path}`, { method: "POST", headers: HEADERS });
	if (!response.ok) throw new Error(await readError(response));
	return (await response.json()) as T;
}

export const installSearxng = () => post<SearxngStatus>("install");
export const retrySearxng = () => post<SearxngStatus>("retry");
export const testSearxng = () => post<SearxngTestResult>("test");
