/**
 * Blog review M5: the fact-checked write-up and its auto-save. The pure
 * helpers (source path, write-up) plus the runner's save contract: only a
 * successful fact-check saves, through the injected saver, and the result
 * carries the source id. Runs under an isolated LH_DATA_DIR.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { BlogResult, FactCheckResult } from "../src/core/contracts.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-blog-save-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { blogSourcePath, blogWriteUp, canonicalArticleUrl } = await import("../src/agent/subagents/blog.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { createFauxCore } = await import("@earendil-works/pi-ai");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function blogResult(over: Partial<BlogResult> = {}): BlogResult {
	return {
		url: "https://blog.example/bees",
		finalUrl: "https://blog.example/bees",
		title: "Why bees dance",
		thesis: "Bees use the waggle dance to share where food is.",
		outline: ["The dance"],
		claims: [{ id: "c1", claim: "The dance encodes direction.", quote: "encodes direction" }],
		takeaways: ["Bees communicate"],
		hidden: { findings: [], judge: null, judgeSkipped: false, blockedRequests: 0 },
		fullText: "Bees dance. ".repeat(30),
		fullTextTruncated: false,
		autoShared: false,
		...over,
	};
}

describe("the source path", () => {
	it("one source per article: tracking parameters and fragments don't split it", () => {
		assert.equal(canonicalArticleUrl("https://blog.example/a?utm_source=x&id=3#top"), "https://blog.example/a?id=3");
		const a = blogSourcePath("https://www.blog.example/2024/why-bees-dance/?utm_medium=feed");
		assert.equal(a, "Blog reviews/blog.example › 2024 › why-bees-dance.md");
		assert.equal(blogSourcePath("https://blog.example/2024/why-bees-dance/#comments"), a);
		assert.equal(blogSourcePath("https://blog.example/"), "Blog reviews/blog.example.md");
	});
});

describe("the write-up", () => {
	it("records wrong claims only as errors with their correction, and never the raw article", () => {
		const blog = blogResult({ fullText: "SECRET RAW ARTICLE TEXT", takeaways: ["an unchecked takeaway"] });
		const check: FactCheckResult = {
			blogJobId: "job_b", url: blog.url, title: blog.title, summary: "Partly reliable.",
			verdicts: [
				{ claimId: "c1", claim: "Bees dance only at night.", verdict: "wrong", explanation: "They dance in the hive at any time of day.", sources: [{ title: "Ref", url: "https://ref.example" }] },
				{ claimId: "c2", claim: "The dance encodes direction.", verdict: "supported", explanation: "Von Frisch showed it.", sources: [] },
				{ claimId: "c3", claim: "All bees dance.", verdict: "misleading", explanation: "Only some species do.", sources: [] },
				{ claimId: "c4", claim: "Bees count to five.", verdict: "unverifiable", explanation: "No good evidence found.", sources: [] },
			],
			omissions: ["Other species"], relatedTopics: ["Ethology"],
		};
		const text = blogWriteUp(blog, check, new Date("2026-11-06T00:00:00Z"));
		assert.match(text, /The article claims that Bees dance only at night\. This is wrong\. Correction: They dance in the hive/);
		assert.match(text, /This is misleading: Only some species do\./);
		assert.match(text, /Unverified: the article claims that Bees count to five\./);
		assert.match(text, /\[Ref\]\(https:\/\/ref\.example\)/);
		assert.match(text, /Reviewed and fact-checked on 2026-11-06/);
		assert.doesNotMatch(text, /SECRET RAW ARTICLE TEXT/);
		assert.doesNotMatch(text, /an unchecked takeaway/);
	});
});

describe("auto-save after the fact-check", () => {
	function engineReplying(text: string) {
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		faux.setResponses([{ role: "assistant", content: [{ type: "text", text }] } as never]);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	}

	async function runCheck(reply: string, saver: (input: { filePath: string; text: string }) => string | null) {
		const chat = chatStore.createChat("Blog · blog.example", "blog");
		const blogJob = jobStore.createJob({ kind: "blog", chatId: chat.id, toolCallId: `tcb_${chat.id}`, input: { url: "https://blog.example/bees" } });
		jobStore.updateJob(blogJob.id, { status: "done", result: blogResult() });
		const check = jobStore.createJob({ kind: "fact_check", chatId: chat.id, toolCallId: `tcf_${chat.id}`, input: { blog_job: blogJob.id } });
		const runner = createJobRunner({
			chatStore,
			jobStore,
			deliver: async () => {},
			engineFor: () => engineReplying(reply),
			saveBlogSource: saver,
		});
		await runner.runJob(check.id, { blog_job: blogJob.id });
		return jobStore.getJob(check.id)!.result as FactCheckResult;
	}

	it("a successful check saves the write-up and the result names the source", async () => {
		const calls: { filePath: string; text: string }[] = [];
		const result = await runCheck(
			JSON.stringify({ summary: "Fine.", verdicts: [{ claimId: "c1", verdict: "supported", explanation: "Yes.", sources: [] }], omissions: [], relatedTopics: [] }),
			(input) => {
				calls.push(input);
				return "src_test";
			},
		);
		assert.equal(result.error, undefined);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.filePath, "Blog reviews/blog.example › bees.md");
		assert.match(calls[0]!.text, /# Fact-checked review: Why bees dance/);
		assert.equal(result.savedSourceId, "src_test");
	});

	it("a failed check saves nothing", async () => {
		const calls: unknown[] = [];
		const result = await runCheck("I could not check anything.", (input) => {
			calls.push(input);
			return "src_test";
		});
		assert.ok(result.error);
		assert.equal(calls.length, 0);
		assert.equal(result.savedSourceId, undefined);
	});

	it("saving off (graph disabled) leaves no source id; a throwing saver never fails the check", async () => {
		const off = await runCheck(
			JSON.stringify({ summary: "Fine.", verdicts: [{ claimId: "c1", verdict: "supported", explanation: "Yes.", sources: [] }], omissions: [], relatedTopics: [] }),
			() => null,
		);
		assert.equal(off.error, undefined);
		assert.equal(off.savedSourceId, undefined);
		const broken = await runCheck(
			JSON.stringify({ summary: "Fine.", verdicts: [{ claimId: "c1", verdict: "supported", explanation: "Yes.", sources: [] }], omissions: [], relatedTopics: [] }),
			() => {
				throw new Error("disk full");
			},
		);
		assert.equal(broken.error, undefined);
	});
});
