/**
 * Node-only server boot (imported by instrumentation.ts in the Node.js
 * runtime only — the documented runtime-specific pattern, so no bundler
 * compiles these node: imports for the Edge runtime). Starts the local
 * whisper-server WITH THE APP when local Whisper is the selected engine and
 * installed (owner, 2026-11-03), and the app-managed SearXNG container when
 * it is enabled and installed (blog review plan M2, owner 2026-11-06). Not
 * awaited: both can take seconds.
 */
import { syncWhisper } from "./src/server/whisper/process.ts";
import { syncSearxng } from "./src/server/searxng/process.ts";

void syncWhisper().catch((error: unknown) => console.warn("[whisper] boot start failed:", error));
void syncSearxng().catch((error: unknown) => console.warn("[searxng] boot start failed:", error));
