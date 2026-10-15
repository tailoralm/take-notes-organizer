# AGENTS.md

## Project overview

`take-notes-organizer` copies Telegram voice notes from an input folder and transcribes
them with a local self-hosted Whisper server. Copying and transcribing are separate steps:
a copy run scans the input (origin) folder and copies new `.ogg` files to the output folder;
a process run transcribes the voice notes already sitting in the output folder, moves the
processed files into a `processed/` subfolder, and records state in a JSON database. The
one-shot CLI runs both steps in order. The same pipeline is exposed through a simple HTTP web
UI (`node:http`, no frameworks) that shows processed/pending/to-copy counts, triggers either
step, and streams live logs.

## Tech stack and commands

- Node.js + TypeScript, CommonJS (`module: commonjs`), strict mode.
- `npm` only. Dev tooling: `ts-node` (no build step required), `nodemon` for hot reload.
- Dependencies: `dotenv` (loads `.env`), plus `typescript`, `ts-node`, `nodemon`, `@types/node` as dev deps.
- `npm start` runs `ts-node src/index.ts` (one-shot CLI run).
- `npm run serve` runs `ts-node src/server.ts` (web UI server).
- `npm run dev` runs nodemon watching `src` (CLI).
- `npm run dev:server` runs nodemon watching `src` (web UI server).
- `npm run typecheck` runs `tsc --noEmit` — ALWAYS run this after changes.
- Do not add new dependencies unless strictly necessary; use built-in Node APIs (node:fs, node:http, node:path, global fetch/FormData/Blob).

## Environment variables

Copied from `.env.example` into `.env` (`.env` is git-ignored).

- `AUDIO_NOTES_FOLDER` — input folder where the Telegram bot drops voice notes. Required.
- `AUDIO_NOTES_OUTPUT_FOLDER` — working output folder. Required. Also the root for `transcripts.json` and `processed/`.
- `WHISPER_URL` — base URL of the Whisper server (default `http://127.0.0.1:9000`).
- `WHISPER_API_KEY` — optional Bearer token; leave empty when the server has auth disabled.
- `PORT` — port for the web UI server (default `8080`).

## Architecture and data flow

- `src/index.ts` — one-shot CLI entry: loads config, runs `copyAll()` then `processAll()`, exits.
- `src/processor.ts` — shared pipeline and business logic. `Config`, `Logger`, `loadConfig()`,
  `getStatus()`, `copyAll(config, logger)` and `processAll(config, logger)`; the CLI and the web
  server use the same code.
- `src/server.ts` — zero-dependency `node:http` server that serves the web UI and runs either
  step behind an API with a log stream.
- `src/db.ts` — `TranscriptsDb`, the file-backed repository for `transcripts.json`.
- `public/` — the web UI: `index.html`, `style.css`, `app.js` (plain HTML/CSS/JS, no build step).

Copy run (`src/processor.ts` `copyAll()`) — the only step that reads the origin folder:
1. Create output folder and `processed/` subfolder; load the `transcripts.json` database.
2. `validateMismatches()` — warn about JSON entries whose physical files are missing (see rules below).
3. Scan the **input (origin)** folder for voice notes matching the pattern
   `voice_<ISO-8601 timestamp>.ogg` (regex `^voice_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.ogg$`)
   that are not already copied or transcribed (not in the output root nor in `processed/`).
4. Copy each one to the output root and mark the JSON entry copied (saving after each file).
   Copying never transcribes.

Process run (`src/processor.ts` `processAll()`) — transcribes what is already in the output folder:
1. Create output folder and `processed/` subfolder; load the `transcripts.json` database.
2. `validateMismatches()`.
3. Scan the **output folder** for voice notes that are not transcribed yet (JSON `transcribed`
   is not `true`). These are files copied by the copy run or moved in by hand for a re-run.
4. For each: transcribe it via Whisper, write the `.txt`, then **move** both the `.ogg` and
   `.txt` into `processed/`, and mark the entry transcribed in the JSON (saving after each file).
   The process run never reads the input folder.

## Web UI API

- `GET /api/status` — JSON `{ "processed": number, "pending": number, "toCopy": number }`.
  `pending` counts voice notes in the output folder not yet transcribed; `toCopy` counts voice
  notes still only in the origin folder.
