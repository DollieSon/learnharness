/**
 * The pinned local-Whisper downloads (local Whisper wave, 2026-11-03).
 *
 * Owner decisions: Windows only, CUDA 12.4 build only, three curated models.
 * Every artifact is pinned by URL AND SHA-256 — a download that does not hash
 * to the pinned value is discarded, never installed. Bumping a pin means
 * updating the URL, size and digest together (the digests come from the
 * GitHub release asset `digest` field and Hugging Face's LFS oid).
 */
import path from "node:path";
import { PATHS } from "../../../config.ts";
import type { WhisperModelId } from "../../core/dictation.ts";

export interface WhisperArtifact {
	url: string;
	sha256: string;
	sizeBytes: number;
}

/** whisper.cpp release b5454 (2026-10-06, the build behind v1.9.5). */
export const WHISPER_SERVER_BUILD = "b5454";

export const WHISPER_SERVER_ARTIFACT: WhisperArtifact = {
	url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_SERVER_BUILD}/whisper-bin-win-cuda-12.4.0-x64.zip`,
	sha256: "afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a",
	sizeBytes: 684_913_404,
};

/** The zip's top-level folder that holds whisper-server.exe and its DLLs. */
export const WHISPER_SERVER_ZIP_DIR = "Release";
export const WHISPER_SERVER_EXE = "whisper-server.exe";

/** ggerganov/whisper.cpp on Hugging Face, pinned to one commit. */
const HF_COMMIT = "5359861c739e955e79d9a303bcbc70fb988958b1";
const hf = (file: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/${HF_COMMIT}/${file}`;

export const WHISPER_MODEL_ARTIFACTS: Record<WhisperModelId, WhisperArtifact & { label: string }> = {
	"base": {
		label: "Base",
		url: hf("ggml-base.bin"),
		sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
		sizeBytes: 147_951_465,
	},
	"small": {
		label: "Small",
		url: hf("ggml-small.bin"),
		sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
		sizeBytes: 487_601_967,
	},
	"large-v3-turbo": {
		label: "Large v3 Turbo",
		url: hf("ggml-large-v3-turbo.bin"),
		sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
		sizeBytes: 1_624_555_275,
	},
};

/** On-disk layout under the data seam (LH_DATA_DIR in the desktop app). */
export function whisperPaths(dataRoot: string = PATHS.data) {
	const root = path.join(dataRoot, "whisper");
	const binDir = path.join(root, "bin", WHISPER_SERVER_BUILD);
	return {
		root,
		binDir,
		serverExe: path.join(binDir, WHISPER_SERVER_EXE),
		modelsDir: path.join(root, "models"),
		model: (id: WhisperModelId) => path.join(root, "models", `ggml-${id}.bin`),
		/** In-progress downloads and extraction scratch space. */
		downloadDir: path.join(root, ".download"),
		/** {pid} of the running whisper-server, for stale-process cleanup. */
		pidFile: path.join(root, "server.pid"),
	};
}

export type WhisperPaths = ReturnType<typeof whisperPaths>;
