# Plan: blog review lessons + local search

Status: **approved by the owner 2026-11-06.** Branch `feat/blog-review`
(from `feat/local-whisper-dictation`), one commit per milestone.

## Goal

1. **Local search** — a self-hosted SearXNG engine, managed by the app, so
   research and fact-checking need no paid search API.
2. **Blog review lessons** — the learner gives a link to a blog they read;
   the app reads it locally and safely, quizzes the learner's recall, then
   teaches the blog back with a fact-check (wrong / misleading / omitted
   claims, with sources) and related topics, and saves a fact-checked
   version to the knowledge graph.

## Owner decisions (2026-11-06)

| Topic | Decision |
|---|---|
| Lesson flow | **Recall first.** PROBE: the learner's recall (main claim, key takeaway, anything that seemed off), no hints. TEACH: the agent's summary of the blog, the fact-check findings with sources, omissions, related topics, and check questions on each part. |
| Entry points | **Both**: a "Review a blog" button (home + new-session screens) that starts a fresh lesson, AND pasting an article link into any lesson. |
| Saving | **Auto-save** every reviewed blog as a source, built from the **fact-checked write-up** (never the raw blog text), so false claims enter the graph only as flagged errors. |
| Search engine | **SearXNG, managed by the app** through Docker (like the local Whisper server). **Amended during M2:** the container runs **only while the app is open** (`docker run --rm`, stopped on quit; no background restarts); a **free loopback port** is picked per start (no port setting); if Docker Desktop isn't running the app **shows a message + Retry** and never launches it. |
| Engine order | **SearXNG first** when enabled and healthy, then Tavily, then Brave. An explicit engine pin still wins; nothing ever silently switches engines. |
| Page rendering | **Plain download + Readability first**; only when that yields no article, render in the **local sandboxed Chromium** (the app's Electron browser-service, system Chrome fallback). **The Jina Reader fallback is removed.** **Amended during M1: blog lessons ALWAYS render** (only the rendered page's computed styles reveal text hidden by external CSS); research fetches stay fast-first. No browser available → blogs use the fast path with a "reduced hidden-text detection" note. |
| What the teacher sees | **Default: the reader's brief + short verbatim quotes** (never the full page). Optional **full article text, fenced as untrusted data** — a global Settings default (off) **plus** a per-lesson "Use full text" toggle on the blog's link card. |
| Hidden-text detection | A **rule-based scanner** (no AI, no tokens) **always runs**: it strips hidden content before any agent sees the page and shows the learner a warning card with the hidden text. An **isolated AI injection judge** (no tools, cheap model) adds a verdict to the card — **only when the global "AI injection check" setting is on; off by default** (saves tokens). No per-lesson toggle for the judge. |

## Defaults proposed with the plan (accepted with approval)

- Fact-check at most **8 claims** per blog (the reader ranks claims by centrality).
- One commit per milestone; no Claude attribution lines in commits or PRs.

## Milestones

### M1 — Reading pages locally and safely
Files: `src/agent/tools/web.ts`, `src/agent/subagents/headless.ts`, new
`src/agent/tools/url-guard.ts`, new `src/agent/tools/hidden-content.ts`.

- [x] Delete `fetchViaJina`. When Readability yields no article, render the
      page through the existing browser helper (`withBrowserPage`), take the
      rendered DOM, and run Readability on it.
- [x] URL guard: http(s) only; resolve the host and refuse loopback,
      private (RFC 1918 / ULA), link-local, CGNAT, unspecified and cloud
      metadata addresses; re-check every redirect hop (manual redirect
      following, capped).
- [x] Hidden-content scanner (pure, no AI): on the static HTML (linkedom)
      it finds HTML comments, `hidden` / `aria-hidden="true"` elements,
      inline-style `display:none` / `visibility:hidden` / `opacity:0` /
      `font-size:0–1px` / off-screen positioning / clip-to-zero,
      `<template>` / `<noscript>`, and zero-width / bidi-control characters.
      On the rendered path it additionally uses computed styles (including
      text colour equal to background). Returns `{ cleanHtml, findings[] }`
      where each finding is `{ kind, text }` (text trimmed + capped).
