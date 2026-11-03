/** Nova-3 monolingual language codes, including documented locale aliases.
 * Source: https://developers.deepgram.com/docs/models-languages-overview
 * Multilingual is a separate mode; its supported language set differs.
 */
const NOVA_3_LANGUAGES = [
	["Afrikaans", ["af", "af-ZA"]],
	["Arabic", ["ar", "ar-AE", "ar-SA", "ar-QA", "ar-KW", "ar-SY", "ar-LB", "ar-PS", "ar-JO", "ar-EG", "ar-SD", "ar-TD", "ar-MA", "ar-DZ", "ar-TN", "ar-IQ", "ar-IR"]],
	["Armenian", ["hy"]],
	["Assamese", ["as", "as-IN"]],
	["Belarusian", ["be"]],
	["Bengali", ["bn"]],
	["Bosnian", ["bs"]],
	["Bulgarian", ["bg"]],
	["Catalan", ["ca"]],
	["Chinese (Cantonese, Traditional)", ["zh-HK"]],
	["Chinese (Mandarin, Simplified)", ["zh", "zh-CN", "zh-Hans"]],
	["Chinese (Mandarin, Traditional)", ["zh-TW", "zh-Hant"]],
	["Croatian", ["hr"]],
	["Czech", ["cs", "cs-CZ"]],
	["Danish", ["da", "da-DK"]],
	["Dutch", ["nl"]],
	["English", ["en", "en-US", "en-AU", "en-GB", "en-IN", "en-NZ"]],
	["Estonian", ["et"]],
	["Finnish", ["fi"]],
	["Flemish", ["nl-BE"]],
	["French", ["fr", "fr-CA"]],
	["Georgian", ["ka", "ka-GE"]],
	["German", ["de"]],
	["German (Switzerland)", ["de-CH"]],
	["Greek", ["el"]],
	["Gujarati", ["gu", "gu-IN"]],
	["Hebrew", ["he"]],
	["Hindi", ["hi"]],
	["Hungarian", ["hu"]],
	["Indonesian", ["id"]],
	["Italian", ["it"]],
	["Japanese", ["ja"]],
	["Kannada", ["kn"]],
	["Kazakh", ["kk", "kk-KZ"]],
	["Korean", ["ko", "ko-KR"]],
	["Latvian", ["lv"]],
	["Lithuanian", ["lt"]],
	["Macedonian", ["mk"]],
	["Malay", ["ms"]],
	["Marathi", ["mr"]],
	["Mongolian", ["mn"]],
	["Nepali", ["ne"]],
	["Norwegian", ["no"]],
	["Pashto", ["ps", "ps-AF"]],
	["Persian", ["fa"]],
	["Polish", ["pl"]],
	["Portuguese", ["pt", "pt-BR", "pt-PT"]],
	["Punjabi", ["pa", "pa-IN"]],
	["Romanian", ["ro"]],
	["Russian", ["ru"]],
	["Serbian", ["sr"]],
	["Slovak", ["sk"]],
	["Slovenian", ["sl"]],
	["Spanish", ["es", "es-419"]],
	["Swedish", ["sv", "sv-SE"]],
	["Tagalog", ["tl"]],
	["Tamil", ["ta"]],
	["Telugu", ["te"]],
	["Thai", ["th", "th-TH"]],
	["Turkish", ["tr", "tr-TR"]],
	["Ukrainian", ["uk"]],
	["Urdu", ["ur"]],
	["Vietnamese", ["vi"]],
] as const;

export type DictationLanguage = "multi" | (typeof NOVA_3_LANGUAGES)[number][1][number];

export const DICTATION_LANGUAGES: readonly { code: DictationLanguage; label: string }[] = [
	{ code: "multi", label: "Multilingual" },
	...NOVA_3_LANGUAGES.flatMap(([name, codes]) =>
		codes.map((code, i) => ({ code, label: i === 0 ? name : `${name} (${code})` })),
	).sort((a, b) => a.label.localeCompare(b.label, "en")),
];

export function isDictationLanguage(value: unknown): value is DictationLanguage {
	return DICTATION_LANGUAGES.some(({ code }) => code === value);
}

/** Only language varies. Keep the owner's tuned streaming parameters. */
export function deepgramListenUrl(language: DictationLanguage): string {
	return "wss://api.deepgram.com/v1/listen" +
		"?model=nova-3&encoding=linear16&sample_rate=16000&channels=1" +
		"&smart_format=true&punctuate=true&endpointing=300" +
		`&language=${encodeURIComponent(language)}`;
}

// ─── Engines (local Whisper wave, 2026-11-03) ───────────────────────────────
// Owner decisions: Deepgram stays as a selectable engine beside a local
// whisper.cpp server that LearnHarness downloads and launches itself (Windows
// + CUDA only). A record without an engine resolves from the SERVER platform:
// Windows → local Whisper, everything else → Deepgram.

export const DICTATION_ENGINES = ["deepgram", "whisper-local"] as const;
export type DictationEngine = (typeof DICTATION_ENGINES)[number];

