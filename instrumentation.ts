/**
 * Server boot hook (Next.js instrumentation). Next calls register() in every
 * runtime, so the Node-only boot (local Whisper, SearXNG) lives in
 * instrumentation-node.ts and is imported only in the Node.js runtime — the
 * pattern the Next.js instrumentation guide documents.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		await import("./instrumentation-node.ts");
	}
}
