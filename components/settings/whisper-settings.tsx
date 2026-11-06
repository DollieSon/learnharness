"use client";

/**
 * Settings → Providers → Dictation: the engine choice and the local Whisper
 * panel (local Whisper wave, 2026-11-03). The panel downloads the pinned
 * whisper.cpp CUDA build and a curated model, shows progress, and reports
 * the server process LearnHarness runs. Windows only; elsewhere the Local
 * Whisper option is shown disabled.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type DictationEngine,
	type WhisperDownloadTarget,
	type WhisperModelId,
	type WhisperStatus,
} from "@/src/core";
import { Button } from "@/components/ui/button";
import { useDictationActive } from "@/components/dictation-state";
import { useDictationLanguage } from "@/components/dictation-preference";
import { cancelWhisperDownload, fetchWhisperStatus, startWhisperDownload } from "@/components/whisper-client";
import { SettingsRow, ThinSelect } from "./controls";

const megabytes = (bytes: number) => `${Math.round(bytes / 1e6).toLocaleString("en")} MB`;

/** Poll fast while something is moving, slowly otherwise. */
function pollDelay(status: WhisperStatus | null): number | null {
	if (!status) return 2000;
	if (status.download || status.process.phase === "starting") return 1000;
	return null;
}

export function useWhisperStatus() {
	const [status, setStatus] = useState<WhisperStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const alive = useRef(true);

	const refresh = useCallback(async () => {
		if (timer.current) { clearTimeout(timer.current); timer.current = null; }
		try {
			const next = await fetchWhisperStatus();
			if (!alive.current) return;
			setStatus(next);
			setError(null);
			const delay = pollDelay(next);
			if (delay !== null) timer.current = setTimeout(() => void refresh(), delay);
		} catch (e) {
			if (!alive.current) return;
			setError(e instanceof Error ? e.message : "Could not load local Whisper status.");
		}
	}, []);

	useEffect(() => {
		alive.current = true;
		void refresh();
		return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); };
	}, [refresh]);

	return { status, error, refresh, setStatus };
}

type WhisperStatusState = ReturnType<typeof useWhisperStatus>;

/** The effective engine: the saved choice, else the server platform's default. */
export function effectiveEngine(saved: DictationEngine | undefined, status: WhisperStatus | null): DictationEngine | undefined {
	return saved ?? status?.defaultEngine;
}

export function DictationEngineSetting({ whisper }: { whisper: WhisperStatusState }) {
	const preference = useDictationLanguage();
	const active = useDictationActive();
	const engine = effectiveEngine(preference.engine, whisper.status);
	const supported = whisper.status?.platformSupported ?? false;
	const pick = async (next: string) => {
		if (next !== "deepgram" && next !== "whisper-local") return;
		await preference.saveSection({ engine: next });
		// The server converges after the write; follow its process status.
		void whisper.refresh();
	};
	return <SettingsRow label="Engine" testid="row-dictation-engine" dimmed={active}>
		<ThinSelect
			value={engine ?? ""}
			onChange={(next) => void pick(next)}
			ariaLabel="Dictation engine"
			testid="dictation-engine"
			disabled={active || preference.saving || engine === undefined}
		>
			{engine === undefined && <option value="">—</option>}
			<option value="whisper-local" disabled={!supported}>{supported ? "Local Whisper" : "Local Whisper (Windows only)"}</option>
			<option value="deepgram">Deepgram</option>
		</ThinSelect>
	</SettingsRow>;
}

function processLabel(status: WhisperStatus, labelOf: (id: WhisperModelId) => string): string {
	const { phase, model, error } = status.process;
	if (phase === "running") return `Running · ${model ? labelOf(model) : ""}`;
	if (phase === "starting") return `Starting${model ? ` · loading ${labelOf(model)}` : ""}…`;
	if (phase === "error") return `Error: ${error ?? "whisper-server stopped"}`;
	if (!status.server.installed) return "Not installed";
	if (!status.models.find((m) => m.id === status.model)?.installed) return "Model not downloaded";
	return "Stopped";
}

