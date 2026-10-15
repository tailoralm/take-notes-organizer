# Take Notes Organizer

Copies Telegram voice notes from an input folder and transcribes them with a local,
self-hosted Whisper server ([ScribeCrate](https://github.com/hwdsl2/scribecrate),
an OpenAI-compatible faster-whisper API). Exposes a simple web UI (`node:http`, no
frameworks) that shows processed/pending/to-copy counts, triggers either step and streams
live logs.

## How it works

Copying and transcribing are two independent steps sharing the same code (`src/processor.ts`):

- **Copy run** (`copyAll`) is the only step that reads the input (origin) folder. It scans it
  for `voice_<ISO-8601 timestamp>.ogg` files, copies the ones not yet copied or transcribed
  into the output folder, and marks them copied in `transcripts.json`. It never transcribes.
- **Process run** (`processAll`) transcribes voice notes already sitting in the output folder
  (copied by the copy run, or moved in by hand to re-run a transcription). For each it writes
  the `.txt`, moves the pair into `processed/`, and marks it transcribed in `transcripts.json`.
  It never reads the input folder.

The one-shot CLI (`npm start`) runs copy then process in order. `transcripts.json` is the
single source of truth for the state.

In the web UI, **Copy from origin** is the only button that copies, and **Process now** only
transcribes files already in the output folder — so you can drop a file back in (or edit the
JSON) and re-process without touching the origin folder.

Each file goes through the pipeline in `src/transcriber.ts`:

1. **Preprocess** — the `.ogg` is converted to a 16 kHz mono WAV with `ffmpeg` and
   long silences are trimmed (`silenceremove`), shortening the quiet stretches where
   Whisper tends to hallucinate.
2. **Chunk** — the WAV is split into chunks of ~`WHISPER_CHUNK_SECONDS` (300s). Cut
   points are shifted to the nearest silence region, and consecutive chunks overlap
   by `WHISPER_CHUNK_OVERLAP_SECONDS` (1s) so words are not cut in half.
3. **Transcribe** — each chunk is sent in its own request with `response_format=verbose_json`
   and `language` set explicitly (no prompt). Segments are offset to the original
   timeline and the overlap duplicates are removed while merging.
4. **Detect and retry** — after each chunk, the segments are checked for a
   hallucination loop: the same normalized segment text appearing
   `WHISPER_REPEAT_LIMIT` (3) or more times consecutively, or a gzip compression
   ratio of the chunk text above `WHISPER_COMPRESSION_RATIO` (2.4). A flagged chunk
   is retried (up to `WHISPER_MAX_RETRIES` times): first with `beam=1`, then with
   `temperature=WHISPER_RETRY_TEMPERATURE` (0.2) and smaller chunks of
   `WHISPER_SMALL_CHUNK_SECONDS` (120s). If every attempt is still flagged, the best
   attempt is kept with its consecutive duplicate segments collapsed, and the text
   file contains `[possible_hallucination hh:mm-hh:mm]` markers at the affected
   chunks while a warning is logged with the file name and time range.

The whisper service (`hwdsl2/whisper-server:cuda`) is left unmodified: per-request
`beam` and `temperature` overrides are supported by the OpenAI-compatible API and are
sent by this app.

## Docker Compose

```bash
cp .env.example .env   # edit as needed
docker compose up -d   # starts whisper + notes-organizer (web UI on http://127.0.0.1:8080)
```

The `notes-organizer` container runs the web UI server from the mounted sources
(`npm run dev:server`, ts-node + nodemon): `src/` and `public/` are bind-mounted, so code
edits are picked up automatically (nodemon restarts on `src` changes, `public/` is re-read
per request) and you only need to build the image once for the dependencies.

A one-shot CLI run is still available (also over the mounted sources):

```bash
docker compose run --rm notes-organizer npm start
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `AUDIO_NOTES_FOLDER` | *(required)* | Input folder where the Telegram bot drops voice notes. |
| `AUDIO_NOTES_OUTPUT_FOLDER` | *(required)* | Working output folder; also root for `transcripts.json` and `processed/`. |
| `WHISPER_URL` | `http://127.0.0.1:9000` | Base URL of the Whisper server. |
| `WHISPER_API_KEY` | *(empty)* | Optional Bearer token; leave empty when auth is disabled. |
| `PORT` | `8080` | Port for the web UI server. |
| `WHISPER_LANGUAGE` | `pt` | BCP-47 language sent on every transcription request. |
| `WHISPER_CHUNK_SECONDS` | `300` | Target length of each transcription chunk. |
| `WHISPER_CHUNK_OVERLAP_SECONDS` | `1` | Overlap between consecutive chunks (removes word cuts). |
| `WHISPER_SMALL_CHUNK_SECONDS` | `120` | Chunk size used by the temperature retry. |
| `WHISPER_MAX_RETRIES` | `2` | Retries per chunk after a hallucination loop is flagged. |
| `WHISPER_TEMPERATURE` | `0` | Sampling temperature for the primary attempts. |
| `WHISPER_RETRY_TEMPERATURE` | `0.2` | Sampling temperature for the smaller-chunk retry. |
| `WHISPER_REPEAT_LIMIT` | `3` | Same normalized segment text repeated this many times flags a chunk. |
| `WHISPER_COMPRESSION_RATIO` | `2.4` | Chunk text gzip ratio above this flags a chunk. |
| `WHISPER_SILENCE_THRESHOLD_DB` | `-35` | Sound level (dB) under which a region counts as silence. |
| `WHISPER_SILENCE_TRIM_SECONDS` | `2` | Internal silences longer than this are trimmed during preprocessing. |

The `WHISPER_*` variables are also declared in `docker-compose.yml` for the
`notes-organizer` service; the values there use `${VAR:-default}` interpolation so
they can be overridden from the project `.env`.

## Development

- `npm start` — one-shot CLI run.
- `npm run serve` — web UI server (`src/server.ts`).
- `npm run dev` / `npm run dev:server` — nodemon with hot reload.
- `npm run typecheck` — `tsc --noEmit`. Always run after changes.
- `npm test` — unit tests for the repetition detector, chunk merging and chunk
  building (`node:test`, no extra dependencies).

## Testing

### Unit tests

```bash
npm test
```

Covers the repetition detector (consecutive repeats, gzip ratio), the overlap
duplicate removal during chunk merging, and the silence-aware chunk builder, using
fake segments — no real audio or GPU needed.

### End-to-end with a previously looping file

1. Start the real stack: `docker compose up -d` and wait for the `whisper` container
   to become healthy (model load can take a while).
2. Drop the looping voice note into the input folder, e.g.
   `cp voice_2026-10-13T09-56-25.000Z.ogg ./audio/`.
3. Trigger a run from the web UI (`http://127.0.0.1:8080`) or:
   ```bash
   docker compose run --rm notes-organizer npm start
   ```
4. Inspect the output `transcripts/processed/voice_*.txt`: the looped phrases should
   be gone or collapsed into a single occurrence, and any chunk that could not be
   recovered is marked `[possible_hallucination hh:mm-hh:mm]` while the run log warns
   about it with the file name and time range.

### Without a GPU: mock Whisper server

A mock server (`scripts/mock-whisper.ts`) answers the `/v1/models` health check and
`/v1/audio/transcriptions` with fabricated segments. It returns a repeating phrase for
the primary/beam attempts and clean text for the `temperature=0.2` attempt, which
exercises the whole chunk + detect + retry + merge pipeline locally:

```bash
npm run mock            # starts the mock on http://127.0.0.1:9000
WHISPER_URL=http://127.0.0.1:9000 AUDIO_NOTES_FOLDER=./audio \
AUDIO_NOTES_OUTPUT_FOLDER=./transcripts npm start
```

## Core rules

- `transcripts.json` is the single source of truth. "Was this file copied?" is the
  JSON entry existing; "Was this file transcribed?" is `entry.transcribed === true`.
- Never process a file that is already in `processed/`.
- `refinedByLLM` always defaults to `false` and is preserved (reserved for a future
  LLM-refinement step).
- Re-running with no new input must do nothing (idempotent).
- Input `.ogg` files are never modified, only copied.