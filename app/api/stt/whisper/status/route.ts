import { whisperStatusResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/** Local Whisper install/download/process status for Settings. */
export async function GET(request: Request) {
	return whisperStatusResponse(request);
}
