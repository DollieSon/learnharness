/**
 * Server boot hook (Next.js instrumentation). Starts the local whisper-server
 * WITH THE APP when local Whisper is the selected engine and installed (owner,
 * 2026-11-03), and the app-managed SearXNG container when it is enabled and
 * installed (blog review plan M2, owner 2026-11-06). Not awaited: register()
 * must finish before the server accepts requests, and both can take seconds.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { syncWhisper } = await import("./src/server/whisper/process.ts");
	void syncWhisper().catch((error: unknown) => console.warn("[whisper] boot start failed:", error));
	const { syncSearxng } = await import("./src/server/searxng/process.ts");
	void syncSearxng().catch((error: unknown) => console.warn("[searxng] boot start failed:", error));
}
