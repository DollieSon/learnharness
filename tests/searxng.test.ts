/**
 * The app-managed SearXNG engine (blog review plan M2): the search adapter,
 * engine resolution with SearXNG first, the settings shape, and the Docker
 * manager driven by a fake docker CLI. Zero network, no real Docker.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { resolveSearchEngineFor, searxngProvider } from "../src/server/search.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { composeSearchEngine, composeSearxngEnabled } from "../components/settings/agent-section.tsx";
import { SEARXNG_CONTAINER, SEARXNG_IMAGE, searxngPaths, searxngSettingsYaml } from "../src/server/searxng/manifest.ts";
import {
	resetSearxngRuntime,
	searxngBaseUrl,
	searxngLive,
	searxngStatus,
	startSearxngPull,
	syncSearxng,
	type DockerResult,
	type SearxngDeps,
} from "../src/server/searxng/process.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-searxng-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe("searxngSettingsYaml", () => {
	it("turns JSON output on, the limiter off, and carries the secret", () => {
		const yaml = searxngSettingsYaml("abc123");
		assert.match(yaml, /use_default_settings: true/);
		assert.match(yaml, /secret_key: "abc123"/);
		assert.match(yaml, /limiter: false/);
		assert.match(yaml, /formats:\n\s+- html\n\s+- json/);
	});
});

describe("searxngProvider", () => {
	const base = async () => "http://127.0.0.1:4321";
	it("maps results and respects the count", async () => {
		const seen: string[] = [];
		const provider = searxngProvider(base, async (url) => {
			seen.push(url);
			return Response.json({
				results: [
					{ title: "A", url: "https://a.example/", content: "first\nline" },
					{ title: "B", url: "https://b.example/", content: "second" },
					{ title: "no url" },
					{ title: "C", url: "https://c.example/", content: "third" },
				],
			});
		});
		const hits = await provider.search("gradient descent", 2);
		assert.deepEqual(hits, [
			{ title: "A", url: "https://a.example/", snippet: "first line" },
			{ title: "B", url: "https://b.example/", snippet: "second" },
		]);
		const url = new URL(seen[0]!);
		assert.equal(url.origin + url.pathname, "http://127.0.0.1:4321/search");
		assert.equal(url.searchParams.get("q"), "gradient descent");
		assert.equal(url.searchParams.get("format"), "json");
	});
	it("throws a clear error on HTTP failure and on all-engines-silent", async () => {
		await assert.rejects(searxngProvider(base, async () => new Response("nope", { status: 403 })).search("q", 5), /SearXNG search 403: nope/);
		await assert.rejects(
			searxngProvider(base, async () => Response.json({ results: [], unresponsive_engines: [["google", "CAPTCHA"]] })).search("q", 5),
			/upstream engines did not answer: google \(CAPTCHA\)/,
		);
	});
});

describe("resolveSearchEngineFor with SearXNG", () => {
	const tav = { tavily: "tvly-throwaway-key-00001" };
	it("live SearXNG leads the auto order, ahead of a keyed engine", () => {
		const out = resolveSearchEngineFor(undefined, tav, { enabled: true, live: true });
		assert.equal(out.engine, "searxng");
		assert.equal(out.available, true);
		assert.match(out.reason, /searxng \(auto\)/);
	});
	it("enabled-but-down SearXNG: auto uses the keyed engine and says why", () => {
		const out = resolveSearchEngineFor(undefined, tav, { enabled: true, live: false, error: "Docker Desktop isn't running." });
		assert.equal(out.engine, "tavily");
		assert.match(out.reason, /SearXNG is enabled but not running: Docker Desktop isn't running/);
	});
	it("a SearXNG pin never silently switches engines", () => {
		const off = resolveSearchEngineFor("searxng", tav, { enabled: false, live: false });
		assert.equal(off.available, false);
		assert.match(off.reason, /turned off/);
		const down = resolveSearchEngineFor("searxng", tav, { enabled: true, live: false, error: "boom" });
		assert.equal(down.available, false);
		assert.match(down.reason, /not running: boom/);
		const up = resolveSearchEngineFor("searxng", {}, { enabled: true, live: true });
		assert.equal(up.engine, "searxng");
		assert.match(up.reason, /chosen/);
	});
	it("nothing configured mentions SearXNG as an option", () => {
		assert.match(resolveSearchEngineFor(undefined, {}).reason, /enable local SearXNG or set a Tavily or Brave/);
	});
});

describe("settings shape", () => {
	it("write side: accepts the SearXNG pin and switch, rejects bad shapes", () => {
		const ok = parseAgentSettingsBody({ search: { engine: "searxng", searxng: { enabled: true } } });
		assert.ok(ok.ok);
		assert.deepEqual(ok.ok && ok.settings.search, { engine: "searxng", searxng: { enabled: true } });
		assert.equal(parseAgentSettingsBody({ search: { searxng: { enabled: "yes" } } }).ok, false);
		assert.equal(parseAgentSettingsBody({ search: { engine: "google" } }).ok, false);
	});
	it("read side: keeps a valid switch, drops junk", () => {
		const record = sanitizeUserSettings({ version: 1, agent: { search: { engine: "nope", searxng: { enabled: true } } } });
		assert.deepEqual(record?.agent?.search, { searxng: { enabled: true } });
	});
	it("composers keep the switch and the pin independent", () => {
		const on = composeSearxngEnabled({ search: { engine: "brave" } }, true);
		assert.deepEqual(on.search, { engine: "brave", searxng: { enabled: true } });
		assert.deepEqual(composeSearchEngine(on, null).search, { searxng: { enabled: true } });
		assert.deepEqual(composeSearchEngine(on, "searxng").search, { engine: "searxng", searxng: { enabled: true } });
	});
});

/** A scripted docker CLI: records every call, answers by subcommand. */
function fakeDeps(opts: { docker?: "ready" | "not-installed" | "not-running"; image?: boolean; healthy?: boolean; enabled?: boolean } = {}) {
	const calls: string[][] = [];
	const state = { docker: opts.docker ?? "ready", image: opts.image ?? true, healthy: opts.healthy ?? true, enabled: opts.enabled ?? true };
	const root = fs.mkdtempSync(path.join(scratch, "data-"));
	let pullDone: (() => void) | null = null;
	const deps: SearxngDeps = {
		paths: searxngPaths(root),
		enabled: () => state.enabled,
		async docker(args): Promise<DockerResult> {
			calls.push(args);
			if (state.docker === "not-installed") return { code: null, stdout: "", stderr: "spawn docker ENOENT", notFound: true };
			if (args[0] === "version") return state.docker === "ready" ? { code: 0, stdout: "29.5.2\n", stderr: "" } : { code: 1, stdout: "", stderr: "cannot connect" };
			if (args[0] === "image") return { code: state.image ? 0 : 1, stdout: state.image ? "sha256:x" : "", stderr: "" };
			if (args[0] === "pull") {
				await new Promise<void>((resolve) => (pullDone = resolve));
				state.image = true;
				return { code: 0, stdout: "done", stderr: "" };
			}
			return { code: 0, stdout: "container-id\n", stderr: "" };
		},
		dockerRemoveSync: () => {},
		fetch: (async () => new Response(state.healthy ? "OK" : "down", { status: state.healthy ? 200 : 503 })) as typeof fetch,
		freePort: async () => 45678,
		randomSecret: () => "test-secret",
		readyTimeoutMs: 50,
		healthIntervalMs: 5,
		probeTtlMs: 0,
		now: () => Date.now(),
	};
	return { deps, calls, state, finishPull: () => pullDone?.() };
}