- `POST /api/copy` — runs `copyAll()`; streams **NDJSON** log lines
  (`{"type":"log","level":"info|success|warn|error","message":"..."}`) followed by a terminal
  `{"type":"done","copied":n}` or `{"type":"error","message":"..."}`.
- `POST /api/process` — runs `processAll()`; same NDJSON stream, terminal
  `{"type":"done","transcribed":n}` or `{"type":"error","message":"..."}`.
- Copy and process share one run lock: only one may run at a time; a second concurrent call
  returns `409`.
- `GET /` serves `public/index.html`; `/style.css` and `/app.js` are served as static files.

## Core rules — do not break these

- **`transcripts.json` is the single source of truth.** It is a JSON array at the root of
  the output folder: `[{ "audioFile": "voice_....ogg", "transcribed": false, "refinedByLLM": false }]`.
  - "Was this file copied?" is answered by the JSON entry existing.
  - "Was this file transcribed?" is answered by `entry.transcribed === true`.
  - Never infer state from file existence alone.
- **Never process a file that is already in the `processed/` folder** (checked via JSON and file existence).
- **`refinedByLLM` always defaults to `false`.** It is reserved for a future LLM-refinement
  step that will flip it to `true`. Preserve the flag when updating entries; do not drop it.
- **Mismatch warnings:** if the JSON says a file is transcribed but its `.ogg`/`.txt` are
  missing from `processed/`, log a warning. If the JSON says a file was copied but the copy
  is missing from the output root, log a warning; the next copy run re-copies it from the
  origin folder when the source is still available.
- **Copy and process are independent.** Only the copy run reads the origin folder and only the
  copy run writes to the output root; the process run transcribes files already in the output
  folder (including ones moved in by hand) and never copies.
- Idempotency is mandatory: re-running with no new input must do nothing.

## Whisper server integration

- The whisper server is `hwdsl2/whisper-server` (ScribeCrate), an OpenAI-compatible API.
- Endpoint: `POST {WHISPER_URL}/v1/audio/transcriptions`, `multipart/form-data` with fields
  `file` (the audio bytes plus original `.ogg` filename) and `model` (`whisper-1` is accepted).
- Health check: `GET {WHISPER_URL}/v1/models`; the app waits up to 10 minutes for readiness
  (large-v3 on CUDA loads slowly), polling every 10 s.
- Response JSON: `{ "text": "..." }` is written verbatim as the `.txt` file.
- Supported audio includes `.ogg` (telegram voice notes); the server handles conversion via ffmpeg.

## Docker / docker compose

- `compose.yml` starts two services:
  - `whisper` — `hwdsl2/whisper-server:cuda`, NVIDIA GPU required (`deploy.resources.reservations.devices`),
    port `127.0.0.1:9000:9000`, model `large-v3`, language `pt`, auth explicitly disabled (`WHISPER_API_KEY: ""`).
  - `notes-organizer` — builds the Dockerfile in this project, `depends_on: whisper`, uses
    `WHISPER_URL: http://whisper:9000` (service network name), and bind-mounts the host folders
    via compose interpolation: `${AUDIO_NOTES_FOLDER:-./audio}` → `/data/input` and
    `${AUDIO_NOTES_OUTPUT_FOLDER:-./transcripts}` → `/data/output`. Values come from the project `.env`.
- The app container runs the **web UI server** on port `127.0.0.1:8080:8080`; it is long-running
  (no `restart`, exits when stopped). It overrides the image CMD with `command: npm run dev:server`
  (ts-node + nodemon) and bind-mounts `./src`, `./public` and `./tsconfig.json`, so edits apply
  without rebuilding the image (nodemon hot-reloads on `src` changes; `public/` is re-read per
  request). The image is still built once for the Node deps and `ffmpeg`.
- A one-shot CLI run is available with `docker compose run --rm notes-organizer npm start`
  (ts-node over the mounted `src`; do not use the stale `dist/`).

## Development notes

- Verify changes with `npm run typecheck`; a smoke test needs a running whisper server
  (or a mock HTTP server answering `/v1/models` and `/v1/audio/transcriptions`).
- The input `.ogg` files must NOT be modified; only copy. Output stability matters: processed
  files and the JSON define the permanent state of the project — archive/backup them.