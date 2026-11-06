/**
 * HTTP boundary for local Whisper: status, download/cancel, transcribe.
 *
 * Same-origin browser intent (the Claude Code status precedent): every call
 * carries `x-learnharness-whisper: 1` and no cross-site fetch metadata. This
 * is not user authentication; the desktop proxy capability still applies.
 */
import {
	WHISPER_NOT_READY_CODE,
	WHISPER_MAX_WAV_BYTES,
	defaultDictationEngine,
	isDictationLanguage,
	isWhisperDownloadTarget,
	whisperLanguage,
	type WhisperStatus,
} from "../../core/dictation.ts";
import { subscriptionRequestOrigin } from "../web-subscription-http.ts";
import {
	cancelWhisperDownload,
	defaultInstallDeps,
	startWhisperDownload,
	whisperInstallView,
} from "./install.ts";
import { whisperPaths } from "./manifest.ts";
import {
	WhisperNotReadyError,
	effectiveDictationChoice,
	syncWhisper,
	transcribeWithWhisper,
	whisperProcessView,
} from "./process.ts";

export const WHISPER_INTENT_HEADER = "x-learnharness-whisper";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function error(message: string, status: number, extra: Record<string, unknown> = {}) {
	return Response.json({ error: message, ...extra }, { status, headers: HEADERS });
}

function authorized(request: Request, method: "GET" | "POST"): boolean {
	const origin = subscriptionRequestOrigin(request);
	if (request.method !== method || !origin || request.headers.get(WHISPER_INTENT_HEADER) !== "1") return false;
	if (request.headers.get("sec-fetch-site") === "cross-site") return false;
	const supplied = request.headers.get("origin");
	return method === "GET" ? !supplied || supplied === origin : supplied === null || supplied === origin;
}

const FORBIDDEN = "Local Whisper controls require a same-origin LearnHarness request.";

export function whisperStatus(platform: string = process.platform): WhisperStatus {
	const choice = effectiveDictationChoice(platform);
	return {
		platformSupported: platform === "win32",
		defaultEngine: defaultDictationEngine(platform),
		engine: choice.engine,
		model: choice.model,
		...whisperInstallView(whisperPaths()),
		process: whisperProcessView(),
	};
}

export async function whisperStatusResponse(request: Request): Promise<Response> {
	if (!authorized(request, "GET")) return error(FORBIDDEN, 403);
	return Response.json(whisperStatus(), { headers: HEADERS });
}

export async function whisperDownloadResponse(request: Request): Promise<Response> {
	if (!authorized(request, "POST")) return error(FORBIDDEN, 403);
	const body = await request.json().catch(() => null) as { target?: unknown } | null;
	if (!isWhisperDownloadTarget(body?.target)) return error("Unknown download target.", 400);
	const started = startWhisperDownload(body.target, defaultInstallDeps(() => { void syncWhisper().catch(() => {}); }));
	if (!started.ok) return error(started.error, started.status);
	return Response.json(whisperStatus(), { status: 202, headers: HEADERS });
}

export async function whisperCancelResponse(request: Request): Promise<Response> {
	if (!authorized(request, "POST")) return error(FORBIDDEN, 403);
	cancelWhisperDownload();
	return Response.json(whisperStatus(), { headers: HEADERS });
}

/** POST audio/wav ?language=<dictation language> → { text }. */
export async function whisperTranscribeResponse(request: Request): Promise<Response> {
	if (!authorized(request, "POST")) return error(FORBIDDEN, 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "audio/wav") return error("Expected audio/wav.", 415);
	const language = new URL(request.url).searchParams.get("language");
	if (!isDictationLanguage(language)) return error("Unsupported dictation language.", 400);
	if (Number(request.headers.get("content-length")) > WHISPER_MAX_WAV_BYTES) return error("Recording is longer than 10 minutes.", 413);
	const wav = new Uint8Array(await request.arrayBuffer());
	if (wav.byteLength > WHISPER_MAX_WAV_BYTES) return error("Recording is longer than 10 minutes.", 413);
	if (wav.byteLength < 44) return error("Empty recording.", 400);
	try {
		const text = await transcribeWithWhisper(wav, whisperLanguage(language), request.signal);
		return Response.json({ text }, { headers: HEADERS });
	} catch (caught) {
		if (caught instanceof WhisperNotReadyError) return error(caught.message, 503, { code: WHISPER_NOT_READY_CODE, reason: caught.reason });
		return error(caught instanceof Error ? caught.message : "Whisper transcription failed.", 502);
	}
}
