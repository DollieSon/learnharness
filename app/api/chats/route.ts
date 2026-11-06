import { BLOG_TITLE_PREFIX, chainsForSelection, formatChainLine } from "@/src/core";
import { newGraphContextMessage, type GraphContextPick } from "@/src/core";
import { compactionInFlight, createChat, isTurnRunning, listChats, readSettingsRecord, stores, titleFromPrompt } from "@/src/server";
import type { ChatListItem } from "@/src/core";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + live liveness — a running turn marks the session busy
 *  (contracts.ts ChatListItem; the store can't see liveness, the route is
 *  the merge point). Owner, minimal-color round: background jobs NO LONGER
 *  count — the sidebar's Background agents section is their channel now
 *  (a running spinner per row would double-signal them), so busy means
 *  exactly "a teach turn is in flight". */
export async function GET() {
	const chats: ChatListItem[] = listChats().map((c) => ({
		...c,
		busy: isTurnRunning(c.id),
		compacting: compactionInFlight(c.id),
	}));
	return Response.json({ chats });
}

/** The site name of a blog URL, or null when it isn't an http(s) URL. */
function blogSiteOf(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	try {
		const url = new URL(raw.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url.hostname.replace(/^www\./, "") || null;
	} catch {
		return null;
	}
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown; kind?: unknown; graphContext?: unknown; url?: unknown };
	const title = typeof body.title === "string" ? body.title : "";
	// Practice sessions (owner, 2026-10-04): kind "practice" marks the
	// record — the practice agent + its tools from turn 1, no extraction.
	// Blog reviews (blog review plan M4): kind "blog" requires the article's
	// http(s) URL; the title starts as "Blog · <site>" and the blog job
	// renames it to the article's title when the brief arrives.
	const kind = body.kind === "practice" ? ("practice" as const) : body.kind === "blog" ? ("blog" as const) : undefined;
	let blogSite: string | null = null;
	if (kind === "blog") {
		blogSite = blogSiteOf(body.url);
		if (!blogSite) return Response.json({ error: "A blog review needs an http(s) article URL." }, { status: 400 });
	}
	const chat = createChat(blogSite ? `${BLOG_TITLE_PREFIX}${blogSite}` : titleFromPrompt(title || "Untitled session"), kind);
	// PER-SESSION MODELS (owner, 2026-09-28): a session owns its model +
	// thinking level from birth — stamped verbatim from the STRONG slot,
	// the new-session default. From here the strong slot never reaches
	// this session again: in-session picks write the session's own record
	// (PUT /api/chats/:id/settings). No strong slot configured (fresh BYOK
	// boot) → no stamp; the turn gate's 503 models_not_configured envelope
	// refuses honestly until the setup flow fills the slot.
	const strong = readSettingsRecord()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}
	// The session's map context (owner, 2026-10-04): the picked
	// propositions ride the CREATION — message[0] is a graph-context
	// marker (a separate custom message BEFORE the learner's first user
	// message), carrying the picks plus the reasoning chains among them.
	// The picks carry their own name/statement (what the learner saw at
	// pick time); the chains derive from the CURRENT graph snapshot.
	const rawPicks = (body.graphContext as { propositions?: unknown } | undefined)?.propositions;
	const picks: GraphContextPick[] = Array.isArray(rawPicks)
		? rawPicks
				.filter(
						(p): p is GraphContextPick =>
							typeof p === "object" &&
							p !== null &&
							typeof (p as GraphContextPick).id === "string" &&
							typeof (p as GraphContextPick).name === "string" &&
							typeof (p as GraphContextPick).statement === "string",
					)
					.slice(0, 64)
			: [];
	if (picks.length > 0) {
		const byId = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
		const pickedNodes = picks.map((p) => byId.get(p.id)).filter((n) => n !== undefined);
		const chainLines = chainsForSelection(pickedNodes, stores.graphStore.readChains()).map((c) =>
			formatChainLine(c, Object.fromEntries(byId)),
		);
		stores.chatStore.saveMessages(chat.id, [newGraphContextMessage(picks, chainLines)]);
	}
	return Response.json({ id: chat.id, title: chat.title });
}
