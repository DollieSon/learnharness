/**
 * Server boot hook (Next.js instrumentation). Starts the local whisper-server
 * WITH THE APP when local Whisper is the selected engine and installed (owner,
 * 2026-11-03). Not awaited: register() must finish before the server accepts
 * requests, and loading a model can take seconds.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { syncWhisper } = await import("./src/server/whisper/process.ts");
	void syncWhisper().catch((error: unknown) => console.warn("[whisper] boot start failed:", error));
}
