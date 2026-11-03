# Local Whisper dictation

On Windows, LearnHarness can transcribe dictation with
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) running on your own
NVIDIA GPU. No API key is needed, and audio does not leave the machine running
the LearnHarness server. Deepgram remains available as the other engine.

## User setup

1. Open **Settings → Providers → Dictation**. On Windows the **Engine** is
   **Local Whisper** unless you have saved another choice; elsewhere it is
   **Deepgram**, and Local Whisper is shown as Windows-only.
2. Click **Download** next to **Whisper server** (whisper.cpp, CUDA 12.4,
   about 685 MB).
3. Pick a **Model** and click **Download** (Base about 148 MB, Small about
   488 MB, Large v3 Turbo about 1.6 GB, the default).
4. When both are installed, the server starts and the status reads
   **Running**. From then on it starts with LearnHarness.

Hold **Ctrl+Space** to talk and release to insert the text, or press **Mod+D**
(or the Dictate button) to start and stop. A hold shorter than 300 ms is
discarded. **Esc** cancels and discards. Text is inserted once, when the run
ends, into the same field Deepgram dictation uses.

The **Language** setting is shared with Deepgram: a locale such as `en-US` is
sent to Whisper as `en`, and **Multilingual** becomes Whisper's auto-detect.

Requirements: Windows x64 and an NVIDIA GPU with a driver that supports CUDA
12.4. The CUDA build is the only build offered. Large v3 Turbo uses about 2 GB
of GPU memory while the app is open.

## How it works

| Piece | Where |
| --- | --- |
| Pinned downloads (URL, size, SHA-256) | [manifest](../src/server/whisper/manifest.ts) |
| Download, checksum, unpack (Windows `tar.exe`) | [install](../src/server/whisper/install.ts) |
| whisper-server process lifecycle | [process](../src/server/whisper/process.ts) |
| HTTP routes (`/api/stt/whisper/*`) | [http](../src/server/whisper/http.ts) |
| Boot start | [instrumentation.ts](../instrumentation.ts) |
| Recording, WAV, hold-to-talk | [dictation.tsx](../components/dictation.tsx), [whisper-client](../components/whisper-client.ts) |
| Settings panel | [whisper-settings](../components/settings/whisper-settings.tsx) |

- **Downloads** are pinned to whisper.cpp release `b5454` and to one Hugging
  Face commit of `ggerganov/whisper.cpp`. Each file streams to
  `<data>/whisper/.download/` while being hashed, and is installed only if the
  SHA-256 matches the pin. One download runs at a time and can be cancelled.
  Files live under `<data>/whisper/` (`data/` in development, the app's
  userData `data/` folder in the desktop app).
- **The server process** is started by the LearnHarness server, without a
  shell, as `whisper-server.exe -m <model> --host 127.0.0.1 --port <random>
  --request-path /<random secret> -l auto --suppress-nst`. whisper-server sends
  `Access-Control-Allow-Origin: *`, so the random request path keeps web pages
  in your browser from reaching it. The window never talks to whisper-server
  directly: it POSTs a 16 kHz mono WAV to `/api/stt/whisper/transcribe`, and
  the server forwards it.
- **Lifecycle.** The server starts at LearnHarness server boot when Local
  Whisper is the effective engine and both files are installed. It also
  converges after a finished download and after any dictation settings save
  (restart on a model change, stop when Deepgram is selected). If it crashes,
  the status shows the error; the next dictation tries to start it again.
  There is no automatic restart loop.
- **Exit.** A normal exit kills the child. The pid is recorded in
  `<data>/whisper/server.pid`; after a hard kill, the next start kills a
  leftover `whisper-server.exe` with that pid (checked with `tasklist`), and
  the desktop shell does the same on quit.
- **Limits.** One recording is capped at 10 minutes; reaching the cap stops
  the run and keeps the clip. Non-speech markers such as `[BLANK_AUDIO]` are
  removed from the text.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| "Local Whisper: … isn't installed" on the Dictate button | Click it to open Settings, then download the server and the selected model. |
| Status shows an error mentioning CUDA | Update the NVIDIA driver, or switch the engine to Deepgram. |
| Download failed: checksum mismatch | The file was discarded. Retry; a persistent mismatch means the pinned file changed upstream. |
| Status stays **Starting** | Large models take a few seconds to load; the start gives up after 120 s and shows an error. |
| Dictation inserts nothing | The clip contained no speech, or the hold was shorter than 300 ms. |

## Tests

`tests/whisper-core.test.ts`, `tests/whisper-server.test.ts` (downloads and a
fake whisper-server child process), `tests/whisper-http.test.ts` and
`tests/whisper-dictation-flow.test.tsx`. They do not download anything or need
a GPU.
