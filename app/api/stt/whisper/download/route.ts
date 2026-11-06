import { whisperDownloadResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/** Start downloading the pinned whisper-server build or one model: { target }. */
export async function POST(request: Request) {
	return whisperDownloadResponse(request);
}
