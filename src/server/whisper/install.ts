/**
 * Local Whisper installation: what is on disk, and the one-at-a-time
 * download manager behind Settings → Providers → Dictation.
 *
 * A download streams to a scratch file while hashing; only a file whose
 * SHA-256 matches the pinned digest is moved into place. The server zip is
 * unpacked with Windows' own tar.exe (bsdtar reads zip), spawned without a
 * shell. State lives on globalThis because Next compiles route handlers and
 * instrumentation into separate module instances within one process.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
	WHISPER_MODELS,
	type WhisperDownloadTarget,
	type WhisperModelId,
	type WhisperStatus,
} from "../../core/dictation.ts";
import {
	WHISPER_MODEL_ARTIFACTS,
	WHISPER_SERVER_ARTIFACT,
	WHISPER_SERVER_ZIP_DIR,
	whisperPaths,
	type WhisperArtifact,
	type WhisperPaths,
} from "./manifest.ts";

export interface WhisperInstallDeps {
	paths: WhisperPaths;
	platform: string;
	fetch: typeof fetch;
	/** Unpack `zip` into the (existing, empty) directory `dest`. */
	extractZip: (zip: string, dest: string, signal: AbortSignal) => Promise<void>;
	/** Called after a verified install, to (re)start the server. */
	onInstalled: () => void;
	/** The pinned artifact for a target (test seam; defaults to the manifest). */
	artifactFor: (target: WhisperDownloadTarget) => WhisperArtifact;
}

function manifestArtifact(target: WhisperDownloadTarget): WhisperArtifact {
	return target === "server" ? WHISPER_SERVER_ARTIFACT : WHISPER_MODEL_ARTIFACTS[target];
}

type ActiveDownload = NonNullable<WhisperStatus["download"]> & { controller: AbortController };

interface InstallState {
	active: ActiveDownload | null;
	lastError: WhisperStatus["downloadError"];
}

const STATE_KEY = Symbol.for("lh.whisperInstall");

function installState(): InstallState {
	const g = globalThis as Record<symbol, InstallState | undefined>;
	return (g[STATE_KEY] ??= { active: null, lastError: null });
}

/** Windows' bundled bsdtar; extracts zip archives. */
export function windowsExtractZip(zip: string, dest: string, signal: AbortSignal): Promise<void> {
	const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
	return new Promise((resolve, reject) => {
		execFile(tar, ["-xf", zip, "-C", dest], { signal, windowsHide: true }, (error) => error ? reject(error) : resolve());
	});
}

export function defaultInstallDeps(onInstalled: () => void): WhisperInstallDeps {
	return {
		paths: whisperPaths(), platform: process.platform, fetch: (...args) => fetch(...args),
		extractZip: windowsExtractZip, onInstalled, artifactFor: manifestArtifact,
	};
}

export function whisperServerInstalled(paths: WhisperPaths): boolean {
	try { return fs.statSync(paths.serverExe).isFile(); } catch { return false; }
}

/** A model counts as installed when its file has the pinned size (it was hashed on download). */
export function whisperModelInstalled(paths: WhisperPaths, id: WhisperModelId): boolean {
	try { return fs.statSync(paths.model(id)).size === WHISPER_MODEL_ARTIFACTS[id].sizeBytes; } catch { return false; }
}

export function whisperInstallView(paths: WhisperPaths): Pick<WhisperStatus, "server" | "models" | "download" | "downloadError"> {
	const state = installState();
	const active = state.active;
	return {
		server: { installed: whisperServerInstalled(paths), sizeBytes: WHISPER_SERVER_ARTIFACT.sizeBytes },
		models: WHISPER_MODELS.map((id) => ({
			id,
			label: WHISPER_MODEL_ARTIFACTS[id].label,
			sizeBytes: WHISPER_MODEL_ARTIFACTS[id].sizeBytes,
			installed: whisperModelInstalled(paths, id),
		})),
		download: active ? { target: active.target, phase: active.phase, receivedBytes: active.receivedBytes, totalBytes: active.totalBytes } : null,
		downloadError: state.lastError,
	};
}

