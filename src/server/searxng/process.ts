/**
 * The app-managed SearXNG container (blog review plan M2, owner 2026-11-06).
 *
 * Owner decisions:
 *  - LearnHarness runs SearXNG through Docker, ONLY WHILE THE APP IS OPEN:
 *    started at server boot (instrumentation.ts) and whenever the setting is
 *    switched on, stopped when it is switched off and when the app exits.
 *    `docker run --rm`, so a stopped container leaves nothing behind.
 *  - Docker Desktop not running → an honest error status ("start it, then
 *    press Retry"); the app never launches other programs.
 *  - "Install" is an explicit `docker pull` of the pinned image.
 *
 * Security: the container publishes on 127.0.0.1 only, on a free port
 * picked per start; the window never talks to SearXNG (searches run
 * server-side through the search port).
 *
 * Exit: Node's "exit" hook removes the container synchronously. A hard-killed
 * server (Windows TerminateProcess skips exit hooks) leaves the marker file;
 * the Electron shell removes the container on quit, and every start removes
 * a leftover container by name first.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import type { SearxngStatus } from "../../core/search.ts";
import { effectiveSettings } from "../stores.ts";
import {
	SEARXNG_CONTAINER,
	SEARXNG_CONTAINER_PORT,
	SEARXNG_IMAGE,
	SEARXNG_IMAGE_SIZE_MB,
	searxngPaths,
	searxngSettingsYaml,
	type SearxngPaths,
} from "./manifest.ts";

export interface DockerResult {
	code: number | null;
	stdout: string;
	stderr: string;
	/** The docker CLI itself is missing (spawn ENOENT). */
	notFound?: boolean;
}

export interface DockerRunOptions {
	timeoutMs?: number;
	/** Each stdout/stderr line as it arrives (pull progress). */
	onLine?: (line: string) => void;
}

export interface SearxngDeps {
	paths: SearxngPaths;
	/** The settings switch (agent.search.searxng.enabled). */
	enabled: () => boolean;
	docker: (args: string[], opts?: DockerRunOptions) => Promise<DockerResult>;
	/** Synchronous container removal for the process "exit" hook. */
	dockerRemoveSync: () => void;
	fetch: typeof fetch;
	freePort: () => Promise<number>;
	randomSecret: () => string;
	readyTimeoutMs: number;
	healthIntervalMs: number;
	/** How long a docker/image probe stays fresh for status polls. */
	probeTtlMs: number;
	now: () => number;
}

type Phase = SearxngStatus["process"]["phase"];

interface Runtime {
	phase: Phase;
	error: string | null;
	baseUrl: string | null;
	/** True once this process started a container (exit-hook guard). */
	started: boolean;
	pending: Promise<void> | null;
	generation: number;
	exitHooked: boolean;
	pull: { detail: string } | null;
	pullError: string | null;
	probe: { at: number; docker: SearxngStatus["docker"]; imageInstalled: boolean } | null;
}

const RUNTIME_KEY = Symbol.for("lh.searxng");

function runtime(): Runtime {
	const g = globalThis as Record<symbol, Runtime | undefined>;
	return (g[RUNTIME_KEY] ??= {
		phase: "stopped",
		error: null,
		baseUrl: null,
		started: false,
		pending: null,
		generation: 0,
		exitHooked: false,
		pull: null,
		pullError: null,
		probe: null,
	});
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
		});
	});
}

/** Run the docker CLI (no shell). Never rejects: failures are results. */
function runDocker(args: string[], opts: DockerRunOptions = {}): Promise<DockerResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: DockerResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const child = spawn("docker", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* already gone */
			}
			finish({ code: null, stdout, stderr: `${stderr}\ndocker ${args[0]} timed out`.trim() });
		}, opts.timeoutMs ?? 30_000);
		const lines = (sink: "out" | "err") => {
			let partial = "";
			return (chunk: Buffer) => {
				const text = chunk.toString("utf8");
				if (sink === "out") stdout += text;
				else stderr += text;
				if (!opts.onLine) return;
				const parts = (partial + text).split(/\r?\n|\r/);
				partial = parts.pop() ?? "";
				for (const line of parts) if (line.trim()) opts.onLine(line.trim());
			};
		};
		child.stdout.on("data", lines("out"));
		child.stderr.on("data", lines("err"));
		child.once("error", (error: NodeJS.ErrnoException) => {
			finish({ code: null, stdout, stderr: error.message, notFound: error.code === "ENOENT" });
		});
		child.once("close", (code) => finish({ code, stdout, stderr }));
	});
}

export function defaultSearxngDeps(): SearxngDeps {
	return {
		paths: searxngPaths(),
		enabled: () => effectiveSettings().agent.search?.searxng?.enabled === true,
		docker: runDocker,
		dockerRemoveSync: () => {
			spawnSync("docker", ["rm", "-f", SEARXNG_CONTAINER], { windowsHide: true, timeout: 10_000, stdio: "ignore" });
		},
		fetch: (...args) => fetch(...args),
		freePort,
		randomSecret: () => randomBytes(32).toString("hex"),
		readyTimeoutMs: 90_000,
		healthIntervalMs: 500,
		probeTtlMs: 3_000,
		now: () => Date.now(),
	};
}