export function WhisperPanel({ whisper }: { whisper: WhisperStatusState }) {
	const { status, error, refresh, setStatus } = whisper;
	const preference = useDictationLanguage();
	const active = useDictationActive();
	const [actionError, setActionError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	if (!status) {
		return <p className="px-1 text-xs text-muted-foreground" data-testid="whisper-panel">{error ?? "Loading local Whisper status…"}</p>;
	}
	const labelOf = (id: WhisperModelId) => status.models.find((m) => m.id === id)?.label ?? id;
	const selected = status.models.find((m) => m.id === status.model);
	const download = status.download;

	const run = async (action: () => Promise<WhisperStatus>) => {
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
	const get = (target: WhisperDownloadTarget) => run(() => startWhisperDownload(target));
	const pickModel = async (next: string) => {
		const model = status.models.find((m) => m.id === next);
		if (!model) return;
		await preference.saveSection({ whisperModel: model.id });
		void refresh();
	};

	return <div className="flex flex-col gap-2" data-testid="whisper-panel">
		<SettingsRow
			label="Whisper server"
			hint={`whisper.cpp, NVIDIA CUDA 12.4 · ${megabytes(status.server.sizeBytes)}`}
			testid="row-whisper-server"
		>
			{status.server.installed
				? <span className="text-xs text-muted-foreground" data-testid="whisper-server-installed">Installed</span>
				: <Button type="button" size="xs" variant="outline" disabled={busy || !!download} onClick={() => void get("server")} data-testid="whisper-download-server">Download</Button>}
		</SettingsRow>
		<SettingsRow label="Model" hint={selected ? `${megabytes(selected.sizeBytes)}${selected.installed ? " · downloaded" : ""}` : undefined} testid="row-whisper-model" dimmed={active}>
			<div className="flex items-center gap-2">
				{selected && !selected.installed && <Button type="button" size="xs" variant="outline" disabled={busy || !!download} onClick={() => void get(selected.id)} data-testid="whisper-download-model">Download</Button>}
				<ThinSelect value={status.model} onChange={(next) => void pickModel(next)} ariaLabel="Whisper model" testid="whisper-model" disabled={active || preference.saving}>
					{status.models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.installed ? " ✓" : ""}</option>)}
				</ThinSelect>
			</div>
		</SettingsRow>
		{download && <div className="flex items-center justify-between gap-3 px-1" data-testid="whisper-download-progress">
			<span role="status" className="text-xs text-muted-foreground">
				{download.phase === "downloading"
					? `Downloading ${download.target === "server" ? "Whisper server" : labelOf(download.target)}… ${Math.floor((download.receivedBytes / download.totalBytes) * 100)}% (${megabytes(download.receivedBytes)} of ${megabytes(download.totalBytes)})`
					: download.phase === "verifying" ? "Verifying checksum…" : "Unpacking…"}
			</span>
			<Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void run(cancelWhisperDownload)} data-testid="whisper-download-cancel">Cancel</Button>
		</div>}
		{status.downloadError && !download && <p role="alert" className="px-1 text-xs text-red-400" data-testid="whisper-download-error">
			Download failed: {status.downloadError.message}
		</p>}
		{actionError && <p role="alert" className="px-1 text-xs text-red-400">{actionError}</p>}
		<p role="status" className="px-1 text-xs text-muted-foreground" data-testid="whisper-process">Status: {processLabel(status, labelOf)}</p>
		<p className="px-1 text-[11px] leading-relaxed text-muted-foreground/70" data-testid="whisper-setup-hint">
			Runs whisper.cpp on your NVIDIA GPU while LearnHarness is open. Audio never leaves this machine. Hold Ctrl+Space to talk, or press Ctrl+D to start and stop.
		</p>
	</div>;
}
