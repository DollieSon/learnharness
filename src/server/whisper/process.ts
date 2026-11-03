/**
 * The local whisper-server process (local Whisper wave, 2026-11-03).
 *
 * Owner decisions: LearnHarness launches whisper.cpp itself, WITH THE APP
 * (server boot via instrumentation.ts), and converges on every relevant change
 * (download finished, engine/model saved). A crash leaves an error status; the
 * next dictation restarts it. There is no automatic restart loop.
 *
 * Security: whisper-server answers every origin (Access-Control-Allow-Origin:
 * *), so it binds 127.0.0.1 on a random free port AND serves only under a
 * random per-launch --request-path. A page in the user's browser cannot guess
 * the path, and the renderer never talks to whisper-server at all: audio goes
 * through the LearnHarness transcribe route.
 *
 * Exit: Node's "exit" hook kills the child. A hard-killed server (Windows
 * TerminateProcess skips exit hooks) leaves a pidfile behind; the next launch
 * kills that stale whisper-server first, and the Electron shell kills it on quit.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
	DEFAULT_WHISPER_MODEL,
	WHISPER_NOT_READY_CODE,
	cleanWhisperText,
	defaultDictationEngine,
	type WhisperModelId,
	type WhisperStatus,
} from "../../core/dictation.ts";
import { readSettings } from "../../store/settings.ts";
import { WHISPER_SERVER_EXE, whisperPaths, type WhisperPaths } from "./manifest.ts";
import { whisperModelInstalled, whisperServerInstalled } from "./install.ts";

export type WhisperProcessPhase = WhisperStatus["process"]["phase"];

export interface WhisperProcessDeps {
	paths: WhisperPaths;
	platform: string;
	/** The effective dictation choice from the settings record. */
	dictation: () => { engine: "deepgram" | "whisper-local"; model: WhisperModelId };
	spawn: (exe: string, args: string[], cwd: string) => ChildProcess;
	fetch: typeof fetch;
	freePort: () => Promise<number>;
	/** True when `pid` is a running whisper-server (stale-process guard). */
	isWhisperProcess: (pid: number) => Promise<boolean>;
	killPid: (pid: number) => void;
	readyTimeoutMs: number;
	healthIntervalMs: number;
	serverInstalled: () => boolean;
	modelInstalled: (id: WhisperModelId) => boolean;
}

interface Runtime {
	phase: WhisperProcessPhase;
	model: WhisperModelId | null;
	error: string | null;
	child: ChildProcess | null;
	/** The pidfile written for `child` (removed when it stops). */
	pidFile: string | null;
	baseUrl: string | null;
	/** The in-flight convergence; callers await it instead of racing. */
	pending: Promise<void> | null;
	generation: number;
	exitHooked: boolean;
}

const RUNTIME_KEY = Symbol.for("lh.whisperServer");

function runtime(): Runtime {
	const g = globalThis as Record<symbol, Runtime | undefined>;
	return (g[RUNTIME_KEY] ??= {
		phase: "stopped", model: null, error: null, child: null, pidFile: null, baseUrl: null, pending: null, generation: 0, exitHooked: false,
	});
}

export function effectiveDictationChoice(platform: string = process.platform) {
	const record = readSettings()?.dictation;
	return {
		engine: record?.engine ?? defaultDictationEngine(platform),
		model: record?.whisperModel ?? DEFAULT_WHISPER_MODEL,
	};
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")));
		});
	});
}

/** Windows: ask tasklist whether `pid` is whisper-server.exe. */
function isWhisperProcess(pid: number): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true }, (error, stdout) => {
			resolve(!error && stdout.toLowerCase().includes(`"${WHISPER_SERVER_EXE}"`));
		});
	});
}

export function defaultProcessDeps(): WhisperProcessDeps {
	const paths = whisperPaths();
	return {
		paths,
		serverInstalled: () => whisperServerInstalled(paths),
		modelInstalled: (id) => whisperModelInstalled(paths, id),
		platform: process.platform,
		dictation: () => effectiveDictationChoice(),
		spawn: (exe, args, cwd) => spawn(exe, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }),
		fetch: (...args) => fetch(...args),
		freePort,
		isWhisperProcess,
		killPid: (pid) => { try { process.kill(pid); } catch { /* already gone */ } },
		readyTimeoutMs: 120_000,
		healthIntervalMs: 250,
	};
}

