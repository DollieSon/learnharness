/**
 * Blog review sessions (blog review plan M4): the "blog" kind's creation
 * contract, the blog-session prompt fragments, the provisional-title
 * rename when the brief lands, and the client URL normalizer. Runs under
 * an isolated LH_DATA_DIR (set before any config-loading import).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-blog-session-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { POST } = await import("../app/api/chats/route.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { allSegmentPaths } = await import("../src/agent/prompt-segments.ts");
const { isValidSegmentPath } = await import("../src/core/prompt-segments.ts");
const { blogOpeningPrompt, BLOG_TITLE_PREFIX } = await import("../src/core/contracts.ts");
const { normalizeArticleUrl, blogEnabledFrom } = await import("../components/blog-enabled.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { createFauxCore } = await import("@earendil-works/pi-ai");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function post(body: unknown): Promise<Response> {
	return POST(new Request("http://localhost/api/chats", { method: "POST", body: JSON.stringify(body) }));
}

describe("creating a blog session", () => {
	it("stamps kind blog and a provisional site title", async () => {
		const res = await post({ title: blogOpeningPrompt("https://www.blog.example/bees"), kind: "blog", url: "https://www.blog.example/bees" });
		assert.equal(res.status, 200);
		const { id, title } = (await res.json()) as { id: string; title: string };
		assert.equal(title, `${BLOG_TITLE_PREFIX}blog.example`);
		assert.equal(chatStore.getChat(id)?.kind, "blog");
		assert.equal(chatStore.listChats().find((c) => c.id === id)?.kind, "blog");
	});

	it("refuses a blog session without an http(s) URL", async () => {
		for (const url of [undefined, "", "not a url", "file:///etc/passwd", "javascript:alert(1)"]) {
			const res = await post({ title: "x", kind: "blog", url });
			assert.equal(res.status, 400, String(url));
		}
	});
});

describe("blog-session prompts", () => {
	it("prober and teacher compose their blog fragments only in blog sessions", () => {
		const prober = composeInstructions("prober");
		const blogProber = composeInstructions("prober", undefined, true);
		assert.ok(!prober.includes("# This session: a blog review"));
		assert.ok(blogProber.includes("# This session: a blog review"));
		assert.ok(blogProber.includes("Dispatch `blog` with the link at once"));
		const blogTeacher = composeInstructions("teacher", undefined, true);
		assert.ok(blogTeacher.includes("What it gets right and wrong"));
		assert.ok(!blogTeacher.includes("Dispatch `blog` with the link at once"), "the prober fragment stays out of the teacher");
		assert.equal(composeInstructions("practice", undefined, true), composeInstructions("practice"), "practice ignores blog");
	});

	it("blog fragments are known, overridable segments", () => {
		const paths = allSegmentPaths();
		assert.ok(paths.includes("blog-prober/10-blog-probe.md"));
		assert.ok(paths.includes("blog-teacher/10-blog-teach.md"));
		assert.equal(isValidSegmentPath("blog-prober/10-blog-probe.md"), true);
		assert.equal(isValidSegmentPath("blog-other/10-x.md"), false);
	});

	it("normal lessons learn to send article links to the blog tool", () => {
		assert.match(composeInstructions("teacher"), /dispatch `blog` with the URL/);
		assert.match(composeInstructions("prober"), /goes to the `blog` tool/);
	});
});

describe("the brief renames a provisional blog title", () => {
	const BRIEF = JSON.stringify({
		title: "Why bees dance",
		thesis: "Bees share food locations by dancing.",
		outline: ["The dance"],
		claims: [{ id: "c1", claim: "Direction is encoded.", quote: "direction" }],
		takeaways: ["Bees communicate"],
	});

	async function runBlog(chatId: string): Promise<void> {
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		faux.setResponses([{ role: "assistant", content: [{ type: "text", text: BRIEF }] } as never]);
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const job = jobStore.createJob({ kind: "blog", chatId, toolCallId: `tc_${chatId}`, input: { url: "https://blog.example/bees" } });
		const runner = createJobRunner({
			chatStore,
			jobStore,
			deliver: async () => {},
			engineFor: () => engine,
		});
		// The page read is the blog module's seam; here the runner reads a
		// non-public host, so stub the read through the module.
		const blog = await import("../src/agent/subagents/blog.ts");
		const original = blog.blogReaderDeps.read;
		blog.blogReaderDeps.read = async () => ({
			finalUrl: "https://blog.example/bees", status: 200, title: "Why bees dance", isArticle: true,
			markdown: "Bees dance to share where food is. ".repeat(20), findings: [], rendered: true, blockedRequests: 0,
		});
		try {
			await runner.runJob(job.id, { url: "https://blog.example/bees" });
		} finally {
			blog.blogReaderDeps.read = original;
		}
	}

	it("renames 'Blog · site' to the article title", async () => {
		const chat = chatStore.createChat(`${BLOG_TITLE_PREFIX}blog.example`, "blog");
		await runBlog(chat.id);
		assert.equal(chatStore.getChat(chat.id)?.title, "Why bees dance");
	});

	it("keeps a title the learner already changed, and never renames other kinds", async () => {
		const renamed = chatStore.createChat("My bee notes", "blog");
		await runBlog(renamed.id);
		assert.equal(chatStore.getChat(renamed.id)?.title, "My bee notes");
		const lesson = chatStore.createChat(`${BLOG_TITLE_PREFIX}blog.example`);
		await runBlog(lesson.id);
		assert.equal(chatStore.getChat(lesson.id)?.title, `${BLOG_TITLE_PREFIX}blog.example`);
	});
});

describe("client helpers", () => {
	it("normalizeArticleUrl accepts http(s) links and bare domains", () => {
		assert.equal(normalizeArticleUrl("https://blog.example/post"), "https://blog.example/post");
		assert.equal(normalizeArticleUrl("  blog.example/post "), "https://blog.example/post");
		assert.equal(normalizeArticleUrl("ftp://blog.example/x"), null);
		assert.equal(normalizeArticleUrl("javascript:alert(1)"), null);
		assert.equal(normalizeArticleUrl("two words"), null);
		assert.equal(normalizeArticleUrl("localhost"), null);
		assert.equal(normalizeArticleUrl(""), null);
	});

	it("blogEnabledFrom: absent = on, explicit false = off", () => {
		assert.equal(blogEnabledFrom(null), true);
		assert.equal(blogEnabledFrom({ agent: { tools: {} } }), true);
		assert.equal(blogEnabledFrom({ agent: { tools: { blog: false } } }), false);
	});
});