- [x] Rendered pages: block every browser sub-request to non-public
      addresses or non-http(s) schemes (request interception — the page's
      own scripts must not reach the app's local API or the home network);
      clear the helper's cookies after each render.
- [x] A `readPage(url, { render })` entry point returning title, markdown,
      final URL, findings and whether it rendered — `web_fetch` uses it
      fast-first; the blog job (M3) uses `render: "always"`.
- [x] Tests for the guard, the scanner and the render fallback (headless
      override seam, no real browser or network).

### M2 — SearXNG managed by the app
Files: new `src/server/searxng/` (modelled on `src/server/whisper/`),
`src/core/search.ts`, `src/server/search.ts`, settings contracts + UI, new
`docs/searxng.md`.

- [x] Docker manager: detect the `docker` CLI and a running daemon; write
      `settings.yml` into the data dir (`search.formats: [html, json]`,
      random `server.secret_key`, `server.limiter: false`); run a pinned
      `searxng/searxng` image as container `learnharness-searxng`, published
      on `127.0.0.1` only, on a free port per start, `--rm` (runs only while the app is open),
      the settings dir mounted at `/etc/searxng`. Start / stop / status /
      health (a JSON test query).
- [x] `searxng` adapter behind the search port: `GET {base}/search?q=…&format=json`
      → `{title, url, snippet}`.
- [x] `SearchEngineId` gains `"searxng"`; resolution order SearXNG → Tavily
      → Brave; SearXNG is "live" when enabled in settings and healthy. Pin
      rule unchanged (pinned + not live = honestly unavailable).
- [x] Settings panel beside the search settings: Docker status, the on/off
      switch, Install, Retry, "Test search".
- [x] `docs/searxng.md` (setup, how it works, troubleshooting) + tests
      (adapter with stub fetch, resolution order, manager with a fake
      docker runner).

### M3 — The `blog` background job
Files: `src/core/contracts/jobs.ts`, `src/core/pending.ts`,
`src/agent/tools/jobs.ts`, `src/agent/subagents/blog.ts`, the job runner,
`src/core/input-events.ts`, `components/artifacts/blog-card.tsx`, settings
contracts + UI.

Amendments (owner, 2026-11-06, while building M3):
- **Two jobs, not one.** A job delivers exactly one result message, so the
  brief and the fact-check are separate jobs: `blog { url }` delivers the
  brief, and its result message tells the agent to dispatch
  `fact_check { blog_job }` right away. Both tools are in the prober's and
  the teacher's registries (a blog link usually opens the lesson).
- **One "blog" switch.** `Tool · blog` turns off both `blog` and
  `fact_check`.
- **Full text is a one-way share.** A model can't "unsee" text, so the per-
  lesson control is a "Share full text with the agent" button on the link
  card (a new `share-blog-text` input; refused while a question is open or
  after it was shared). The global "share full text" setting shares it
  automatically with the brief.
- The reader, judge and fact-checker run on the researcher's model.

- [x] Job kinds `blog` and `fact_check` (one `blog` toggle); tools `blog
      { url }` and `fact_check { blog_job }`. `fact_check` refuses up front
      unless the id names a finished blog job in the same lesson.
- [x] Stage 1 — fetch, clean, scan (M1), always rendered.
- [x] Stage 2 — hidden-content warning: if the scanner found anything, the
      link card shows the hidden text. When "AI injection check" is on,
      an isolated judge (no tools; the hidden text fenced as untrusted)
      adds a verdict to the card.
- [x] Stage 3 — reader: an isolated agent with no tools turns the fenced
      clean text into a structured brief: title, author, date, thesis,
      outline, claims (each with a short verbatim quote, ranked by
      centrality), takeaways. Delivered FIRST so the recall probe can start.
- [x] Stage 4 — fact-checker (`fact_check` job): an isolated agent with
      only `web_search` + `web_fetch` checks the top 8 claims → verdict
      (supported / wrong / misleading / unverifiable) + explanation +
      sources; also lists omissions and related topics.
- [x] Link card (title, site, byline, warning, brief, share button) and
      fact-check card (verdicts, sources, omissions, related topics).
      Page-derived text renders as plain text; only http(s) links are links.
- [x] Settings `agent.blog`: "share full text" (default off) and "AI
      injection check" (default off).
- [x] Tests with scripted fake engines (no network): `tests/blog-review.test.ts`.

### M4 — The blog lesson flow
Amended (owner, 2026-11-06): blog lessons are their own session kind.
Recall questions follow the global Quizzing setting.

- [x] `ChatKind` gains `"blog"`. `POST /api/chats { kind: "blog", url }`
      requires an http(s) URL (400 otherwise); the title starts as
      "Blog · <site>" and is renamed to the article title when the brief
      arrives; the first learner message is "Review this article with me:
      <url>".
- [x] Blog sessions run prober → teacher like a lesson, plus blog-only
      prompt fragments (`src/agent/prompts/blog/`, overridable in Settings):
      the prober dispatches `blog` at once, asks the goal while it reads,
      runs recall questions (main claim, takeaway, anything that seemed
      off) graded against the brief, dispatches `fact_check`, then
      `probe_done`; the teacher teaches the summary, the fact-check
      findings with sources, omissions and related topics, with check
      questions on each.
- [x] Normal lessons: one instruction — an article link the learner wants
      to learn from → dispatch `blog`.
- [x] UI: home mode switch Teach | Practice | Blog (Blog shows a URL
      field); sidebar "New blog review" button, globe badge, filter
      Teach | Practice | Blog | All; `/chat/new?mode=blog`; header chip
      "Blog".
- [x] Session extraction stays on for blog sessions (M5 adds the
      fact-checked write-up as a source).

### M5 — Saving to the graph
Decided (owner, 2026-11-06, before the autonomous run):
- Only a **successful** fact-check saves; a failed check saves nothing
  (re-running `fact_check` saves then).
- **Every** fact-checked blog saves — blog sessions and links pasted into
  normal lessons alike.
- **One source per article URL**: a later fact-check of the same URL
  re-runs extraction into that same source.
- Saved write-ups go into a **"Blog reviews"** folder in Sources, named by
  site and path.
- Nothing saves when the graph or extraction is switched off.

- [x] After a successful fact-check, build the fact-checked write-up (each
      claim with its verdict, explanation and sources; false claims only as
      flagged errors with their correction; omissions; related topics) —
      never the raw article text — and run it through the notes import
      pipeline as the URL's source. The fact-check card says when it saved.

### M6 — Tests, docs and delivery
- [x] Full test suite green (excluding known environment-only failures).
- [x] `docs/architecture.md` updated; this plan's checkboxes ticked.
- [x] Live end-to-end test: local SearXNG (installed through the app) and
      one real blog in a blog session; the test session is deleted after.
- [ ] One PR from `feat/blog-review` (it carries the local-whisper commits)
      into the fork's `main` (DollieSon/learnharness), conflicts resolved.

## Safety rules (apply to every milestone)

- Page text is **data, never instructions**: always fenced as untrusted
  when shown to any model; agents that read page text hold **no file or
  graph tools**.
- The teacher (which holds file and graph tools) sees only the brief +
  quotes unless full text is explicitly enabled.
- No outside reading services; page fetches pass the URL guard.

## Risks accepted

- SearXNG needs Docker Desktop running and a ~200MB image download.
- Upstream engines (Google especially) sometimes block SearXNG; result
  quality varies.
- Fact-checks cost model tokens and take a minute or two (the recall
  probe runs meanwhile); verdicts are only as good as the sources found.
- A large change to the fork makes merging upstream updates harder.