export function isDictationEngine(value: unknown): value is DictationEngine {
	return DICTATION_ENGINES.includes(value as DictationEngine);
}

/** The factory engine for a server running on `platform` (Node's process.platform). */
export function defaultDictationEngine(platform: string): DictationEngine {
	return platform === "win32" ? "whisper-local" : "deepgram";
}

/** The curated download list (owner: base, small, large-v3-turbo). */
export const WHISPER_MODELS = ["base", "small", "large-v3-turbo"] as const;
export type WhisperModelId = (typeof WHISPER_MODELS)[number];
export const DEFAULT_WHISPER_MODEL: WhisperModelId = "large-v3-turbo";

export function isWhisperModel(value: unknown): value is WhisperModelId {
	return WHISPER_MODELS.includes(value as WhisperModelId);
}

/** Hold-to-talk presses shorter than this are discarded untranscribed (owner). */
export const DICTATION_TAP_DISCARD_MS = 300;
/** Longest clip the local engine accepts: 10 minutes of 16 kHz mono PCM16. */
export const WHISPER_MAX_RECORDING_MS = 10 * 60_000;
export const WHISPER_SAMPLE_RATE = 16_000;
/** WAV header (44 bytes) + the longest accepted clip. */
export const WHISPER_MAX_WAV_BYTES = 44 + (WHISPER_MAX_RECORDING_MS / 1000) * WHISPER_SAMPLE_RATE * 2;

/** whisper.cpp's language table (g_lang, whisper.cpp b5454). */
const WHISPER_LANGUAGE_CODES = new Set([
	"en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it", "id", "hi",
	"fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la",
	"mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy",
	"ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be",
	"tg", "sd", "gu", "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl",
	"mg", "as", "tt", "haw", "ln", "ha", "ba", "jw", "su", "yue",
]);

/** The shared (Nova-3) language setting, mapped for Whisper (owner: reuse it):
 *  Multilingual → auto-detect, a locale → its base subtag (en-US → en), and
 *  anything Whisper lacks → auto-detect. */
export function whisperLanguage(language: DictationLanguage): string {
	if (language === "multi") return "auto";
	const base = language.split("-")[0]!.toLowerCase();
	return WHISPER_LANGUAGE_CODES.has(base) ? base : "auto";
}

/** Non-speech markers Whisper can still emit for silence or noise. */
const CAPS_TAG = /\[[A-Z][A-Z_]{2,}\]/g; // [BLANK_AUDIO], [NOISE]
const NON_SPEECH_TAG = /[[(]\s*(?:silence|music|noise|inaudible|applause|laughter|blank audio)\s*[\])]/gi;

/** Whisper's text with non-speech markers removed and whitespace collapsed. */
export function cleanWhisperText(text: string): string {
	return text.replace(CAPS_TAG, " ").replace(NON_SPEECH_TAG, " ").replace(/\s+/g, " ").trim();
}

/** What can be downloaded: the whisper-server build or one model. */
export type WhisperDownloadTarget = "server" | WhisperModelId;

export function isWhisperDownloadTarget(value: unknown): value is WhisperDownloadTarget {
	return value === "server" || isWhisperModel(value);
}

/** GET /api/stt/whisper/status — the Settings panel's whole view. */
export interface WhisperStatus {
	/** False off Windows: local Whisper cannot be installed there. */
	platformSupported: boolean;
	/** The engine an unset record resolves to on this server. */
	defaultEngine: DictationEngine;
	/** The effective engine (record value, else defaultEngine). */
	engine: DictationEngine;
	/** The effective model. */
	model: WhisperModelId;
	server: { installed: boolean; sizeBytes: number };
	models: { id: WhisperModelId; label: string; sizeBytes: number; installed: boolean }[];
	download: { target: WhisperDownloadTarget; phase: "downloading" | "verifying" | "extracting"; receivedBytes: number; totalBytes: number } | null;
	downloadError: { target: WhisperDownloadTarget; message: string } | null;
	process: { phase: "stopped" | "starting" | "running" | "error"; model: WhisperModelId | null; error: string | null };
}

/** The transcribe route's refusal when local Whisper cannot run yet. */
export const WHISPER_NOT_READY_CODE = "whisper_not_ready" as const;

/** Wrap captured PCM16 mono frames (the pcm-capture worklet's output) in a
 *  canonical 44-byte WAV header — what whisper-server reads. */
export function encodeWavPcm16(frames: readonly ArrayBuffer[], sampleRate: number = WHISPER_SAMPLE_RATE): Uint8Array {
	const dataBytes = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
	const out = new Uint8Array(44 + dataBytes);
	const view = new DataView(out.buffer);
	const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i); };
	ascii(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	ascii(36, "data");
	view.setUint32(40, dataBytes, true);
	let offset = 44;
	for (const frame of frames) {
		out.set(new Uint8Array(frame), offset);
		offset += frame.byteLength;
	}
	return out;
}
