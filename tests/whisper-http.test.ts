import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// An isolated data dir BEFORE any server module reads config.ts.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-whisper-http-"));
process.env.LH_DATA_DIR = DATA;
after(() => fs.rmSync(DATA, { recursive: true, force: true }));

const {
	whisperCancelResponse,
	whisperDownloadResponse,
	whisperStatusResponse,
	whisperTranscribeResponse,
} = await import("../src/server/whisper/http.ts");
const { encodeWavPcm16 } = await import("../src/core/index.ts");

const ORIGIN = "http://127.0.0.1:3000";
function request(pathname: string, init: RequestInit & { intent?: boolean } = {}) {
	const headers = new Headers(init.headers);
	if (init.intent !== false) headers.set("x-learnharness-whisper", "1");
	headers.set("host", "127.0.0.1:3000");
	return new Request(`${ORIGIN}${pathname}`, { ...init, headers });
}
const writeSettings = (dictation: Record<string, unknown>) =>
	fs.writeFileSync(path.join(DATA, "settings.json"), JSON.stringify({ version: 1, dictation }));

test("every route requires the same-origin intent header", async () => {
	assert.equal((await whisperStatusResponse(request("/api/stt/whisper/status", { intent: false }))).status, 403);
	assert.equal((await whisperStatusResponse(request("/api/stt/whisper/status", { headers: { "sec-fetch-site": "cross-site" } }))).status, 403);
	assert.equal((await whisperDownloadResponse(request("/api/stt/whisper/download", { method: "POST", headers: { origin: "https://evil.test" }, body: "{}" }))).status, 403);
	assert.equal((await whisperCancelResponse(request("/api/stt/whisper/cancel", { method: "POST", intent: false }))).status, 403);
	assert.equal((await whisperTranscribeResponse(request("/api/stt/whisper/transcribe?language=en", { method: "POST", intent: false }))).status, 403);
	assert.equal((await whisperStatusResponse(request("/api/stt/whisper/status", { method: "POST" }))).status, 403, "wrong method");
});

test("status reflects the platform default and the saved engine/model", async () => {
	fs.rmSync(path.join(DATA, "settings.json"), { force: true });
	const fresh = await (await whisperStatusResponse(request("/api/stt/whisper/status"))).json();
	assert.equal(fresh.platformSupported, process.platform === "win32");
	assert.equal(fresh.defaultEngine, process.platform === "win32" ? "whisper-local" : "deepgram");
	assert.equal(fresh.engine, fresh.defaultEngine);
	assert.equal(fresh.model, "large-v3-turbo");
	assert.deepEqual(fresh.models.map((m: { id: string }) => m.id), ["base", "small", "large-v3-turbo"]);
	assert.equal(fresh.server.installed, false);
	writeSettings({ engine: "deepgram", whisperModel: "small" });
	const saved = await (await whisperStatusResponse(request("/api/stt/whisper/status"))).json();
	assert.equal(saved.engine, "deepgram");
	assert.equal(saved.model, "small");
});

test("download rejects unknown targets", async () => {
	const response = await whisperDownloadResponse(request("/api/stt/whisper/download", {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "../../etc" }),
	}));
	assert.equal(response.status, 400);
});

test("transcribe validates type, language and size before touching whisper", async () => {
	const wav = encodeWavPcm16([new Int16Array(160).buffer]);
	const post = (query: string, headers: Record<string, string>, body: BodyInit = new Blob([new Uint8Array(wav)])) =>
		whisperTranscribeResponse(request(`/api/stt/whisper/transcribe${query}`, { method: "POST", headers, body }));
	assert.equal((await post("?language=en", { "content-type": "application/json" })).status, 415);
	assert.equal((await post("?language=xx", { "content-type": "audio/wav" })).status, 400);
	assert.equal((await post("?language=en", { "content-type": "audio/wav", "content-length": String(30 * 1024 * 1024) })).status, 413);
	assert.equal((await post("?language=en", { "content-type": "audio/wav" }, new Blob([new Uint8Array(10)]))).status, 400);
});

test("transcribe refuses with the not-ready code when local Whisper is not selected", async () => {
	writeSettings({ engine: "deepgram" });
	const wav = encodeWavPcm16([new Int16Array(160).buffer]);
	const response = await whisperTranscribeResponse(request("/api/stt/whisper/transcribe?language=en", {
		method: "POST", headers: { "content-type": "audio/wav" }, body: new Blob([new Uint8Array(wav)]),
	}));
	assert.equal(response.status, 503);
	const body = await response.json();
	assert.equal(body.code, "whisper_not_ready");
	assert.equal(body.reason, process.platform === "win32" ? "engine-off" : "unsupported-platform");
});
