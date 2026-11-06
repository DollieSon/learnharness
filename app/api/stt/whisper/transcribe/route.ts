import { whisperTranscribeResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/** One dictation clip (audio/wav, 16 kHz mono PCM16) → { text } via local whisper-server. */
export async function POST(request: Request) {
	return whisperTranscribeResponse(request);
}
