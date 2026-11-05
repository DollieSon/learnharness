import { parseHTML } from "linkedom";

/**
 * The hidden-content scanner (blog review plan, M1, owner 2026-11-06): a
 * RULE-BASED pass (no AI, no tokens) that finds page content a human
 * reader cannot see — the classic carrier for prompt injection aimed at an
 * AI reading the page — REMOVES it before any agent sees the page, and
 * reports what it removed so the learner can be warned.
 *
 * Two passes:
 *  - `scanStaticHtml` (any HTML, no browser): comments, `hidden` /
 *    `aria-hidden` elements, hiding inline styles, simple hiding rules from
 *    the page's own <style> blocks (rules inside @media/@supports are
 *    skipped — they hide content only on some screens), <template> /
 *    <noscript>, and invisible characters (zero-width, bidi controls, and
 *    Unicode TAG characters — decoded, since "ASCII smuggling" hides whole
 *    sentences in them). External stylesheets are invisible to this pass.
 *  - `RENDERED_SCAN_SCRIPT` (evaluated inside the local browser after the
 *    page renders): computed styles catch what external CSS hides —
 *    display/visibility/opacity, tiny text, off-screen and clipped boxes,
 *    and text the same colour as its background. Collapsed <details>
 *    content is NOT flagged (the reader can open it).
 *
 * Findings are presentation data for the warning card: kind + the hidden
 * text (whitespace-collapsed, capped). Empty hidden elements are removed
 * silently.
 */

export type HiddenFindingKind =
	| "comment"
	| "hidden-attribute"
	| "aria-hidden"
	| "inline-style"
	| "style-rule"
	| "template"
	| "noscript"
	| "invisible-characters"
	| "computed-style"
	| "tiny-text"
	| "off-screen"
	| "clipped"
	| "same-color";

export interface HiddenFinding {
	kind: HiddenFindingKind;
	text: string;
}

export interface ScanResult {
	html: string;
	findings: HiddenFinding[];
}

const MAX_FINDING_CHARS = 500;
const MAX_FINDINGS = 200;

export function normalizeFindingText(raw: string): string {
	const text = raw.replace(/\s+/g, " ").trim();
	return text.length > MAX_FINDING_CHARS ? `${text.slice(0, MAX_FINDING_CHARS)}…` : text;
}

/** Inline-style declarations that hide an element (pure, exported for tests). */
export function styleHides(style: string): boolean {
	const s = style.toLowerCase().replace(/\s+/g, "");
	return (
		/(^|;)display:none(!important)?(;|$)/.test(s) ||
		/(^|;)visibility:(hidden|collapse)(!important)?(;|$)/.test(s) ||
		/(^|;)opacity:0*(\.0+)?(!important)?(;|$)/.test(s) ||
		/(^|;)font-size:0(\.0+)?(px|pt|em|rem|%)?(!important)?(;|$)/.test(s) ||
		/(^|;)font-size:(0?\.\d+|1)(px|pt)(!important)?(;|$)/.test(s) ||
		/(^|;)(left|top|right|bottom|text-indent|margin-left|margin-top):-\d{3,}/.test(s) ||
		/(^|;)clip:rect\(0(px)?,?0(px)?,?0(px)?,?0(px)?\)/.test(s) ||
		/(^|;)clip-path:inset\(50%\)/.test(s) ||
		/(^|;)transform:scale\(0\)/.test(s)
	);
}

/** Zero-width, bidi-control and word-joiner characters (soft hyphens are
 *  ordinary typography and left alone). */
const INVISIBLE_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
/** Unicode TAG block (U+E0000–U+E007F): invisible, maps 1:1 onto ASCII. */
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;

/** Strip invisible characters from one string; returns what was hidden
 *  (decoded TAG text, or a count) or null when nothing was there. */
export function stripInvisible(text: string): { clean: string; hidden: string | null } {
	const tags = text.match(TAG_CHARS);
	const invisible = text.match(INVISIBLE_CHARS);
	if (!tags && !invisible) return { clean: text, hidden: null };
	const parts: string[] = [];
	if (tags) {
		const decoded = tags
			.map((c) => String.fromCharCode(c.codePointAt(0)! - 0xe0000))
			.join("")
			.replace(/[\x00-\x1f\x7f]/g, "");
		parts.push(decoded.trim() ? `hidden tag text: "${decoded.trim()}"` : `${tags.length} tag characters`);
	}
	if (invisible) parts.push(`${invisible.length} zero-width/bidi characters`);
	return { clean: text.replace(TAG_CHARS, "").replace(INVISIBLE_CHARS, ""), hidden: parts.join("; ") };
}

