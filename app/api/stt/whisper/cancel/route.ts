import { whisperCancelResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/** Cancel the running local Whisper download, if any. */
export async function POST(request: Request) {
	return whisperCancelResponse(request);
}
