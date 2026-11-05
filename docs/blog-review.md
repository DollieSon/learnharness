# Blog reviews

A blog review turns an article link into a lesson: the learner first
recalls what they took from the article, then learns what it gets right,
what it gets wrong, what it leaves out and where to go next. The
fact-checked result is saved to the knowledge graph. The plan and the
owner's decisions are in [PLAN-BLOG-REVIEW.md](PLAN-BLOG-REVIEW.md).

## Starting one

- **Blog session:** the home mode switch (Teach | Practice | Blog), the
  sidebar's **Blog review** button or `/chat/new?mode=blog`. The learner
  pastes a link; `POST /api/chats { kind: "blog", url }` creates a
  `kind: "blog"` session titled "Blog · <site>" and the first learner
  message is "Review this article with me: <url>". The title becomes the
  article's title when the brief arrives (unless the learner renamed it).
- **Any lesson:** an article link pasted into a normal lesson goes to the
  `blog` tool too (prober and teacher instructions).
- With **Tool · blog** off, both jobs leave the registries and the blog
  entry points are hidden.

## The flow

Blog sessions run prober → teacher like any lesson, plus blog-only prompt
fragments (`src/agent/prompts/blog-prober/`, `blog-teacher/`; overridable
in Settings like the other segments):

1. The prober dispatches `blog` at once and asks the learner's goal while
   it reads.
2. The **blog job** (`src/agent/subagents/blog.ts`) reads the page locally
   with `readPage(url, { render: "always" })`: URL guard, rendered page,
   hidden-content scanner. An isolated reader with **no tools** turns the
   fenced article into a brief (thesis, outline, 5–12 central claims with
   verbatim quotes, takeaways). When hidden content was found and
   **AI injection check** is on, an isolated judge (no tools) rates it.
3. The brief's result message tells the agent to dispatch `fact_check`
   with the blog job id, then start the recall questions (the global
   Quizzing mechanic), graded against the brief.
4. The **fact-check job** gives an isolated agent only `web_search` and
   `web_fetch` to check the top 8 claims: supported / wrong / misleading /
   unverifiable, each with an explanation and sources, plus omissions and
   related topics. `fact_check` refuses up front unless its id names a
   finished blog job in the same session.
5. After `probe_done`, the teacher teaches the summary, the verdicts with
   sources, the omissions and the related topics, with check questions.

Both jobs run on the researcher's model and follow the normal job
protocol: one result message each, abortable, recoverable.

## What the agents see

- By default the agents get the **brief**, never the page. The cleaned
  full text (capped at 60,000 characters) reaches the agent only when the
  **share full text** setting is on, or when the learner presses **Share
  full text with the agent** on the link card. Sharing is one-way (a model
  can't unsee text): the `share-blog-text` input appends a marker with the
  fenced article and is refused while a question is open or after the text
  was already shared.
- Every page-derived string a model sees is wrapped by
  `fenceUntrusted()`; the fence escapes `<<<`/`>>>` so a page can't close
  it. Page-derived strings render as plain text in the UI; only http(s)
  links become links.

## The cards

- **Link card:** site, title, byline, the hidden-content warning (count,
  the AI verdict or "check is off", the hidden text behind a disclosure, a
  reduced-detection note when the page couldn't be rendered), the brief
  behind a disclosure, and the share button.
- **Fact-check card:** verdict counts, each claim with its verdict,
  explanation and sources, omissions, related topics, and a note when the
  write-up is being saved.

## Saving to the graph

A **successful** fact-check (in any session) builds a write-up from the
verdicts — never from the raw article — with wrong and misleading claims
only as the article's errors followed by their correction, and runs it
through the notes import pipeline (`extraction.importNotes`). The source
path is `Blog reviews/<site> › <path>.md`, from the URL without its
fragment or tracking parameters, so one article is one source and a later
review updates it. A failed check saves nothing; nothing saves while the
graph is off; a save failure never fails the check.

## Settings

| Setting | Default | Effect |
|---|---|---|
| Tool · blog | on | Registers `blog` and `fact_check`; shows the blog entry points. |
| Blog · share full text | off | Sends the cleaned article with the brief. |
| Blog · AI injection check | off | Runs the isolated judge when hidden content is found (more tokens). |

Search for the fact-checker uses the configured engine; see
[local search with SearXNG](searxng.md).

## Tests

`tests/blog-review.test.ts` (reader, fact-checker, steer text, fence,
share, toggle, settings, dispatch refusals), `tests/blog-session.test.ts`
(session creation, prompts, rename, URL helpers) and
`tests/blog-save.test.ts` (write-up, source path, auto-save contract).
Page reading is covered by `tests/page-reading.test.ts`.