describe("SearXNG manager (fake docker)", () => {
	beforeEach(() => resetSearxngRuntime());
	afterEach(() => resetSearxngRuntime());

	it("disabled: nothing runs and no container command is issued", async () => {
		const { deps, calls } = fakeDeps({ enabled: false });
		await syncSearxng(deps);
		assert.equal((await searxngStatus(deps)).process.phase, "stopped");
		assert.ok(!calls.some((c) => c[0] === "run" || c[0] === "rm"));
		assert.equal(searxngLive(deps), false);
	});

	it("Docker missing or stopped: an honest error, never a launch", async () => {
		for (const [docker, message] of [["not-installed", /Docker isn't installed/], ["not-running", /Docker Desktop isn't running\. Start it, then press Retry\./]] as const) {
			resetSearxngRuntime();
			const { deps, calls } = fakeDeps({ docker });
			await syncSearxng(deps);
			const status = await searxngStatus(deps);
			assert.equal(status.docker, docker);
			assert.equal(status.process.phase, "error");
			assert.match(status.process.error ?? "", message);
			assert.ok(!calls.some((c) => c[0] === "run"), "no container start");
		}
	});

	it("image not installed: waits for Install; the search path says so", async () => {
		const { deps, calls } = fakeDeps({ image: false });
		await syncSearxng(deps);
		const status = await searxngStatus(deps);
		assert.equal(status.image.installed, false);
		assert.equal(status.process.phase, "stopped");
		assert.ok(!calls.some((c) => c[0] === "run"));
		await assert.rejects(searxngBaseUrl(deps), /isn't installed/);
	});

	it("enabled + installed: runs the pinned image on loopback only, writes config + marker, becomes live", async () => {
		const { deps, calls } = fakeDeps();
		await syncSearxng(deps);
		const run = calls.find((c) => c[0] === "run");
		assert.ok(run, "docker run issued");
		assert.ok(run!.includes("--rm"));
		assert.equal(run![run!.indexOf("--name") + 1], SEARXNG_CONTAINER);
		assert.equal(run![run!.indexOf("-p") + 1], "127.0.0.1:45678:8080", "published on loopback only");
		assert.equal(run![run!.length - 1], SEARXNG_IMAGE, "the pinned image");
		assert.ok(calls.findIndex((c) => c[0] === "rm") < calls.findIndex((c) => c[0] === "run"), "a leftover container is removed first");
		assert.match(fs.readFileSync(deps.paths.settingsFile, "utf8"), /secret_key: "test-secret"/);
		assert.ok(fs.existsSync(deps.paths.markerFile));
		assert.equal((await searxngStatus(deps)).process.phase, "running");
		assert.equal(searxngLive(deps), true);
		assert.equal(await searxngBaseUrl(deps), "http://127.0.0.1:45678");
	});

	it("keeps an existing settings.yml (and its secret)", async () => {
		const { deps } = fakeDeps();
		fs.mkdirSync(deps.paths.configDir, { recursive: true });
		fs.writeFileSync(deps.paths.settingsFile, "custom: true\n");
		await syncSearxng(deps);
		assert.equal(fs.readFileSync(deps.paths.settingsFile, "utf8"), "custom: true\n");
	});

	it("switching off removes the container and the marker", async () => {
		const { deps, calls, state } = fakeDeps();
		await syncSearxng(deps);
		state.enabled = false;
		calls.length = 0;
		await syncSearxng(deps);
		assert.deepEqual(calls, [["rm", "-f", SEARXNG_CONTAINER]]);
		assert.equal(fs.existsSync(deps.paths.markerFile), false);
		assert.equal((await searxngStatus(deps)).process.phase, "stopped");
	});

	it("never becomes healthy: a timeout error and the container is removed", async () => {
		const { deps, calls } = fakeDeps({ healthy: false });
		await syncSearxng(deps);
		assert.deepEqual(calls[calls.length - 1], ["rm", "-f", SEARXNG_CONTAINER], "the unhealthy container is removed");
		const status = await searxngStatus(deps);
		assert.equal(status.process.phase, "error");
		assert.match(status.process.error ?? "", /did not become ready/);
	});

	it("Install pulls the pinned image, reports progress, then starts the container", async () => {
		const { deps, calls, finishPull } = fakeDeps({ image: false });
		const started = await startSearxngPull(deps);
		assert.deepEqual(started, { ok: true });
		assert.deepEqual(calls.find((c) => c[0] === "pull"), ["pull", SEARXNG_IMAGE]);
		assert.ok((await searxngStatus(deps)).pull, "pull in progress is visible");
		assert.deepEqual(await startSearxngPull(deps), { ok: false, error: "SearXNG is already being installed." });
		finishPull();
		for (let i = 0; i < 50 && (await searxngStatus(deps)).process.phase !== "running"; i++) await new Promise((r) => setTimeout(r, 5));
		const status = await searxngStatus(deps);
		assert.equal(status.pull, null);
		assert.equal(status.process.phase, "running");
	});

	it("Install refuses when Docker Desktop is down", async () => {
		const { deps } = fakeDeps({ docker: "not-running" });
		const started = await startSearxngPull(deps);
		assert.equal(started.ok, false);
		assert.match(!started.ok ? started.error : "", /Docker Desktop isn't running/);
	});
});
