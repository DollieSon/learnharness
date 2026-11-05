import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * The URL guard for every page the agents read (blog review plan, M1,
 * owner 2026-11-06): agents fetch URLs that came from the web or from a
 * pasted link, so a fetch must never reach this machine, the home network,
 * or a cloud metadata endpoint — the app's own local API listens on
 * loopback, and a page (or a prompt-injected agent) could otherwise aim the
 * server at it.
 *
 *  - http(s) only.
 *  - The host is resolved and EVERY address must be public; IP literals are
 *    checked directly.
 *  - Redirects are followed manually (capped) and every hop is re-checked.
 *
 * Known limit (accepted): resolution and connection are separate steps, so
 * a DNS answer that changes between them (rebinding) is not caught here.
 *
 * Test seam: `urlGuardDeps.lookup` replaces DNS (tests never resolve real
 * names).
 */

export class UrlBlockedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UrlBlockedError";
	}
}

export interface ResolvedAddress {
	address: string;
	family: number;
}

export const urlGuardDeps: { lookup: (host: string) => Promise<ResolvedAddress[]> } = {
	lookup: (host) => dnsLookup(host, { all: true, verbatim: true }),
};

const BLOCKED = new BlockList();
// IPv4: "this" network, private, CGNAT, loopback, link-local (incl. cloud
// metadata 169.254.169.254), IETF protocol assignments, benchmarking,
// documentation, multicast, reserved, broadcast.
for (const [net, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	BLOCKED.addSubnet(net, prefix, "ipv4");
}
// IPv6: unspecified, loopback, unique-local, link-local, multicast,
// documentation, and NAT64 (which embeds an IPv4 address).
for (const [net, prefix] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
	["2001:db8::", 32],
	["64:ff9b::", 96],
] as const) {
	BLOCKED.addSubnet(net, prefix, "ipv6");
}

/** True when the address is a public unicast address (pure). IPv4-mapped
 *  IPv6 addresses are judged by their embedded IPv4 address. */
export function isPublicAddress(address: string): boolean {
	const bare = address.replace(/^\[|\]$/g, "");
	const family = isIP(bare);
	if (family === 0) return false;
	if (family === 6) {
		const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
		if (mapped) return isPublicAddress(mapped[1]!);
		return !BLOCKED.check(bare, "ipv6");
	}
	return !BLOCKED.check(bare, "ipv4");
}

/** Parse + scheme-check + resolve: throws UrlBlockedError unless the URL is
 *  http(s) and every address its host resolves to is public. */
export async function assertPublicUrl(raw: string | URL): Promise<URL> {
	let url: URL;
	try {
		url = new URL(String(raw));
	} catch {
		throw new UrlBlockedError(`invalid URL "${String(raw)}"`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new UrlBlockedError(`only http(s) URLs are allowed (got ${url.protocol})`);
	}
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (host === "" || /^localhost$/i.test(host) || /\.localhost$/i.test(host)) {
		throw new UrlBlockedError(`${url.hostname} is a local address — pages on this machine are not fetched`);
	}
	if (isIP(host) !== 0) {
		if (!isPublicAddress(host)) {
			throw new UrlBlockedError(`${url.hostname} is a private or local address — not fetched`);
		}
		return url;
	}
	let addresses: ResolvedAddress[];
	try {
		addresses = await urlGuardDeps.lookup(host);
	} catch (err) {
		throw new UrlBlockedError(`could not resolve ${host}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (addresses.length === 0) throw new UrlBlockedError(`could not resolve ${host}`);
	const bad = addresses.find((a) => !isPublicAddress(a.address));
	if (bad) {
		throw new UrlBlockedError(`${host} resolves to a private or local address (${bad.address}) — not fetched`);
	}
	return url;
}

const MAX_REDIRECTS = 5;

/** fetch() with the guard on the first URL and on every redirect hop.
 *  Returns the final response; `finalUrl` is the last URL requested. */
export async function guardedFetch(
	raw: string,
	init: RequestInit = {},
): Promise<{ response: Response; finalUrl: string }> {
	let current = await assertPublicUrl(raw);
	for (let hop = 0; ; hop++) {
		const response = await fetch(current.href, { ...init, redirect: "manual" });
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			if (hop >= MAX_REDIRECTS) throw new UrlBlockedError(`too many redirects (more than ${MAX_REDIRECTS})`);
			// Drain the redirect body so the connection can be reused.
			await response.body?.cancel().catch(() => {});
			current = await assertPublicUrl(new URL(location, current));
			continue;
		}
		return { response, finalUrl: current.href };
	}
}