/** The simple top-level rules of a stylesheet whose declarations hide
 *  (pure, exported for tests). Rules nested in at-rule blocks are skipped. */
export function hidingSelectors(css: string): string[] {
	// Drop comments, then every at-rule block (brace-matched).
	let src = css.replace(/\/\*[\s\S]*?\*\//g, "");
	let out = "";
	for (let i = 0; i < src.length; i++) {
		if (src[i] === "@") {
			const open = src.indexOf("{", i);
			const semi = src.indexOf(";", i);
			if (open === -1 || (semi !== -1 && semi < open)) {
				i = semi === -1 ? src.length : semi; // @import …; style at-rule
				continue;
			}
			let depth = 0;
			let j = open;
			for (; j < src.length; j++) {
				if (src[j] === "{") depth++;
				else if (src[j] === "}" && --depth === 0) break;
			}
			i = j;
			continue;
		}
		out += src[i];
	}
	src = out;
	const selectors: string[] = [];
	for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		if (styleHides(m[2]!)) {
			for (const sel of m[1]!.split(",")) {
				const s = sel.trim();
				if (s) selectors.push(s);
			}
		}
	}
	return selectors;
}

type LNode = {
	nodeType: number;
	nodeName: string;
	parentNode: LNode | null;
	childNodes: ArrayLike<LNode>;
	textContent: string | null;
	nodeValue?: string | null;
	remove?: () => void;
	getAttribute?: (name: string) => string | null;
	hasAttribute?: (name: string) => boolean;
};

/** Static pass — see the module doc. Never throws on bad HTML (linkedom is
 *  forgiving); returns the cleaned document HTML and the findings. */
export function scanStaticHtml(html: string): ScanResult {
	const { document } = parseHTML(html);
	const findings: HiddenFinding[] = [];
	const record = (kind: HiddenFindingKind, raw: string | null | undefined) => {
		const text = normalizeFindingText(raw ?? "");
		if (!text || findings.length >= MAX_FINDINGS) return;
		if (kind === "comment" && !/[a-z]{3,}/i.test(text)) return; // build-tool noise
		findings.push({ kind, text });
	};
	const removeEl = (el: LNode) => {
		if (el.remove) el.remove();
		else el.parentNode && (el.parentNode as unknown as { removeChild(n: LNode): void }).removeChild(el);
	};

	// 1. Comments + invisible characters in text (one tree walk).
	const comments: LNode[] = [];
	const walk = (node: LNode) => {
		for (const child of Array.from(node.childNodes)) {
			if (child.nodeType === 8) comments.push(child);
			else if (child.nodeType === 3 && child.nodeValue) {
				const parentName = child.parentNode?.nodeName?.toLowerCase();
				if (parentName === "script" || parentName === "style") continue;
				const { clean, hidden } = stripInvisible(child.nodeValue);
				if (hidden) {
					record("invisible-characters", hidden);
					child.nodeValue = clean;
				}
			} else if (child.nodeType === 1) walk(child);
		}
	};
	walk(document as unknown as LNode);
	for (const c of comments) {
		record("comment", c.nodeValue ?? c.textContent);
		removeEl(c);
	}

	// 2. Hidden elements: collect first, then remove outermost-only.
	const marked = new Set<LNode>();
	const mark = (kind: HiddenFindingKind, el: LNode) => {
		for (let p = el.parentNode; p; p = p.parentNode) if (marked.has(p)) return;
		marked.add(el);
		record(kind, el.textContent);
	};
	const q = (sel: string): LNode[] => {
		try {
			return Array.from(document.querySelectorAll(sel)) as unknown as LNode[];
		} catch {
			return []; // selector linkedom cannot parse
		}
	};
	for (const el of q("template")) mark("template", el);
	for (const el of q("noscript")) mark("noscript", el);
	for (const el of q("[hidden]")) mark("hidden-attribute", el);
	for (const el of q('[aria-hidden="true"]')) mark("aria-hidden", el);
	for (const el of q("[style]")) if (styleHides(el.getAttribute?.("style") ?? "")) mark("inline-style", el);
	for (const style of q("style")) {
		for (const sel of hidingSelectors(style.textContent ?? "")) {
			for (const el of q(sel)) {
				const name = el.nodeName.toLowerCase();
				if (name === "html" || name === "body" || name === "head") continue;
				mark("style-rule", el);
			}
		}
	}
	// Keep parents before children so ancestry checks above stay valid.
	for (const el of marked) removeEl(el);

	return { html: document.toString(), findings };
}

