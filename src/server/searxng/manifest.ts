/**
 * The app-managed SearXNG engine's pins and on-disk layout (blog review
 * plan M2, owner 2026-11-06).
 *
 * The image is pinned by tag AND digest — Docker refuses an image whose
 * content does not hash to the digest. Bumping the pin means updating the
 * tag and digest together (Docker Hub's tag listing shows both).
 */
import path from "node:path";
import { PATHS } from "../../../config.ts";

/** searxng/searxng, the 2026-10-23 build (two weeks old when pinned). */
export const SEARXNG_IMAGE =
	"searxng/searxng:2026.10.23-629368e40@sha256:aecad882e86eeb022b76351c8dce4eb48d0cbb16a5f1691f77ea32c96d317502";
/** Compressed amd64 size from Docker Hub — the Settings panel's hint. */
export const SEARXNG_IMAGE_SIZE_MB = 98;
/** The one container this app runs (removed by name on every start/stop). */
export const SEARXNG_CONTAINER = "learnharness-searxng";
/** SearXNG's listening port inside the container. */
export const SEARXNG_CONTAINER_PORT = 8080;

/** On-disk layout under the data seam (LH_DATA_DIR in the desktop app). */
export function searxngPaths(dataRoot: string = PATHS.data) {
	const root = path.join(dataRoot, "searxng");
	return {
		root,
		/** Mounted at /etc/searxng — holds the generated settings.yml. */
		configDir: path.join(root, "config"),
		settingsFile: path.join(root, "config", "settings.yml"),
		/** {container} while one runs — the Electron shell removes it on quit. */
		markerFile: path.join(root, "container.json"),
	};
}

export type SearxngPaths = ReturnType<typeof searxngPaths>;

/** The settings.yml this app writes (pure, exported for tests): defaults
 *  kept, JSON output on (SearXNG ships HTML-only), the bot limiter off (a
 *  private engine needs no rate limiting and no Valkey), no image proxy. */
export function searxngSettingsYaml(secretKey: string): string {
	return [
		"# Written by LearnHarness — regenerated if deleted.",
		"use_default_settings: true",
		"server:",
		`  secret_key: "${secretKey}"`,
		"  limiter: false",
		"  image_proxy: false",
		"search:",
		"  safe_search: 0",
		"  formats:",
		"    - html",
		"    - json",
		"",
	].join("\n");
}
