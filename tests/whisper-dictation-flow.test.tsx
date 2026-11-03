import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { HOLD_DICTATION_END_EVENT, HOLD_DICTATION_START_EVENT, useDictation, type Dictation } from "../components/dictation.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { useDictationLanguage } from "../components/dictation-preference.ts";
import { WHISPER_NOT_READY_PREFIX } from "../components/whisper-client.ts";
import { DICTATION_TAP_DISCARD_MS, type UserSettings } from "../src/core/index.ts";
import { whisperStatusFixture } from "./helpers/whisper-status.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Worklet {
	static all: Worklet[] = [];
	port: { onmessage?: (event: { data: unknown }) => void } = {};
	constructor() { Worklet.all.push(this); }
	connect() {}
	disconnect() {}
	/** One 2048-sample PCM16 frame (what pcm-capture.js posts). */
	frame(value = 1) {
		const samples = new Int16Array(2048).fill(value);
		this.port.onmessage?.({ data: { type: "audio", buffer: samples.buffer } });
	}
}

interface Transcription { url: string; headers: Headers; body: Uint8Array; signal?: AbortSignal | null }

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

async function fixture() {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		record: { version: 1, dictation: { language: "en", engine: "whisper-local" } } as UserSettings,
		appends: [] as string[],
		tokenCalls: 0,
		sockets: 0,
		transcriptions: [] as Transcription[],
		nextTranscription: undefined as Promise<Response> | undefined,
	};
	Worklet.all = [];
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
		WebSocket: class { constructor() { state.sockets++; } },
		AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/stt/token") { state.tokenCalls++; return Response.json({ token: "unused" }); }
			if (url === "/api/stt/whisper/status") return Response.json(whisperStatusFixture({ platformSupported: true, defaultEngine: "whisper-local", engine: "whisper-local" }));
			if (url === "/api/settings") return Response.json({ settings: state.record });
			if (url.startsWith("/api/stt/whisper/transcribe")) {
				state.transcriptions.push({
					url, headers: new Headers(init?.headers), body: new Uint8Array(await new Response(init!.body).arrayBuffer()), signal: init?.signal,
				});
				if (state.nextTranscription) { const next = state.nextTranscription; state.nextTranscription = undefined; return next; }
				return Response.json({ text: "hello world" });
			}
			throw new Error(`unexpected fixture request ${url}`);
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	const { createRoot } = await import("react-dom/client");
	let latest!: Dictation;
	let setting!: ReturnType<typeof useDictationLanguage>;
	function Harness() {
		latest = useDictation({ append: (text) => state.appends.push(text) });
		setting = useDictationLanguage();
		return null;
	}
	const root = createRoot(document.getElementById("root")!);
	await act(async () => { root.render(<Harness />); });
	// Invalidate the window-lifetime preference cache from an earlier fixture.
	if (setting.language !== undefined) await act(async () => { notifySettingsSaved("dictation"); });
	dispose = async () => { await act(async () => { root.unmount(); }); };
	const hold = (event: string) => act(async () => { window.dispatchEvent(new CustomEvent(event)); });
	return { state, get dictation() { return latest; }, hold };
}

/** Let the async transcribe chain (Blob body reads, fetch) settle. */
async function until(condition: () => boolean, label: string) {
	for (let i = 0; i < 50 && !condition(); i++) {
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
	}
	assert.ok(condition(), `timed out waiting for: ${label}`);
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("local Whisper: no token or socket; frames become one WAV request whose text flushes once", async () => {
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "recording");
	const worklet = Worklet.all[0]!;
	await act(async () => { worklet.frame(); worklet.frame(); worklet.frame(); });
	await act(async () => { f.dictation.stop(); });
	await until(() => f.dictation.phase === "idle", "the run to end");
	assert.equal(f.state.transcriptions.length, 1);
	const request = f.state.transcriptions[0]!;
	assert.equal(request.url, "/api/stt/whisper/transcribe?language=en");
	assert.equal(request.headers.get("content-type"), "audio/wav");
	assert.equal(request.headers.get("x-learnharness-whisper"), "1");
	assert.equal(request.body.byteLength, 44 + 3 * 4096);
	assert.equal(new TextDecoder().decode(request.body.slice(0, 4)), "RIFF");
	assert.deepEqual(f.state.appends, ["hello world"]);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.tokenCalls, 0, "local Whisper never mints a Deepgram token");
	assert.equal(f.state.sockets, 0);
});

test("hold-to-talk: a tap under the threshold is discarded untranscribed", async () => {
	const f = await fixture();
	await f.hold(HOLD_DICTATION_START_EVENT);
	assert.notEqual(f.dictation.phase, "idle");
	await act(async () => { Worklet.all[0]?.frame(); });
	await f.hold(HOLD_DICTATION_END_EVENT);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.transcriptions.length, 0);
	assert.deepEqual(f.state.appends, []);
});

test("hold-to-talk: a real hold stops on release and keeps the text", async () => {
	const f = await fixture();
	const realNow = Date.now;
	let now = 1_000_000;
	Date.now = () => now;
	try {
		await f.hold(HOLD_DICTATION_START_EVENT);
		await act(async () => { Worklet.all[0]!.frame(); });
		now += DICTATION_TAP_DISCARD_MS + 1;
		await f.hold(HOLD_DICTATION_END_EVENT);
		await until(() => f.dictation.phase === "idle", "the run to end");
	} finally {
		Date.now = realNow;
	}
	assert.equal(f.state.transcriptions.length, 1);
	assert.deepEqual(f.state.appends, ["hello world"]);
	assert.equal(f.dictation.phase, "idle");
});

test("hold-to-talk leaves a toggled run alone", async () => {
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	await f.hold(HOLD_DICTATION_START_EVENT);
	await f.hold(HOLD_DICTATION_END_EVENT);
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.state.transcriptions.length, 0);
});

test("a not-ready refusal becomes the Settings deep-link error", async () => {
	const f = await fixture();
	f.state.nextTranscription = Promise.resolve(Response.json(
		{ error: "Local Whisper isn't installed. Download it in Settings → Providers → Dictation.", code: "whisper_not_ready", reason: "server-missing" },
		{ status: 503 },
	));
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { Worklet.all[0]!.frame(); });
	await act(async () => { f.dictation.stop(); });
	await until(() => f.dictation.phase === "idle", "the run to end");
	assert.ok(f.dictation.error?.startsWith(WHISPER_NOT_READY_PREFIX), f.dictation.error ?? "no error");
	assert.deepEqual(f.state.appends, []);
});

test("cancel while transcribing aborts the request and discards its text", async () => {
	const f = await fixture();
	const pending = deferred<Response>();
	f.state.nextTranscription = pending.promise;
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { Worklet.all[0]!.frame(); });
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping");
	await until(() => f.state.transcriptions.length === 1, "the request");
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.state.transcriptions[0]!.signal?.aborted, true);
	await act(async () => { pending.resolve(Response.json({ text: "too late" })); });
	assert.deepEqual(f.state.appends, []);
	assert.equal(f.dictation.phase, "idle");
});

test("stopping with no captured audio ends without a request", async () => {
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.transcriptions.length, 0);
});