/**
 * The in-browser pass (see the module doc), as a PLAIN STRING: evaluated
 * with page.evaluate(string), so no build-tool helpers leak into the page.
 * Returns { html, findings } with the hidden elements already removed.
 */
export const RENDERED_SCAN_SCRIPT = `(() => {
	const MAX = ${MAX_FINDING_CHARS};
	const LIMIT = ${MAX_FINDINGS};
	const findings = [];
	const norm = (s) => { const t = (s || "").replace(/\\s+/g, " ").trim(); return t.length > MAX ? t.slice(0, MAX) + "…" : t; };
	const parse = (c) => {
		const m = /rgba?\\(([^)]+)\\)/.exec(c || "");
		if (!m) return null;
		const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number);
		return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
	};
	const bgOf = (el) => {
		for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
			const cs = getComputedStyle(n);
			if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
			const c = parse(cs.backgroundColor);
			if (c && c.a > 0.9) return c;
		}
		return { r: 255, g: 255, b: 255, a: 1 };
	};
	const near = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 24;
	const ownText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && /[A-Za-z0-9]{2,}/.test(n.nodeValue || ""));
	const root = document.documentElement;
	const docW = Math.max(root.scrollWidth, innerWidth);
	const docH = Math.max(root.scrollHeight, innerHeight);
	const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "BR", "IMG", "SVG", "PATH"]);
	const hidden = [];
	const all = document.body ? document.body.querySelectorAll("*") : [];
	for (const el of all) {
		if (skip.has(el.tagName.toUpperCase())) continue;
		if (el.closest("[data-lh-hidden]")) continue;
		const closedDetails = el.closest("details:not([open])");
		if (closedDetails && !el.closest("summary")) continue;
		const text = norm(el.textContent);
		if (!text) continue;
		const cs = getComputedStyle(el);
		let kind = null;
		if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || parseFloat(cs.opacity) < 0.05) kind = "computed-style";
		else if (parseFloat(cs.fontSize) < 2) kind = "tiny-text";
		else {
			const r = el.getBoundingClientRect();
			const left = r.left + scrollX, top = r.top + scrollY;
			if ((r.width > 0 || r.height > 0) && (left + r.width <= 0 || top + r.height <= 0 || left >= docW || top >= docH)) kind = "off-screen";
			else if ((cs.clip && /^rect\\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\\)/.test(cs.clip)) || /inset\\(50%\\)/.test(cs.clipPath || "") || (r.width <= 1 && r.height <= 1 && cs.overflow === "hidden")) kind = "clipped";
			else if (ownText(el)) {
				const fg = parse(cs.color);
				if (fg && fg.a < 0.1) kind = "same-color";
				else if (fg) { const bg = bgOf(el); if (bg && near(fg, bg)) kind = "same-color"; }
			}
		}
		if (kind) {
			el.setAttribute("data-lh-hidden", "");
			hidden.push(el);
			if (findings.length < LIMIT) findings.push({ kind, text });
		}
	}
	for (const el of hidden) el.remove();
	return { html: "<!doctype html>" + root.outerHTML, findings };
})()`;

/** Merge findings from the two passes, dropping exact duplicates. */
export function mergeFindings(...lists: HiddenFinding[][]): HiddenFinding[] {
	const seen = new Set<string>();
	const out: HiddenFinding[] = [];
	for (const list of lists) {
		for (const f of list) {
			const key = `${f.kind}\u0000${f.text}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(f);
		}
	}
	return out.slice(0, MAX_FINDINGS);
}
