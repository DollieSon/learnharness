import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_WHISPER_MODEL,
	WHISPER_MAX_WAV_BYTES,
	cleanWhisperText,
	defaultDictationEngine,
	resolveSettings,
	encodeWavPcm16,
	eventBinding,
	releasesBinding,
	sanitizeUserSettings,
	whisperLanguage,
} from "../src/core/index.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";

test("the factory engine follows the server platform: Windows → local Whisper", () => {
	assert.equal(defaultDictationEngine("win32"), "whisper-local");
	assert.equal(defaultDictationEngine("darwin"), "deepgram");
	assert.equal(defaultDictationEngine("linux"), "deepgram");
});

test("the shared language setting maps onto Whisper's codes", () => {
	assert.equal(whisperLanguage("multi"), "auto");
	assert.equal(whisperLanguage("en"), "en");
	assert.equal(whisperLanguage("en-US"), "en");
	assert.equal(whisperLanguage("pt-BR"), "pt");
	assert.equal(whisperLanguage("zh-Hant"), "zh");
	assert.equal(whisperLanguage("nl-BE"), "nl");
	assert.equal(whisperLanguage("tl"), "tl");
});

test("non-speech markers are stripped; real brackets survive", () => {
	assert.equal(cleanWhisperText(" [BLANK_AUDIO] "), "");
	assert.equal(cleanWhisperText("Hello [ Silence ] world (music)"), "Hello world");
	assert.equal(cleanWhisperText("see (figure 2) and [note]"), "see (figure 2) and [note]");
});

test("PCM16 frames become a canonical 16 kHz mono WAV", () => {
	const a = new Int16Array([1, -1]).buffer;
	const b = new Int16Array([2]).buffer;
	const wav = encodeWavPcm16([a, b]);
	const view = new DataView(wav.buffer);
	const text = (from: number, to: number) => new TextDecoder().decode(wav.slice(from, to));
	assert.equal(wav.byteLength, 44 + 6);
	assert.equal(text(0, 4), "RIFF");
	assert.equal(view.getUint32(4, true), 36 + 6);
	assert.equal(text(8, 16), "WAVEfmt ");
	assert.equal(view.getUint16(20, true), 1); // PCM
	assert.equal(view.getUint16(22, true), 1); // mono
	assert.equal(view.getUint32(24, true), 16_000);
	assert.equal(view.getUint16(34, true), 16);
	assert.equal(text(36, 40), "data");
	assert.equal(view.getUint32(40, true), 6);
	assert.deepEqual([...new Int16Array(wav.buffer.slice(44))], [1, -1, 2]);
	assert.equal(WHISPER_MAX_WAV_BYTES, 44 + 600 * 16_000 * 2);
});

test("Int16Array frames (the worklet's real shape) are copied byte-for-byte", () => {
	const samples = new Int16Array([0x1234, -2, 300, -32768, 32767]);
	const offsetView = new Int16Array(new Int16Array([9, 9, 7, -7]).buffer, 4, 2); // a view with a byteOffset
	const wav = encodeWavPcm16([samples, offsetView]);
	assert.equal(new DataView(wav.buffer).getUint32(40, true), 14);
	assert.deepEqual([...new Int16Array(wav.buffer.slice(44))], [0x1234, -2, 300, -32768, 32767, 7, -7]);
});

test("the dictation section keeps each valid field independently", () => {
	const record = sanitizeUserSettings({ version: 1, dictation: { language: "xx", engine: "whisper-local", whisperModel: "small" } });
	assert.deepEqual(record?.dictation, { engine: "whisper-local", whisperModel: "small" });
	assert.deepEqual(sanitizeUserSettings({ version: 1, dictation: { engine: "nope", whisperModel: "tiny" } })?.dictation, {});
	assert.deepEqual(sanitizeUserSettings({ version: 1, dictation: "bad" })?.dictation, {});
});

test("effective dictation: factory model, engine left to the platform when unset", () => {
	assert.deepEqual(resolveSettings(null).dictation, { language: "en", whisperModel: DEFAULT_WHISPER_MODEL });
	assert.deepEqual(
		resolveSettings({ version: 1, dictation: { engine: "deepgram", whisperModel: "base" } }).dictation,
		{ language: "en", whisperModel: "base", engine: "deepgram" },
	);
});

test("the dictation body parser validates every field", () => {
	assert.deepEqual(parseDictationSettingsBody({ language: "fr", engine: "whisper-local", whisperModel: "base" }),
		{ ok: true, settings: { language: "fr", engine: "whisper-local", whisperModel: "base" } });
	assert.deepEqual(parseDictationSettingsBody({}), { ok: true, settings: {} });
	assert.equal(parseDictationSettingsBody({ engine: "openai" }).ok, false);
	assert.equal(parseDictationSettingsBody({ whisperModel: "tiny" }).ok, false);
	assert.equal(parseDictationSettingsBody({ language: "xx" }).ok, false);
});

const key = (init: Partial<KeyboardEvent>) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, code: "", ...init }) as KeyboardEvent;

test("Ctrl+Space normalizes to mod+space; bare Space is unchanged", () => {
	assert.equal(eventBinding(key({ key: " ", ctrlKey: true, code: "Space" })), "mod+space");
	assert.equal(eventBinding(key({ key: " ", code: "Space" })), " ");
});

test("a hold ends when its key or one of its modifiers is released", () => {
	assert.equal(releasesBinding("mod+space", key({ key: " " })), true);
	assert.equal(releasesBinding("mod+space", key({ key: "Control" })), true);
	assert.equal(releasesBinding("mod+space", key({ key: "Meta" })), true);
	assert.equal(releasesBinding("mod+space", key({ key: "a" })), false);
	assert.equal(releasesBinding("mod+space", key({ key: "Shift" })), false);
	assert.equal(releasesBinding("alt+shift+x", key({ key: "Shift" })), true);
});
