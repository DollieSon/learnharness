"use client";

import { useContext } from "react";
import { CheckIcon, FileTextIcon, GlobeIcon, ShieldAlertIcon, TriangleAlertIcon } from "lucide-react";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { ChatActionsContext } from "@/components/chat";
import type {
	ArtifactPartProps,
	BlogHiddenReport,
	BlogResult,
	FactCheckResult,
	FactCheckVerdictKind,
} from "@/src/core";

/**
 * Blog review cards (blog review plan M3, owner 2026-11-06).
 *
 *   BlogJobCard / FactCheckJobCard — the dispatch boxes (live status via
 *     the jobs feed, the async-protocol idiom every job shares).
 *   BlogResultCard — the article link card: title, site, byline, the
 *     hidden-content warning when the scanner removed anything, the brief
 *     behind a disclosure, and the one-way "Share full text with the agent".
 *   FactCheckCard — the verdict list, omissions and related topics.
 *
 * Page-derived strings render as plain text (React escapes them) — never as
 * markdown or HTML, so a hostile page cannot inject links or markup.
 */

export function BlogJobCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="blog" />;
}

export function FactCheckJobCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="fact_check" />;
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

/** Only http(s) links become anchors; anything else renders as text. */
function SafeLink({ href, children }: { href: string; children: React.ReactNode }) {
	if (!/^https?:\/\//i.test(href)) return <span>{children}</span>;
	return (
		<a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline-offset-2 hover:underline">
			{children}
		</a>
	);
}

const HIDDEN_KIND_LABEL: Record<string, string> = {
	comment: "HTML comment",
	template: "template",
	noscript: "noscript",
	"hidden-attribute": "hidden element",
	"aria-hidden": "aria-hidden element",
	"inline-style": "hidden by inline style",
	"style-rule": "hidden by a stylesheet",
	"invisible-characters": "invisible characters",
	"computed-style": "hidden by page styles",
	"tiny-text": "tiny text",
	"off-screen": "off-screen text",
	clipped: "clipped text",
	"same-color": "text matching its background",
};

function HiddenWarning({ hidden }: { hidden: BlogHiddenReport }) {
	const count = hidden.findings.length;
	if (count === 0 && !hidden.reducedDetection) return null;
	const injection = hidden.judge?.verdict === "likely-injection";
	return (
		<div
			data-testid="blog-hidden-warning"
			className={`mt-3 rounded-lg border p-3 text-xs ${injection ? "border-red-500/40 bg-red-500/10" : "border-amber-500/40 bg-amber-500/10"}`}
		>
			{count > 0 && (
				<div className="flex items-start gap-2">
					{injection ? <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0 text-red-500" /> : <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />}
					<div className="min-w-0 flex-1">
						<div className="font-medium text-foreground">
							This page had {count} piece{count === 1 ? "" : "s"} of hidden content. It was removed before the agent read the page.
						</div>
						{hidden.judge && (
							<div className="mt-1" data-testid="blog-judge-verdict">
								AI check: <span className="font-medium">{hidden.judge.verdict === "likely-injection" ? "likely prompt injection" : hidden.judge.verdict}</span> — {hidden.judge.explanation}
							</div>
						)}
						{hidden.judgeSkipped && (
							<div className="mt-1 text-muted-foreground">The AI injection check is off (Settings → Agent).</div>
						)}
						<details className="mt-1">
							<summary className="cursor-pointer select-none text-muted-foreground">Show what was hidden</summary>
							<ul className="mt-1 flex max-h-48 flex-col gap-1 overflow-y-auto">
								{hidden.findings.map((f, i) => (
									<li key={i} className="break-words">
										<span className="text-muted-foreground">{HIDDEN_KIND_LABEL[f.kind] ?? f.kind}:</span> {f.text}
									</li>
								))}
							</ul>
						</details>
					</div>
				</div>
			)}
			{hidden.reducedDetection && (
				<div className={count > 0 ? "mt-2 text-muted-foreground" : "text-muted-foreground"}>
					Note: {hidden.reducedDetection}.
				</div>
			)}
		</div>
	);
}

function ShareButton({ jobId, result }: { jobId: string; result: BlogResult }) {
	const actions = useContext(ChatActionsContext);
	if (!actions?.shareBlogText || !result.fullText) return null;
	const state = actions.blogShareState?.(jobId) ?? "ready";
	if (state === "shared") {
		return (
			<span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="blog-text-shared">
				<CheckIcon className="size-3.5" />
				Full text shared with the agent
			</span>
		);
	}
	return (
		<button
			type="button"
			data-testid="blog-share-text"
			disabled={state === "blocked"}
			title={state === "blocked" ? "Available when the agent is idle and no question is open" : undefined}
			onClick={() => actions.shareBlogText?.(jobId)}
			className="flex items-center gap-1 rounded-sm border border-border bg-card px-2 py-0.5 text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-50"
		>
			<FileTextIcon className="size-3.5" />
			Share full text with the agent
		</button>
	);
}

export function BlogResultCard({ jobId, output }: { jobId: string; output: unknown }) {
	const result = output as BlogResult | undefined;
	if (!result || typeof result.url !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				The blog was read, but the result could not be displayed.
			</div>
		);
	}
	const url = result.finalUrl || result.url;
	if (result.error) {
		return (
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="blog-failed-card">
				<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Blog
					<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>
				</div>
				<div className="text-sm">
					Couldn&apos;t read <SafeLink href={url}>{hostOf(url) || "the link"}</SafeLink>: {result.error}
				</div>
				{result.hidden && <HiddenWarning hidden={result.hidden} />}
			</div>
		);
	}
	const byline = [result.author, result.published].filter(Boolean).join(" · ");
	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="blog-card">
			<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<GlobeIcon className="size-3.5" />
				{hostOf(url)}
			</div>
			<div className="mt-1 text-base font-medium">
				<SafeLink href={url}>{result.title || url}</SafeLink>
			</div>
			{byline && <div className="text-xs text-muted-foreground">{byline}</div>}
			<HiddenWarning hidden={result.hidden} />
			<details className="group mt-3 text-sm">
				<summary className="cursor-pointer select-none list-none text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
					<span className="group-open:hidden">view brief</span>
					<span className="hidden group-open:inline">hide brief</span>
				</summary>
				<div className="mt-2 flex flex-col gap-3" data-testid="blog-brief">
					<p className="m-0">
						<span className="font-medium">Thesis: </span>
						{result.thesis}
					</p>
					{result.outline.length > 0 && (
						<div>
							<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Outline</div>
							<ol className="m-0 list-decimal pl-5">
								{result.outline.map((s, i) => (
									<li key={i}>{s}</li>
								))}
							</ol>
						</div>
					)}
					<div>
						<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Claims</div>
						<ul className="m-0 flex flex-col gap-1 pl-0">
							{result.claims.map((c) => (
								<li key={c.id} className="list-none">
									{c.claim}
									{c.quote && <div className="border-l-2 pl-2 text-xs italic text-muted-foreground">“{c.quote}”</div>}
								</li>
							))}
						</ul>
					</div>
					{result.takeaways.length > 0 && (
						<div>
							<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Takeaways</div>
							<ul className="m-0 list-disc pl-5">
								{result.takeaways.map((t, i) => (
									<li key={i}>{t}</li>
								))}
							</ul>
						</div>
					)}
				</div>
			</details>
			<div className="mt-3 flex items-center gap-2 border-t pt-2">
				<ShareButton jobId={jobId} result={result} />
				{result.fullTextTruncated && <span className="text-xs text-muted-foreground">(long article — text is truncated)</span>}
			</div>
		</div>
	);
}

