import type { WhisperStatus } from "../../src/core/index.ts";

/** A /api/stt/whisper/status body. Defaults describe a non-Windows server
 *  (Deepgram is the default engine) with nothing installed. */
export function whisperStatusFixture(overrides: Partial<WhisperStatus> = {}): WhisperStatus {
	return {
		platformSupported: false,
		defaultEngine: "deepgram",
		engine: "deepgram",
		model: "large-v3-turbo",
		server: { installed: false, sizeBytes: 684_913_404 },
		models: [
			{ id: "base", label: "Base", sizeBytes: 147_951_465, installed: false },
			{ id: "small", label: "Small", sizeBytes: 487_601_967, installed: false },
			{ id: "large-v3-turbo", label: "Large v3 Turbo", sizeBytes: 1_624_555_275, installed: false },
		],
		download: null,
		downloadError: null,
		process: { phase: "stopped", model: null, error: null },
		...overrides,
	};
}
