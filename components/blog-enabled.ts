"use client";

import { useEffect, useState } from "react";
import { onSettingsSaved } from "@/components/settings-signal";

/**
 * Is the blog tool on? (blog review plan M4, owner 2026-11-06): with
 * `Tool · blog` off, the blog entry points (home Blog mode, sidebar New
 * blog review button and Blog filter) are hidden. Absent key = on (the
 * toggle discipline). Starts true so nothing flickers away on load; a
 * failed read keeps the default.
 */
export function blogEnabledFrom(settings: unknown): boolean {
	const tools = (settings as { agent?: { tools?: Record<string, unknown> } } | null | undefined)?.agent?.tools;
	return tools?.blog !== false;
}

export function useBlogEnabled(): boolean {
	const [enabled, setEnabled] = useState(true);
	useEffect(() => {
		let alive = true;
		const read = async () => {
			try {
				const res = await fetch("/api/settings");
				if (!res.ok) return;
				const body = (await res.json()) as { settings?: unknown };
				if (alive) setEnabled(blogEnabledFrom(body.settings));
			} catch {
				/* keep the last known value */
			}
		};
		void read();
		const stop = onSettingsSaved((section) => {
			if (section === "agent") void read();
		});
		return () => {
			alive = false;
			stop();
		};
	}, []);
	return enabled;
}

/** The article URL a learner typed, normalized — or null when it isn't an
 *  http(s) link (a bare "example.com/post" gets https://). Pure. */
export function normalizeArticleUrl(raw: string): string | null {
	const text = raw.trim();
	if (!text || /\s/.test(text)) return null;
	const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
	try {
		const url = new URL(candidate);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (!url.hostname.includes(".")) return null;
		return url.href;
	} catch {
		return null;
	}
}
