import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { WhisperDownloadTarget } from "../src/core/index.ts";
import { whisperPaths } from "../src/server/whisper/manifest.ts";
import {
	cancelWhisperDownload,
	resetWhisperInstallState,
	startWhisperDownload,
	whisperInstallView,
	type WhisperInstallDeps,
} from "../src/server/whisper/install.ts";
import {
	WhisperNotReadyError,
	defaultProcessDeps,
	resetWhisperRuntime,
	stopWhisper,
	syncWhisper,
	transcribeWithWhisper,
	whisperProcessView,
	type WhisperProcessDeps,
} from "../src/server/whisper/process.ts";
import { encodeWavPcm16 } from "../src/core/index.ts";

const FAKE_SERVER = fileURLToPath(new URL("./helpers/fake-whisper-server.mjs", import.meta.url));
const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
function tempRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-whisper-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	stopWhisper();
	resetWhisperRuntime();
	resetWhisperInstallState();
	// Windows keeps a dying child's files busy: wait for every fake server to exit.
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill();
			await new Promise((resolve) => child.once("exit", resolve));
		}
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// ─── Downloads ─────────────────────────────────────────────────────────────

function installDeps(root: string, bytes: Uint8Array, overrides: Partial<WhisperInstallDeps> = {}) {
	const calls = { installed: 0, fetched: [] as string[] };
	const deps: WhisperInstallDeps = {
		paths: whisperPaths(root),
		platform: "win32",
		fetch: async (url) => { calls.fetched.push(String(url)); return new Response(new Blob([new Uint8Array(bytes)])); },
		extractZip: async (_zip, dest) => {
			fs.mkdirSync(path.join(dest, "Release"));
			fs.writeFileSync(path.join(dest, "Release", "whisper-server.exe"), "exe");
			fs.writeFileSync(path.join(dest, "Release", "ggml-cuda.dll"), "dll");
		},
		onInstalled: () => { calls.installed++; },
		artifactFor: (target: WhisperDownloadTarget) => ({
			url: `https://example.test/${target}`,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			sizeBytes: bytes.byteLength,
		}),
		...overrides,
	};
	return { deps, calls };
}

async function settled(root: string) {
	for (let i = 0; i < 200 && whisperInstallView(whisperPaths(root)).download; i++) await new Promise((r) => setTimeout(r, 10));
	return whisperInstallView(whisperPaths(root));
}

test("a verified model download lands in models/ and triggers a sync", async () => {
	const root = tempRoot();
	const bytes = new TextEncoder().encode("model-bytes");
	const { deps, calls } = installDeps(root, bytes);
	assert.deepEqual(startWhisperDownload("base", deps), { ok: true });
	const view = await settled(root);
	assert.equal(view.downloadError, null);
	assert.equal(fs.readFileSync(deps.paths.model("base"), "utf8"), "model-bytes");
	assert.equal(calls.installed, 1);
	assert.deepEqual(fs.readdirSync(deps.paths.downloadDir), [], "scratch space is cleaned");
});

test("the server zip is unpacked and its Release folder becomes the bin dir", async () => {
	const root = tempRoot();
	const { deps } = installDeps(root, new TextEncoder().encode("zip-bytes"));
	assert.deepEqual(startWhisperDownload("server", deps), { ok: true });
	const view = await settled(root);
	assert.equal(view.downloadError, null);
	assert.equal(view.server.installed, true);
	assert.ok(fs.existsSync(path.join(deps.paths.binDir, "ggml-cuda.dll")));
});

test("a checksum mismatch installs nothing and reports the failure", async () => {
	const root = tempRoot();
	const { deps, calls } = installDeps(root, new TextEncoder().encode("good"));
	deps.fetch = async () => new Response("tampered");
	startWhisperDownload("small", deps);
	const view = await settled(root);
	assert.equal(view.downloadError?.target, "small");
	assert.match(view.downloadError!.message, /Checksum mismatch/);
	assert.equal(fs.existsSync(deps.paths.model("small")), false);
	assert.equal(calls.installed, 0);
	assert.deepEqual(fs.readdirSync(deps.paths.downloadDir), []);
});

test("a zip without whisper-server.exe is rejected", async () => {
	const root = tempRoot();
	const { deps } = installDeps(root, new TextEncoder().encode("zip"), { extractZip: async () => {} });
	startWhisperDownload("server", deps);
	const view = await settled(root);
	assert.match(view.downloadError!.message, /did not contain whisper-server.exe/);
	assert.equal(view.server.installed, false);
});