export type StartDownloadResult = { ok: true } | { ok: false; status: number; error: string };

/** Begin a download in the background. One at a time. */
export function startWhisperDownload(target: WhisperDownloadTarget, deps: WhisperInstallDeps): StartDownloadResult {
	if (deps.platform !== "win32") return { ok: false, status: 409, error: "Local Whisper downloads are only available on Windows." };
	const state = installState();
	if (state.active) return { ok: false, status: 409, error: "Another Whisper download is already running." };
	const artifact = deps.artifactFor(target);
	const active: ActiveDownload = {
		target, phase: "downloading", receivedBytes: 0, totalBytes: artifact.sizeBytes, controller: new AbortController(),
	};
	state.active = active;
	state.lastError = null;
	void runDownload(active, artifact, deps).then(
		() => { if (state.active === active) state.active = null; deps.onInstalled(); },
		(error: unknown) => {
			if (state.active === active) state.active = null;
			if (active.controller.signal.aborted) return; // cancelled: not an error
			const message = error instanceof Error ? error.message : String(error);
			state.lastError = { target, message };
			console.warn(`[whisper] download of ${target} failed: ${message}`);
		},
	);
	return { ok: true };
}

/** Cancel the running download, if any. Its scratch files are removed. */
export function cancelWhisperDownload(): boolean {
	const active = installState().active;
	if (!active) return false;
	active.controller.abort();
	return true;
}

async function runDownload(active: ActiveDownload, artifact: WhisperArtifact, deps: WhisperInstallDeps): Promise<void> {
	const { paths } = deps;
	const signal = active.controller.signal;
	const scratch = path.join(paths.downloadDir, `${active.target}-${Date.now()}`);
	fs.mkdirSync(scratch, { recursive: true });
	try {
		const file = path.join(scratch, active.target === "server" ? "whisper-server.zip" : "model.bin");
		await downloadVerified(artifact, file, active, deps.fetch, signal);
		if (active.target === "server") {
			active.phase = "extracting";
			const unpacked = path.join(scratch, "unpacked");
			fs.mkdirSync(unpacked);
			await deps.extractZip(file, unpacked, signal);
			const release = path.join(unpacked, WHISPER_SERVER_ZIP_DIR);
			if (!fs.existsSync(path.join(release, path.basename(paths.serverExe)))) {
				throw new Error("The whisper.cpp download did not contain whisper-server.exe.");
			}
			fs.rmSync(paths.binDir, { recursive: true, force: true });
			fs.mkdirSync(path.dirname(paths.binDir), { recursive: true });
			fs.renameSync(release, paths.binDir);
		} else {
			fs.mkdirSync(paths.modelsDir, { recursive: true });
			const destination = paths.model(active.target);
			fs.rmSync(destination, { force: true });
			fs.renameSync(file, destination);
		}
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

async function downloadVerified(
	artifact: WhisperArtifact,
	file: string,
	active: ActiveDownload,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
): Promise<void> {
	const response = await fetchImpl(artifact.url, { redirect: "follow", signal });
	if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}).`);
	const hash = createHash("sha256");
	const meter = new Transform({
		transform(chunk: Buffer, _encoding, done) {
			hash.update(chunk);
			active.receivedBytes += chunk.length;
			done(null, chunk);
		},
	});
	await pipeline(Readable.fromWeb(response.body as WebReadableStream), meter, fs.createWriteStream(file), { signal });
	active.phase = "verifying";
	const digest = hash.digest("hex");
	if (digest !== artifact.sha256) {
		throw new Error(`Checksum mismatch for ${path.basename(new URL(artifact.url).pathname)}; the file was discarded.`);
	}
}

/** Test seam: forget download state between cases. */
export function resetWhisperInstallState(): void {
	const state = installState();
	state.active?.controller.abort();
	state.active = null;
	state.lastError = null;
}