export type WhisperUnavailableReason = "unsupported-platform" | "engine-off" | "server-missing" | "model-missing";

/** The model local Whisper should be running, or why it should not run. */
export function whisperTarget(deps: WhisperProcessDeps): { ok: true; model: WhisperModelId } | { ok: false; reason: WhisperUnavailableReason } {
	if (deps.platform !== "win32") return { ok: false, reason: "unsupported-platform" };
	const { engine, model } = deps.dictation();
	if (engine !== "whisper-local") return { ok: false, reason: "engine-off" };
	if (!deps.serverInstalled()) return { ok: false, reason: "server-missing" };
	if (!deps.modelInstalled(model)) return { ok: false, reason: "model-missing" };
	return { ok: true, model };
}

export function whisperProcessView(): WhisperStatus["process"] {
	const rt = runtime();
	return { phase: rt.phase, model: rt.model, error: rt.error };
}

/** Converge on the desired state: start, restart on a model change, or stop. */
export function syncWhisper(deps: WhisperProcessDeps = defaultProcessDeps()): Promise<void> {
	const rt = runtime();
	const run = async () => {
		const target = whisperTarget(deps);
		if (!target.ok) { stopWhisper(); return; }
		if ((rt.phase === "running" || rt.phase === "starting") && rt.model === target.model && rt.child) return;
		stopWhisper();
		await startWhisper(target.model, deps);
	};
	// Serialize: each convergence starts after the previous one settles.
	const next = (rt.pending ?? Promise.resolve()).catch(() => {}).then(run);
	rt.pending = next;
	void next.finally(() => { if (rt.pending === next) rt.pending = null; }).catch(() => {});
	return next;
}

/** Stop the child (if any). Idempotent. Returns the stopped child, if any. */
export function stopWhisper(): ChildProcess | null {
	const rt = runtime();
	rt.generation++;
	const child = rt.child;
	const pidFile = rt.pidFile;
	rt.child = null;
	rt.pidFile = null;
	rt.baseUrl = null;
	rt.phase = "stopped";
	rt.model = null;
	rt.error = null;
	if (child) {
		try { child.kill(); } catch { /* already gone */ }
		if (pidFile) fs.rmSync(pidFile, { force: true });
	}
	return child;
}

async function killStale(deps: WhisperProcessDeps): Promise<void> {
	let pid: number | undefined;
	try {
		pid = (JSON.parse(fs.readFileSync(deps.paths.pidFile, "utf8")) as { pid?: unknown }).pid as number;
	} catch { return; }
	if (Number.isInteger(pid) && pid! > 0 && await deps.isWhisperProcess(pid!)) deps.killPid(pid!);
	fs.rmSync(deps.paths.pidFile, { force: true });
}

