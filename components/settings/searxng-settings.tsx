"use client";

/**
 * Settings → Agent → Tools: the app-managed SearXNG panel (blog review plan
 * M2, owner 2026-11-06). One switch turns local search on; the panel then
 * shows Docker Desktop's state (with Retry after starting it), the image
 * install (a pinned `docker pull`), the container this app runs while it is
 * open, and a test search.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SearxngStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { fetchSearxngStatus, installSearxng, retrySearxng, testSearxng, type SearxngTestResult } from "@/components/searxng-client";
import { SettingsRow, Toggle } from "./controls.tsx";

/** Poll fast while something is moving; otherwise stay quiet. */
function pollDelay(status: SearxngStatus | null): number | null {
	if (!status) return 2000;
	if (status.pull || status.process.phase === "starting") return 1000;
	return null;
}

export function useSearxngStatus(onChange?: (status: SearxngStatus) => void) {
	const [status, setStatus] = useState<SearxngStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const alive = useRef(true);
	const changed = useRef(onChange);
	changed.current = onChange;

	const refresh = useCallback(async (delayMs = 0) => {
		if (timer.current) {
			clearTimeout(timer.current);
			timer.current = null;
		}
		if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
		try {
			const next = await fetchSearxngStatus();
			if (!alive.current) return;
			setStatus(next);
			setError(null);
			changed.current?.(next);
			const delay = pollDelay(next);
			if (delay !== null) timer.current = setTimeout(() => void refresh(), delay);
		} catch (e) {
			if (!alive.current) return;
			setError(e instanceof Error ? e.message : "Could not load SearXNG status.");
		}
	}, []);

	useEffect(() => {
		alive.current = true;
		void refresh();
		return () => {
			alive.current = false;
			if (timer.current) clearTimeout(timer.current);
		};
	}, [refresh]);

	return { status, error, refresh, setStatus };
}

export function searxngProcessLabel(status: SearxngStatus): string {
	if (!status.enabled) return "Off";
	if (status.docker === "not-installed") return "Docker isn't installed";
	if (status.docker === "not-running") return "Docker Desktop isn't running";
	if (status.pull) return "Installing…";
	if (!status.image.installed) return "Not installed";
	const { phase, error } = status.process;
	if (phase === "running") return "Running";
	if (phase === "starting") return "Starting…";
	if (phase === "error") return `Error: ${error ?? "SearXNG stopped"}`;
	return "Stopped";
}

export function SearxngPanel({
	enabled,
	onEnabledChange,
	onStatusChange,
}: {
	/** The record's switch (agent.search.searxng.enabled). */
	enabled: boolean;
	onEnabledChange: (next: boolean) => void;
	/** Fires after each status read — the search row's reason line re-reads. */
	onStatusChange?: () => void;
}) {
	const { status, error, refresh, setStatus } = useSearxngStatus(onStatusChange);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [test, setTest] = useState<SearxngTestResult | null>(null);

	// The switch writes the settings record; the server converges after the
	// write — follow it.
	useEffect(() => {
		setTest(null);
		void refresh(400);
	}, [enabled, refresh]);

	const run = async (action: () => Promise<SearxngStatus>) => {
		setBusy(true);
		setActionError(null);
		try {
			setStatus(await action());
		} catch (e) {
			setActionError(e instanceof Error ? e.message : "Request failed.");
		} finally {
			setBusy(false);
			void refresh();
		}
	};
	const runTest = async () => {
		setBusy(true);
		setActionError(null);
		setTest(null);
		try {
			const result = await testSearxng();
			setTest(result);
			setStatus(result.status);
		} catch (e) {
			setActionError(e instanceof Error ? e.message : "Test search failed.");
		} finally {
			setBusy(false);
		}
	};

	const dockerProblem = status && status.enabled && status.docker !== "ready";
	const canRetry = status && status.enabled && (dockerProblem || status.process.phase === "error");

	return (
		<div className="flex flex-col gap-1.5" data-testid="searxng-panel">
			<SettingsRow
				label="Local search (SearXNG)"
				hint={`Runs in Docker while LearnHarness is open · ~${status?.image.approxSizeMb ?? 98} MB download`}
				testid="row-searxng"
			>
				<Toggle checked={enabled} label="Local search with SearXNG" onChange={onEnabledChange} />
			</SettingsRow>
			{enabled && (
				<>
					{!status && (
						<p className="px-1 text-xs text-muted-foreground" data-testid="searxng-loading">
							{error ?? "Checking Docker…"}
						</p>
					)}
					{status && (
						<div className="flex items-center justify-between gap-3 px-1">
							<p role="status" className="min-w-0 text-xs text-muted-foreground" data-testid="searxng-process">
								Status: {searxngProcessLabel(status)}
							</p>
							<span className="flex shrink-0 items-center gap-2">
								{status.docker === "ready" && !status.image.installed && !status.pull && (
									<Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void run(installSearxng)} data-testid="searxng-install">
										Install
									</Button>
								)}
								{canRetry && (
									<Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void run(retrySearxng)} data-testid="searxng-retry">
										Retry
									</Button>
								)}
								{status.process.phase === "running" && (
									<Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void runTest()} data-testid="searxng-test">
										Test search
									</Button>
								)}
							</span>
						</div>
					)}
					{status?.pull && (
						<p role="status" className="truncate px-1 text-xs text-muted-foreground" data-testid="searxng-pull-progress">
							Downloading: {status.pull.detail}
						</p>
					)}
					{status?.pullError && !status.pull && (
						<p role="alert" className="px-1 text-xs text-red-400" data-testid="searxng-pull-error">
							{status.pullError}
						</p>
					)}
					{actionError && (
						<p role="alert" className="px-1 text-xs text-red-400">
							{actionError}
						</p>
					)}
					{test && (
						<p role="status" className={test.ok ? "px-1 text-xs text-muted-foreground" : "px-1 text-xs text-red-400"} data-testid="searxng-test-result">
							{test.ok
								? `✓ ${test.count} result${test.count === 1 ? "" : "s"}${test.sample?.[0] ? ` — first: ${test.sample[0].title}` : ""}`
								: `Test failed: ${test.error}`}
						</p>
					)}
					<p className="px-1 text-[11px] leading-relaxed text-muted-foreground/70" data-testid="searxng-hint">
						Searches go to a SearXNG container on this machine, which asks public engines (Google, Bing, DuckDuckGo, …) for you —
						no API key or account. Docker Desktop must be running. When on, SearXNG is the default engine.
					</p>
				</>
			)}
		</div>
	);
}
