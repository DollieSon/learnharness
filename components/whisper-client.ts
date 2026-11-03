"use client";

/**
 * The window's side of local Whisper (local Whisper wave, 2026-11-03): the
 * status/download/transcribe calls, each carrying the same-origin intent
 * header the server requires. The window never talks to whisper-server.
 */
import {
	WHISPER_NOT_READY_CODE,
	type DictationEngine,
	type DictationLanguage,
	type WhisperDownloadTarget,
	type WhisperStatus,
} from "@/src/core";

export const WHISPER_HEADERS = { "x-learnharness-whisper": "1" } as const;

/** The client-authored line for "Whisper isn't installed/selected/running";
 *  the errored Dictate button deep-links Settings → Providers on click. */
export const WHISPER_NOT_READY_PREFIX = "Local Whisper: ";

export class WhisperNotReadyError extends Error {}

async function readError(response: Response): Promise<string> {
	const body = await response.json().catch(() => ({})) as { error?: unknown };
	return typeof body.error === "string" ? body.error : `Whisper request failed (HTTP ${response.status})`;
}

export async function fetchWhisperStatus(signal?: AbortSignal): Promise<WhisperStatus> {
	const response = await fetch("/api/stt/whisper/status", { cache: "no-store", headers: WHISPER_HEADERS, signal });
	if (!response.ok) throw new Error(await readError(response));
	return await response.json() as WhisperStatus;
}

export async function startWhisperDownload(target: WhisperDownloadTarget): Promise<WhisperStatus> {
	const response = await fetch("/api/stt/whisper/download", {
		method: "POST", headers: { ...WHISPER_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ target }),
	});
	if (!response.ok) throw new Error(await readError(response));
	return await response.json() as WhisperStatus;
}

export async function cancelWhisperDownload(): Promise<WhisperStatus> {
	const response = await fetch("/api/stt/whisper/cancel", { method: "POST", headers: WHISPER_HEADERS });
	if (!response.ok) throw new Error(await readError(response));
	return await response.json() as WhisperStatus;
}

/** One clip → text. A not-ready refusal becomes WhisperNotReadyError. */
export async function transcribeWav(wav: Uint8Array, language: DictationLanguage, signal?: AbortSignal): Promise<string> {
	const response = await fetch(`/api/stt/whisper/transcribe?language=${encodeURIComponent(language)}`, {
		method: "POST", headers: { ...WHISPER_HEADERS, "Content-Type": "audio/wav" }, body: new Blob([new Uint8Array(wav)], { type: "audio/wav" }), signal,
	});
	if (response.ok) {
		const body = await response.json() as { text?: unknown };
		return typeof body.text === "string" ? body.text : "";
	}
	const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
	const message = typeof body.error === "string" ? body.error : `Whisper request failed (HTTP ${response.status})`;
	if (body.code === WHISPER_NOT_READY_CODE) throw new WhisperNotReadyError(WHISPER_NOT_READY_PREFIX + message);
	throw new Error(message);
}

/** The server platform's default engine — fixed for the server's lifetime, so cached. */
let defaultEngine: Promise<DictationEngine> | null = null;
export function serverDefaultEngine(): Promise<DictationEngine> {
	defaultEngine ??= fetchWhisperStatus().then((status) => status.defaultEngine).catch((error: unknown) => {
		defaultEngine = null; // retry next time
		throw error;
	});
	return defaultEngine;
}

/** Test seam. */
export function resetServerDefaultEngine(): void { defaultEngine = null; }