export const DOCKER_MESSAGES = {
	"not-installed": "Docker isn't installed. Install Docker Desktop to use SearXNG.",
	"not-running": "Docker Desktop isn't running. Start it, then press Retry.",
} as const;

async function probeDocker(deps: SearxngDeps, fresh = false): Promise<NonNullable<Runtime["probe"]>> {
	const rt = runtime();
	if (!fresh && rt.probe && deps.now() - rt.probe.at < deps.probeTtlMs) return rt.probe;
	const version = await deps.docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
	let docker: SearxngStatus["docker"];
	if (version.notFound) docker = "not-installed";
	else if (version.code === 0 && version.stdout.trim()) docker = "ready";
	else docker = "not-running";
	let imageInstalled = false;
	if (docker === "ready") {
		const inspect = await deps.docker(["image", "inspect", "--format", "{{.Id}}", SEARXNG_IMAGE], { timeoutMs: 15_000 });
		imageInstalled = inspect.code === 0;
	}
	rt.probe = { at: deps.now(), docker, imageInstalled };
	return rt.probe;
}

function writeMarker(paths: SearxngPaths): void {
	fs.mkdirSync(paths.root, { recursive: true });
	fs.writeFileSync(paths.markerFile, JSON.stringify({ container: SEARXNG_CONTAINER }), "utf8");
}

function ensureConfig(deps: SearxngDeps): void {
	if (fs.existsSync(deps.paths.settingsFile)) return;
	fs.mkdirSync(deps.paths.configDir, { recursive: true });
	fs.writeFileSync(deps.paths.settingsFile, searxngSettingsYaml(deps.randomSecret()), "utf8");
}

/** Remove the container (if any) and reset the bookkeeping. */
async function stopContainer(deps: SearxngDeps): Promise<void> {
	const rt = runtime();
	rt.generation++;
	const hadContainer = rt.started || rt.baseUrl !== null || fs.existsSync(deps.paths.markerFile);
	rt.baseUrl = null;
	rt.phase = "stopped";
	rt.error = null;
	if (hadContainer) {
		await deps.docker(["rm", "-f", SEARXNG_CONTAINER], { timeoutMs: 30_000 });
		rt.started = false;
		fs.rmSync(deps.paths.markerFile, { force: true });
	}
}