const VERDICT_STYLE: Record<FactCheckVerdictKind, { label: string; className: string }> = {
	supported: { label: "Supported", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
	wrong: { label: "Wrong", className: "bg-red-500/15 text-red-500" },
	misleading: { label: "Misleading", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
	unverifiable: { label: "Unverifiable", className: "bg-muted text-muted-foreground" },
};

export function FactCheckCard({ output }: { output: unknown }) {
	const result = output as FactCheckResult | undefined;
	if (!result || !Array.isArray(result.verdicts)) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				The fact-check finished, but the result could not be displayed.
			</div>
		);
	}
	if (result.error) {
		return (
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="fact-check-failed-card">
				<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Fact-check
					<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>
				</div>
				<div className="text-sm">{result.error}</div>
			</div>
		);
	}
	const counts = result.verdicts.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v.verdict]: (acc[v.verdict] ?? 0) + 1 }), {});
	return (
		<details data-testid="fact-check-card" className="group w-full rounded-xl border bg-card p-4 text-card-foreground" open>
			<summary className="flex cursor-pointer select-none list-none flex-wrap items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
				<span className="font-medium uppercase tracking-wide">Fact-check</span>
				<span className="truncate">{result.title || hostOf(result.url)}</span>
				{(Object.keys(VERDICT_STYLE) as FactCheckVerdictKind[])
					.filter((k) => counts[k])
					.map((k) => (
						<span key={k} className={`rounded px-1.5 py-0.5 ${VERDICT_STYLE[k].className}`}>
							{counts[k]} {VERDICT_STYLE[k].label.toLowerCase()}
						</span>
					))}
			</summary>
			<div className="mt-3 flex flex-col gap-3 text-sm">
				{result.summary && <p className="m-0">{result.summary}</p>}
				<ul className="m-0 flex flex-col gap-2 pl-0">
					{result.verdicts.map((v) => (
						<li key={v.claimId} className="list-none" data-testid="fact-check-verdict">
							<div className="flex items-start gap-2">
								<span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${VERDICT_STYLE[v.verdict].className}`}>
									{VERDICT_STYLE[v.verdict].label}
								</span>
								<span>{v.claim}</span>
							</div>
							{v.explanation && <div className="mt-0.5 pl-1 text-xs text-muted-foreground">{v.explanation}</div>}
							{v.sources.length > 0 && (
								<div className="mt-0.5 flex flex-wrap gap-x-3 pl-1 text-xs">
									{v.sources.map((s) => (
										<SafeLink key={s.url} href={s.url}>
											{s.title}
										</SafeLink>
									))}
								</div>
							)}
						</li>
					))}
				</ul>
				{result.omissions.length > 0 && (
					<div>
						<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">What it leaves out</div>
						<ul className="m-0 list-disc pl-5">
							{result.omissions.map((o, i) => (
								<li key={i}>{o}</li>
							))}
						</ul>
					</div>
				)}
				{result.savedSourceId && (
					<div className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="fact-check-saved">
						<CheckIcon className="size-3.5" />
						Adding the fact-checked write-up to your sources (Blog reviews)
					</div>
				)}
				{result.relatedTopics.length > 0 && (
					<div>
						<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Related topics</div>
						<div className="flex flex-wrap gap-1.5">
							{result.relatedTopics.map((t, i) => (
								<span key={i} className="rounded-full border px-2 py-0.5 text-xs">
									{t}
								</span>
							))}
						</div>
					</div>
				)}
			</div>
		</details>
	);
}