test("downloads run one at a time, are Windows-only, and cancel cleanly", async () => {
	const root = tempRoot();
	const { deps, calls } = installDeps(root, new Uint8Array(1));
	assert.equal(startWhisperDownload("base", { ...deps, platform: "darwin" }).ok, false);
	deps.fetch = async (_url, init) => new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array(10));
			init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
		},
	}));
	assert.deepEqual(startWhisperDownload("base", deps), { ok: true });
	const second = startWhisperDownload("small", deps);
	assert.equal(second.ok, false);
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(whisperInstallView(deps.paths).download?.target, "base");
	assert.equal(cancelWhisperDownload(), true);
	const view = await settled(root);
	assert.equal(view.download, null);
	assert.equal(view.downloadError, null, "a cancel is not an error");
	assert.equal(calls.installed, 0);
	assert.equal(fs.existsSync(deps.paths.model("base")), false);
});

// ─── The whisper-server process ─────────────────────────────────────────────

function processDeps(root: string, overrides: Partial<WhisperProcessDeps> = {}) {
	const paths = whisperPaths(root);
	fs.mkdirSync(paths.root, { recursive: true });
	const state = { model: "base" as "base" | "small", engine: "whisper-local" as "whisper-local" | "deepgram", killed: [] as number[] };
	const deps: WhisperProcessDeps = {
		...defaultProcessDeps(),
		paths: { ...paths, model: (id) => path.join(paths.root, id === "small" ? "crash.bin" : `${id}.bin`) },
		platform: "win32",
		dictation: () => ({ engine: state.engine, model: state.model }),
		spawn: (_exe, args) => {
			const child = spawn(process.execPath, [FAKE_SERVER, ...args], { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
			children.push(child);
			return child;
		},
		isWhisperProcess: async (pid) => pid === 424242,
		killPid: (pid) => { state.killed.push(pid); },
		readyTimeoutMs: 10_000,
		healthIntervalMs: 50,
		serverInstalled: () => true,
		modelInstalled: () => true,
		...overrides,
	};
	return { deps, state };
}

const clip = () => encodeWavPcm16([new Int16Array(1600).buffer]);

test("sync starts whisper-server; transcription is cleaned text with the mapped language", async () => {
	const { deps } = processDeps(tempRoot());
	await syncWhisper(deps);
	assert.deepEqual(whisperProcessView(), { phase: "running", model: "base", error: null });
	assert.ok(fs.existsSync(deps.paths.pidFile), "the pidfile records the child");
	assert.equal(await transcribeWithWhisper(clip(), "pl", undefined, deps), "hello there (pl)");
});

test("switching the engine away stops the server and removes the pidfile", async () => {
	const { deps, state } = processDeps(tempRoot());
	await syncWhisper(deps);
	state.engine = "deepgram";
	await syncWhisper(deps);
	assert.equal(whisperProcessView().phase, "stopped");
	assert.equal(fs.existsSync(deps.paths.pidFile), false);
});

test("a stale whisper-server from a hard-killed run is killed before starting", async () => {
	const { deps, state } = processDeps(tempRoot());
	fs.writeFileSync(deps.paths.pidFile, JSON.stringify({ pid: 424242 }));
	await syncWhisper(deps);
	assert.deepEqual(state.killed, [424242]);
	assert.equal(whisperProcessView().phase, "running");
});

test("an unrelated process in a stale pidfile is left alone", async () => {
	const { deps, state } = processDeps(tempRoot());
	fs.writeFileSync(deps.paths.pidFile, JSON.stringify({ pid: 7 }));
	await syncWhisper(deps);
	assert.deepEqual(state.killed, []);
});

test("a crash is reported, not looped; the next dictation retries and a fixed model recovers", async () => {
	const { deps, state } = processDeps(tempRoot());
	state.model = "small"; // the fake exits at once for this model
	await syncWhisper(deps);
	const crashed = whisperProcessView();
	assert.equal(crashed.phase, "error");
	assert.match(crashed.error!, /exit code 3.*CUDA error/);
	await assert.rejects(transcribeWithWhisper(clip(), "en", undefined, deps), (error: unknown) =>
		error instanceof WhisperNotReadyError && error.reason === "not-running");
	state.model = "base";
	assert.equal(await transcribeWithWhisper(clip(), "en", undefined, deps), "hello there (en)");
});

test("not-ready reasons are specific", async () => {
	const root = tempRoot();
	const reason = async (overrides: Partial<WhisperProcessDeps>) => {
		const { deps } = processDeps(root, overrides);
		try { await transcribeWithWhisper(clip(), "en", undefined, deps); return "transcribed"; }
		catch (error) { return error instanceof WhisperNotReadyError ? error.reason : String(error); }
	};
	assert.equal(await reason({ platform: "darwin" }), "unsupported-platform");
	assert.equal(await reason({ dictation: () => ({ engine: "deepgram", model: "base" }) }), "engine-off");
	assert.equal(await reason({ serverInstalled: () => false }), "server-missing");
	assert.equal(await reason({ modelInstalled: () => false }), "model-missing");
});
