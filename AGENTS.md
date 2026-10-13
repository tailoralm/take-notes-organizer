# AGENTS.md

## Project overview

`take-notes-organizer` copies Telegram voice notes from an input folder and transcribes
them with a local self-hosted Whisper server. It is a one-shot worker: each run scans the
input folder, copies new `.ogg` files to the output folder, transcribes them, moves the
processed files into a `processed/` subfolder, and records state in a JSON database.

## Tech stack and commands

- Node.js + TypeScript, CommonJS (`module: commonjs`), strict mode.
- `npm` only. Dev tooling: `ts-node` (no build step required), `nodemon` for hot reload.
- Dependencies: `dotenv` (loads `.env`), plus `typescript`, `ts-node`, `nodemon`, `@types/node` as dev deps.
- `npm start` runs `ts-node src/index.ts` (production/one-shot run).
- `npm run dev` runs nodemon watching `src`.
- `npm run typecheck` runs `tsc --noEmit` — ALWAYS run this after changes.
- Do not add new dependencies unless strictly necessary; use built-in Node APIs (node:fs, node:path, global fetch/FormData/Blob).

## Environment variables

Copied from `.env.example` into `.env` (`.env` is git-ignored).

- `AUDIO_NOTES_FOLDER` — input folder where the Telegram bot drops voice notes. Required.
- `AUDIO_NOTES_OUTPUT_FOLDER` — working output folder. Required. Also the root for `transcripts.json` and `processed/`.
- `WHISPER_URL` — base URL of the Whisper server (default `http://127.0.0.1:9000`).
- `WHISPER_API_KEY` — optional Bearer token; leave empty when the server has auth disabled.

## Architecture and data flow

- `src/index.ts` — orchestration: config loading, scanning, copying, transcription, moving, mismatch validation.
- `src/db.ts` — `TranscriptsDb`, the file-backed repository for `transcripts.json`.

Processing pipeline (`src/index.ts` `main()`):
1. Create output folder and `processed/` subfolder; load the `transcripts.json` database.
2. `validateMismatches()` — warn about JSON entries whose physical files are missing (see rules below).
3. Scan the input folder for voice notes matching the pattern `voice_<ISO-8601 timestamp>.ogg`
   (regex `^voice_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.ogg$`).
4. For each pending file: copy it from input to the output root (if not already copied),
   transcribe it via Whisper, write the `.txt`, then **move** both the `.ogg` and `.txt`
   into `processed/`, and mark the entry transcribed in the JSON (saving after each file).

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
  is missing from the output root, log a warning (and re-copy from the input folder if it is
  still pending transcription).
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
- The app container is a one-shot run (no `restart`); `docker compose up --build` runs it once per invocation.
- The image installs all deps, compiles with `tsc` to `dist/`, and runs `node dist/index.js`.

## Development notes

- Verify changes with `npm run typecheck`; a smoke test needs a running whisper server
  (or a mock HTTP server answering `/v1/models` and `/v1/audio/transcriptions`).
- The input `.ogg` files must NOT be modified; only copy. Output stability matters: processed
  files and the JSON define the permanent state of the project — archive/backup them.