async function startContainer(deps: SearxngDeps): Promise<void> {
	const rt = runtime();
	const generation = ++rt.generation;
	rt.phase = "starting";
	rt.error = null;
	rt.baseUrl = null;
	const fail = (message: string) => {
		if (generation !== rt.generation) return;
		rt.phase = "error";
		rt.error = message;
		console.warn(`[searxng] ${message}`);
	};
	if (!rt.exitHooked) {
		rt.exitHooked = true;
		process.once("exit", () => {
			const current = runtime();
			if (!current.started) return;
			try {
				deps.dockerRemoveSync();
				fs.rmSync(deps.paths.markerFile, { force: true });
			} catch {
				/* best effort — the shell and the next start clean up too */
			}
		});
	}

	// A leftover container from a hard-killed run holds the name.
	await deps.docker(["rm", "-f", SEARXNG_CONTAINER], { timeoutMs: 30_000 });
	if (generation !== rt.generation) return;
	try {
		ensureConfig(deps);
	} catch (error) {
		fail(`Could not write SearXNG settings: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const port = await deps.freePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	const run = await deps.docker(
		[
			"run", "-d", "--rm",
			"--name", SEARXNG_CONTAINER,
			"-p", `127.0.0.1:${port}:${SEARXNG_CONTAINER_PORT}`,
			"-v", `${deps.paths.configDir}:/etc/searxng`,
			"-e", `SEARXNG_BASE_URL=${baseUrl}/`,
			SEARXNG_IMAGE,
		],
		{ timeoutMs: 60_000 },
	);
	if (generation !== rt.generation) return;
	if (run.code !== 0) {
		const detail = (run.stderr || run.stdout).trim().split(/\r?\n/).slice(-2).join(" | ");
		fail(`Could not start the SearXNG container${detail ? `: ${detail}` : ""}`);
		return;
	}
	rt.started = true;
	try {
		writeMarker(deps.paths);
	} catch {
		/* the marker only helps the shell's quit cleanup */
	}

	const deadline = deps.now() + deps.readyTimeoutMs;
	while (generation === rt.generation) {
		try {
			const response = await deps.fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2_000) });
			if (response.ok) {
				if (generation !== rt.generation) return;
				rt.baseUrl = baseUrl;
				rt.phase = "running";
				console.info(`[searxng] ready on ${baseUrl}`);
				return;
			}
		} catch {
			/* not listening yet */
		}
		if (deps.now() > deadline) {
			fail(`SearXNG did not become ready within ${Math.round(deps.readyTimeoutMs / 1000)}s`);
			await deps.docker(["rm", "-f", SEARXNG_CONTAINER], { timeoutMs: 30_000 });
			rt.started = false;
			fs.rmSync(deps.paths.markerFile, { force: true });
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, deps.healthIntervalMs));
	}
}

/** Converge on the desired state: start, keep, or stop. Serialized. */
export function syncSearxng(deps: SearxngDeps = defaultSearxngDeps(), opts: { freshProbe?: boolean } = {}): Promise<void> {
	const rt = runtime();
	const run = async () => {
		if (!deps.enabled()) {
			await stopContainer(deps);
			return;
		}
		const probe = await probeDocker(deps, opts.freshProbe);
		if (probe.docker !== "ready") {
			await stopContainer(deps).catch(() => {});
			rt.phase = "error";
			rt.error = DOCKER_MESSAGES[probe.docker];
			return;
		}
		if (!probe.imageInstalled) {
			rt.phase = "stopped";
			rt.error = null;
			return;
		}
		if (rt.phase === "running" && rt.baseUrl) {
			try {
				const health = await deps.fetch(`${rt.baseUrl}/healthz`, { signal: AbortSignal.timeout(2_000) });
				if (health.ok) return;
			} catch {
				/* gone — restart below */
			}
		}
		await startContainer(deps);
	};
	const next = (rt.pending ?? Promise.resolve()).catch(() => {}).then(run);
	rt.pending = next;
	void next
		.finally(() => {
			if (rt.pending === next) rt.pending = null;
		})
		.catch(() => {});
	return next;
}

/** Start an image pull ("Install"). Resolves once the pull is UNDERWAY;
 *  completion converges the container. */
export async function startSearxngPull(deps: SearxngDeps = defaultSearxngDeps()): Promise<{ ok: true } | { ok: false; error: string }> {
	const rt = runtime();
	if (rt.pull) return { ok: false, error: "SearXNG is already being installed." };
	const probe = await probeDocker(deps, true);
	if (probe.docker !== "ready") return { ok: false, error: DOCKER_MESSAGES[probe.docker] };
	rt.pull = { detail: "Starting download…" };
	rt.pullError = null;
	void deps
		.docker(["pull", SEARXNG_IMAGE], {
			timeoutMs: 30 * 60_000,
			onLine: (line) => {
				if (rt.pull) rt.pull = { detail: line.slice(0, 200) };
			},
		})
		.then(async (result) => {
			rt.pull = null;
			rt.probe = null;
			if (result.code !== 0) {
				const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-1)[0] ?? "";
				rt.pullError = `Download failed${detail ? `: ${detail}` : ""}`;
				return;
			}
			await syncSearxng(deps, { freshProbe: true });
		});
	return { ok: true };
}

/** The base URL of a running SearXNG, starting it if needed — for the
 *  search adapter. Throws a user-facing message when it can't run. */
export async function searxngBaseUrl(deps: SearxngDeps = defaultSearxngDeps()): Promise<string> {
	const rt = runtime();
	if (rt.phase !== "running" || !rt.baseUrl) await syncSearxng(deps);
	if (rt.phase !== "running" || !rt.baseUrl) {
		throw new Error(rt.error ?? (rt.probe?.imageInstalled === false ? "SearXNG isn't installed — install it in Settings → Agent." : "SearXNG is not running."));
	}
	return rt.baseUrl;
}

/** Synchronous liveness for search-engine resolution: enabled and either
 *  running or on its way up. */
export function searxngLive(deps: Pick<SearxngDeps, "enabled"> = defaultSearxngDeps()): boolean {
	const phase = runtime().phase;
	return deps.enabled() && (phase === "running" || phase === "starting");
}

/** The process view for search-status reason lines. */
export function searxngProcessView(): SearxngStatus["process"] {
	const rt = runtime();
	return { phase: rt.phase, error: rt.error };
}

export async function searxngStatus(deps: SearxngDeps = defaultSearxngDeps()): Promise<SearxngStatus> {
	const rt = runtime();
	const probe = await probeDocker(deps);
	return {
		enabled: deps.enabled(),
		docker: probe.docker,
		image: { ref: SEARXNG_IMAGE, installed: probe.imageInstalled, approxSizeMb: SEARXNG_IMAGE_SIZE_MB },
		pull: rt.pull,
		pullError: rt.pullError,
		process: { phase: rt.phase, error: rt.error },
	};
}

/** Test seam: forget the runtime (does not touch Docker). */
export function resetSearxngRuntime(): void {
	const g = globalThis as Record<symbol, Runtime | undefined>;
	const rt = g[RUNTIME_KEY];
	if (rt) {
		rt.generation++;
		rt.phase = "stopped";
		rt.error = null;
		rt.baseUrl = null;
		rt.started = false;
		rt.pending = null;
		rt.pull = null;
		rt.pullError = null;
		rt.probe = null;
	}
}