async function startWhisper(model: WhisperModelId, deps: WhisperProcessDeps): Promise<void> {
	const rt = runtime();
	const generation = ++rt.generation;
	rt.phase = "starting";
	rt.model = model;
	rt.error = null;
	if (!rt.exitHooked) {
		rt.exitHooked = true;
		process.once("exit", () => {
			const current = runtime();
			try { current.child?.kill(); } catch { /* best effort */ }
			try { if (current.pidFile) fs.rmSync(current.pidFile, { force: true }); } catch { /* best effort */ }
		});
	}
	const fail = (message: string) => {
		if (generation !== rt.generation) return;
		rt.phase = "error";
		rt.error = message;
		console.warn(`[whisper] ${message}`);
	};

	await killStale(deps);
	if (generation !== rt.generation) return;
	const port = await deps.freePort();
	const secret = randomBytes(16).toString("hex");
	const args = [
		"-m", deps.paths.model(model),
		"--host", "127.0.0.1",
		"--port", String(port),
		"--request-path", `/${secret}`,
		"-l", "auto",
		"--suppress-nst",
	];
	let child: ChildProcess;
	try {
		child = deps.spawn(deps.paths.serverExe, args, path.dirname(deps.paths.serverExe));
	} catch (error) {
		fail(`Could not start whisper-server: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	rt.child = child;
	rt.pidFile = deps.paths.pidFile;
	const baseUrl = `http://127.0.0.1:${port}/${secret}`;
	if (child.pid) fs.writeFileSync(deps.paths.pidFile, JSON.stringify({ pid: child.pid }), "utf8");

	// Keep a short stderr tail for the error status.
	let tail = "";
	const keep = (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-2000); };
	child.stderr?.on("data", keep);
	child.stdout?.on("data", () => {}); // drain
	let exited = false;
	const onGone = (detail: string) => {
		exited = true;
		if (rt.child !== child) return;
		rt.child = null;
		rt.pidFile = null;
		rt.baseUrl = null;
		fs.rmSync(deps.paths.pidFile, { force: true });
		const last = tail.trim().split(/\r?\n/).slice(-3).join(" | ");
		fail(`whisper-server stopped (${detail})${last ? `: ${last}` : ""}`);
	};
	child.once("exit", (code, signal) => onGone(signal ? `signal ${signal}` : `exit code ${code}`));
	child.once("error", (error) => onGone(error.message));

	const deadline = Date.now() + deps.readyTimeoutMs;
	while (generation === rt.generation && !exited) {
		try {
			const response = await deps.fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
			if (response.ok) {
				if (generation !== rt.generation || exited) return;
				rt.baseUrl = baseUrl;
				rt.phase = "running";
				console.info(`[whisper] whisper-server ready (${model}) on 127.0.0.1:${port}`);
				return;
			}
		} catch { /* not listening yet */ }
		if (Date.now() > deadline) {
			fail(`whisper-server did not become ready within ${Math.round(deps.readyTimeoutMs / 1000)}s`);
			try { child.kill(); } catch { /* already gone */ }
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, deps.healthIntervalMs));
	}
}

export class WhisperNotReadyError extends Error {
	readonly code = WHISPER_NOT_READY_CODE;
	constructor(message: string, readonly reason: WhisperUnavailableReason | "not-running") { super(message); }
}

const NOT_READY_MESSAGES: Record<WhisperUnavailableReason, string> = {
	"unsupported-platform": "Local Whisper is only available on Windows.",
	"engine-off": "Local Whisper is not the selected dictation engine.",
	"server-missing": "Local Whisper isn't installed. Download it in Settings → Providers → Dictation.",
	"model-missing": "The selected Whisper model isn't downloaded. Download it in Settings → Providers → Dictation.",
};

/** Transcribe one WAV clip. Starts (or restarts after a crash) the server when needed. */
export async function transcribeWithWhisper(
	wav: Uint8Array,
	language: string,
	signal?: AbortSignal,
	deps: WhisperProcessDeps = defaultProcessDeps(),
): Promise<string> {
	const target = whisperTarget(deps);
	if (!target.ok) throw new WhisperNotReadyError(NOT_READY_MESSAGES[target.reason], target.reason);
	const rt = runtime();
	if (rt.phase !== "running" || rt.model !== target.model || !rt.baseUrl) await syncWhisper(deps);
	if (rt.phase !== "running" || !rt.baseUrl) {
		throw new WhisperNotReadyError(rt.error ?? "Local Whisper is not running.", "not-running");
	}
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "dictation.wav");
	form.append("language", language);
	form.append("response_format", "json");
	form.append("temperature", "0.0");
	const response = await deps.fetch(`${rt.baseUrl}/inference`, { method: "POST", body: form, signal });
	const body = await response.json().catch(() => ({})) as { text?: unknown; error?: unknown };
	if (!response.ok) {
		throw new Error(typeof body.error === "string" ? `Whisper: ${body.error}` : `Whisper request failed (HTTP ${response.status}).`);
	}
	return cleanWhisperText(typeof body.text === "string" ? body.text : "");
}

/** Test seam: forget the runtime (does not kill anything). */
export function resetWhisperRuntime(): void {
	const g = globalThis as Record<symbol, Runtime | undefined>;
	const rt = g[RUNTIME_KEY];
	if (rt) { rt.generation++; rt.child = null; rt.pidFile = null; rt.baseUrl = null; rt.phase = "stopped"; rt.model = null; rt.error = null; rt.pending = null; }
}
