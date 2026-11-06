# Local search with SearXNG

LearnHarness can search the web through [SearXNG](https://docs.searxng.org/),
a self-hosted metasearch engine, instead of a paid search API. The app runs
SearXNG itself in Docker, only while LearnHarness is open. No API key or
account is needed.

SearXNG runs on your machine, but it is not offline: it forwards each query
to public engines (Google, Bing, DuckDuckGo, Wikipedia, …) and merges their
results. Those engines see the queries, but they don't see an account or
API key.

## User setup

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
   and start it.
2. In LearnHarness, open **Settings → Agent → Tools** and switch on
   **Local search (SearXNG)**.
3. Press **Install**. This downloads the pinned SearXNG image (about 98 MB)
   with `docker pull`. Progress shows under the switch.
4. When the status reads **Running**, press **Test search** to check it.

While it is on, SearXNG is the default search engine. Research jobs and the
blog fact-checker use it. The **Search engine** menu still lets you pin
Tavily or Brave instead. A pinned engine never switches silently: if the
pinned engine is unavailable, search reports it as unavailable.

## How it works

- **Image:** `searxng/searxng`, pinned by tag and digest in
  `src/server/searxng/manifest.ts`. Docker refuses an image that doesn't
  match the digest.
- **Settings file:** on first start the app writes
  `<data>/searxng/config/settings.yml`, which turns on JSON output, turns off
  the bot rate limiter and image proxy, and sets a random secret key. It is
  mounted at `/etc/searxng`. Edit it if you like: the app only writes it when
  it is missing.
- **Container:** `docker run --rm --name learnharness-searxng`, published
  on `127.0.0.1` only, on a free port picked at each start. Only the
  LearnHarness server talks to it; the browser window never does.
- **Lifetime:** the container starts with the app (when the switch is on and
  the image is installed), stops when you switch it off, and is removed when
  the app quits. If the app is killed, the Electron shell removes it on quit,
  and the next start removes any leftover container with the same name.
- **Docker Desktop not running:** the status says so and offers **Retry**.
  The app never starts Docker Desktop for you.

## Troubleshooting

| Status | What to do |
|---|---|
| Docker isn't installed | Install Docker Desktop. |
| Docker Desktop isn't running | Start Docker Desktop, then press **Retry**. |
| Not installed | Press **Install**. |
| Error: did not become ready | Press **Retry**. If it repeats, run `docker logs learnharness-searxng` while it starts. |
| Test search: upstream engines did not answer | Public engines (Google especially) sometimes rate-limit or block SearXNG. Try again later, or pin Tavily or Brave. |

To reset SearXNG's settings, delete `<data>/searxng/config/settings.yml`
and press **Retry**.

## Tests

`tests/searxng.test.ts` covers the search adapter, engine resolution
(SearXNG first, no silent switching), the settings shape, and the container
manager driven by a fake Docker CLI. No real Docker is needed.
