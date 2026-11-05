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
| Search engine | **SearXNG, managed by the app** through Docker (like the local Whisper server). |
| Engine order | **SearXNG first** when enabled and healthy, then Tavily, then Brave. An explicit engine pin still wins; nothing ever silently switches engines. |
| Page rendering | **Plain download + Readability first**; only when that yields no article, render in the **local sandboxed Chromium** (the app's Electron browser-service, system Chrome fallback). **The Jina Reader fallback is removed.** |
| What the teacher sees | **Default: the reader's brief + short verbatim quotes** (never the full page). Optional **full article text, fenced as untrusted data** — a global Settings default (off) **plus** a per-lesson "Use full text" toggle on the blog's link card. |
| Hidden-text detection | A **rule-based scanner** (no AI, no tokens) **always runs**: it strips hidden content before any agent sees the page and shows the learner a warning card with the hidden text. An **isolated AI injection judge** (no tools, cheap model) adds a verdict to the card — **only when the global "AI injection check" setting is on; off by default** (saves tokens). No per-lesson toggle for the judge. |

## Defaults proposed with the plan (accepted with approval)

- Fact-check at most **8 claims** per blog (the reader ranks claims by centrality).
- One commit per milestone; no Claude attribution lines in commits or PRs.

## Milestones

### M1 — Reading pages locally and safely
Files: `src/agent/tools/web.ts`, `src/agent/subagents/headless.ts`, new
`src/agent/tools/url-guard.ts`, new `src/agent/tools/hidden-content.ts`.

- [ ] Delete `fetchViaJina`. When Readability yields no article, render the
      page through the existing browser helper (`withBrowserPage`), take the
      rendered DOM, and run Readability on it.
- [ ] URL guard: http(s) only; resolve the host and refuse loopback,
      private (RFC 1918 / ULA), link-local, CGNAT, unspecified and cloud
      metadata addresses; re-check every redirect hop (manual redirect
      following, capped).
- [ ] Hidden-content scanner (pure, no AI): on the static HTML (linkedom)
      it finds HTML comments, `hidden` / `aria-hidden="true"` elements,
      inline-style `display:none` / `visibility:hidden` / `opacity:0` /
      `font-size:0–1px` / off-screen positioning / clip-to-zero,
      `<template>` / `<noscript>`, and zero-width / bidi-control characters.
      On the rendered path it additionally uses computed styles (including
      text colour equal to background). Returns `{ cleanHtml, findings[] }`
      where each finding is `{ kind, text }` (text trimmed + capped).
- [ ] Tests for the guard, the scanner and the render fallback (headless
      override seam, no real browser or network).

### M2 — SearXNG managed by the app
Files: new `src/server/searxng/` (modelled on `src/server/whisper/`),
`src/core/search.ts`, `src/server/search.ts`, settings contracts + UI, new
`docs/searxng.md`.

- [ ] Docker manager: detect the `docker` CLI and a running daemon; write
      `settings.yml` into the data dir (`search.formats: [html, json]`,
      random `server.secret_key`, `server.limiter: false`); run a pinned
      `searxng/searxng` image as container `learnharness-searxng`, published
      on `127.0.0.1:<port>` only (default 8888), `--restart unless-stopped`,
      the settings dir mounted at `/etc/searxng`. Start / stop / status /
      health (a JSON test query).
- [ ] `searxng` adapter behind the search port: `GET {base}/search?q=…&format=json`
      → `{title, url, snippet}`.
- [ ] `SearchEngineId` gains `"searxng"`; resolution order SearXNG → Tavily
      → Brave; SearXNG is "live" when enabled in settings and healthy. Pin
      rule unchanged (pinned + not live = honestly unavailable).
- [ ] Settings panel beside the search settings: Docker status, Install /
      Start / Stop, port, "Test search".
- [ ] `docs/searxng.md` (setup, how it works, troubleshooting) + tests
      (adapter with stub fetch, resolution order, manager with a fake
      docker runner).

### M3 — The `blog` background job
Files: `src/core/contracts/jobs.ts`, `src/core/pending.ts`,
`src/agent/tools/jobs.ts`, new `src/agent/subagents/blog-*.ts`, the job
runner, artifacts registry + new link card / warning card components,
settings contracts + UI.

- [ ] New job kind `blog` (toggleable like `pdf`); teacher tool `blog`
      with input `{ url }`.
- [ ] Stage 1 — fetch, clean, scan (M1).
- [ ] Stage 2 — hidden-content warning: if the scanner found anything, a
      warning card shows the hidden text. When "AI injection check" is on,
      an isolated judge (no tools, cheap model; the hidden text fenced as
      untrusted) adds a verdict to the card.
- [ ] Stage 3 — reader: an isolated agent with no tools turns the fenced
      clean text into a structured brief: title, author, date, thesis,
      outline, claims (each with a short verbatim quote, ranked by
      centrality), takeaways. Delivered to the teacher FIRST so the recall
      probe can start.
- [ ] Stage 4 — fact-checker: an isolated agent with only `web_search` +
      `web_fetch` checks the top 8 claims → verdict (supported / wrong /
      misleading / unverifiable) + explanation + sources; also lists
      omissions and related topics. Delivered to the teacher as a second
      message.
- [ ] Link card in the transcript: title, URL, per-stage progress, the
      "Use full text" toggle. When full text is on (global default or the
      card toggle), the teacher also receives the clean article fenced as
      untrusted data.
- [ ] Settings: "Use full article text" (default off) and "AI injection
      check" (default off).
- [ ] Tests with scripted fake engines (no network).

### M4 — The blog lesson flow
Files: `src/agent/prompt-segments.ts` / teacher prompt, home + new-session
screens.

- [ ] Teacher instructions for a blog lesson: PROBE recall questions
      graded against the brief; TEACH the summary, fact-check findings with
      sources, omissions, related topics, with check questions on each.
- [ ] Teacher instruction: an article URL pasted into any lesson → dispatch
      the `blog` job.
- [ ] "Review a blog" button on the home and new-session screens: a URL
      field that starts a fresh lesson in blog mode.

### M5 — Saving to the graph
- [ ] After the fact-check, build a fact-checked write-up (each claim with
      its verdict and sources, phrased "the blog claims X; this is wrong
      because Y" where it is wrong; omissions; related topics) and run it
      through the existing import/extraction pipeline as a source whose
      identity is the canonicalized URL (re-reviewing updates, never
      duplicates). Shown in the sources sidebar with title + URL.

### M6 — Tests and docs
- [ ] Full test suite green (excluding known environment-only failures).
- [ ] `docs/architecture.md` updated; this plan's checkboxes ticked.

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
