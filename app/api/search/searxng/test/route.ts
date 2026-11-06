import { searxngTestResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/** Run one test search through the running SearXNG. */
export async function POST(request: Request) {
	return searxngTestResponse(request);
}
