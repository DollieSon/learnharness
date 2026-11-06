import { searxngStatusResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/** App-managed SearXNG: Docker, image and container status for Settings. */
export async function GET(request: Request) {
	return searxngStatusResponse(request);
}
