import { searxngRetryResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/** Re-check Docker and (re)start SearXNG — e.g. after starting Docker Desktop. */
export async function POST(request: Request) {
	return searxngRetryResponse(request);
}
