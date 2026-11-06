import { searxngInstallResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/** Start pulling the pinned SearXNG image (Settings → Install). */
export async function POST(request: Request) {
	return searxngInstallResponse(request);
}
