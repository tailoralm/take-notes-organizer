# LLM Refinement Step (LMStudio)

Add a third pipeline step that refines transcribed voice notes with a local LLM
(LMStudio, OpenAI-compatible) and produces Obsidian-ready markdown notes.

## Goal & constraints

Refine raw transcriptions into publishable notes: break into paragraphs, fix
obvious transcription errors (only clear single words), and extract a title,
tags, and a small resume (the resume lets other LLMs retrieve this note). The
LLM must **never add or remove content** — it only re-formats, paragraph-splits,
and fixes clear word mistakes.

## Decisions (confirmed with user)

1. **Refined metadata** goes in `transcripts.json` (`title`, `tags`, `resume`,
   `refinedByLLM=true`); the refined full text goes to a `voice_....refined.txt`
   next to the raw `.txt` in `processed/`. The verbatim transcription is
   preserved untouched.
2. **Output notes** are Obsidian `.md` files written to a new
   `<output>/notes/` folder.
3. **Markdown generation:** the prompt asks for a strict JSON object
   (`{title, tags, resume, refinedText}`); code parses/validates it and writes
   the `.md` itself (YAML frontmatter + body). Parsing stays reliable.
4. **Refine trigger:** new card + button in the web UI; a `refineAll()`
   processes every transcribed entry where `refinedByLLM !== true`. Count shown
   = entries transcribed-but-not-refined. Refinement is independent (like copy
   and process) and is **not** added to the one-shot CLI.
5. **LMStudio connection:** new env vars + `GET /v1/models` health check
   (matches the Whisper pattern).
6. **Language:** title/tags/resume in the same language as the text.

## Environment variables (`.env.example` + `loadConfig`)

- `LMSTUDIO_URL` — base URL, default `http://127.0.0.1:1234/v1`.
- `LMSTUDIO_API_KEY` — optional Bearer token, empty by default.
- `LMSTUDIO_MODEL` — model id loaded in LMStudio (required-ish; default
  `local-model`). Documented as "set to the id of the model loaded in LMStudio".

## Data model changes (`src/db.ts`)

Extend `TranscriptEntry`:

```ts
export interface TranscriptEntry {
  audioFile: string;
  transcribed: boolean;
  refinedByLLM: boolean;
  refinedTextFile?: string;   // e.g. "voice_....refined.txt"
  title?: string;
  tags?: string[];            // array of tag strings
  resume?: string;
}
```

- `load()`: read `refinedTextFile`, `title`, `tags` (string array), `resume`
  with the same loose normalization used for the flags (skip if not a string /
  not an array). Keep backward compatibility with existing entries (missing
  fields → `undefined`).
- `save()`: write entries as-is (unknown fields already dropped; new fields
  serialized).
- New `markRefined(audioFile, data: {refinedTextFile, title, tags, resume})`
  that merges onto the existing entry, preserving `transcribed` and setting
  `refinedByLLM: true`, then `save()` after each file (matching the per-file
  save pattern in copy/process).

## New file `src/refiner.ts`

- `refineText(config, logger, text): Promise<RefineResult>` where
  `RefineResult = { title, tags, resume, refinedText }`.
- Builds a `POST {LMSTUDIO_URL}/chat/completions` request with `global fetch`:
  body `{ model: config.lmstudioModel, messages: [...], response_format:
  {type: "json_object"}, temperature: 0 }` and optional `Authorization: Bearer`.
- Prompt (system + user) that:
  - receives the raw transcription text,
  - instructs "do not add or remove text; only re-format, split into
    paragraphs, and fix obvious single-word transcription mistakes",
  - asks for a strict JSON object with exactly `title` (short), `tags` (array
    of short lowercase tags), `resume` (2-3 sentence summary for retrieval),
    `refinedText` (the full refined text),
  - says title/tags/resume must be in the same language as the text.
- Parse `choices[0].message.content` as JSON; if the model wraps it in a code
  fence (```` ```json ``` ````), strip it first. Validate shape; on invalid
  JSON or missing fields, throw a clear error so the entry stays un-refined and
  is retried next run.
- `waitForLmStudio(config, logger, timeoutMs)`: poll `GET {url}/models` every
  10s up to a timeout (shorter than whisper's, e.g. 5 min) before refining.

## `src/processor.ts` changes

- Extend `Config` with `lmstudioUrl`, `lmstudioApiKey?`, `lmstudioModel`; add
  them to `loadConfig()` and the `LMSTUDIO_*` env reads.
- New `pendingRefineNotes(config, db)`: fully-transcribed entries (file is in
  `processed/`) where `refinedByLLM !== true`, keyed to read the raw `.txt`
  from `processed/`.
- New `export async function refineAll(config, logger): Promise<{refined:
  number}>`:
  1. `openDb()` (mkdirs + load + `validateMismatches`).
  2. `pending = pendingRefineNotes(...)`; if empty → log + return.
  3. `waitForLmStudio(...)`.
  4. For each: read raw `.txt` (from `processed/`, `.ogg` name →
     `.txt`), call `refineText()`, write `voice_....refined.txt` into
     `processed/` (verbatim refined text), write
     `<output>/notes/voice_....md`, then `db.markRefined(...)` + `save()`.
  5. Log per-file and a final `Done. N file(s) refined.`.
- New status count: extend `Status` with `toRefine: number` and compute in
  `getStatus()` (transcribed entries where `refinedByLLM !== true`).
- `validateMismatches()`: also warn when a refined entry's `.refined.txt` or
  `notes/*.md` is missing.

## Markdown note format (`notes/voice_....md`)

YAML frontmatter + body, built by code from the parsed JSON:

```markdown
---
title: "<title>"
tags:
  - <tag1>
  - <tag2>
created: <ISO timestamp>
source: <audioFile>
---

# <title>

> <resume>

<refinedText>
```

File name: `<audioFile>` with `.ogg` → `.md`. `notes/` is `mkdirSync({recursive:
true})` on demand. Tags lowercased and trimmed; `created` uses the timestamp
parsed from the filename or the file mtime/now as a fallback.

## `src/server.ts` changes

- Add route `POST /api/refine` → `runStream(req, res, refineAll)` with terminal
  `{"type":"done","refined":n}` (existing `runStream` framework already streams
  NDJSON log + done/error and shares the single `running` lock).
- `GET /api/status` now returns `toRefine` (add to the response).

## `src/index.ts` (one-shot CLI)

No change — refinement is deliberately UI-only per confirmed decision.

## Web UI (`public/index.html`, `app.js`, `style.css`)

- Add a fourth stat card "To refine" (`toRefine`) and a
  third CTA card with a "Refine now" button (`refine-btn`), hint text
  "Refines transcribed notes into markdown via LMStudio".
- `app.js`: add `refine` to `OPERATIONS` (`endpoint: '/api/refine'`, idle/busy
  labels), wire the button to `runOperation('refine')`, add `refine` to the
  `setBusy` button-disabling, and render `data.toRefine` in `refreshStatus`.
- `handleEvent` `done` branch: also render `event.refined` as `N refined`.
- `style.css`: stats grid stays 3-wide but handles 4 cards (adjust
  `grid-template-columns` to `repeat(4, 1fr)` or wrap on small screens);
  actions grid → 3 columns on desktop, collapse on narrow widths.

## Docker / compose

- `compose.yml` `notes-organizer` service: add
  `LMSTUDIO_URL: ${LMSTUDIO_URL:-http://host.docker.internal:1234/v1}` (or a
  documented host override) and `LMSTUDIO_MODEL: ${LMSTUDIO_MODEL:-local-model}`.
  Note: the app runs in Docker while LMStudio runs on the host, so the URL must
  reach the host; document that the default points at host LMStudio and can be
  overridden via `.env`.
- `.env.example`: add the three `LMSTUDIO_*` variables with comments.

## Validation

- `npm run typecheck` — must pass.
- Manual smoke test with a mock OpenAI-compatible server (extend or mirror
  `scripts/mock-whisper.ts` with a `POST /chat/completions` returning a fixed
  JSON `{title,tags,resume,refinedText}` via `choices[0].message.content`), then
  run `refineAll` against a small `transcripts.json` and confirm: `.refined.txt`
  written, `.md` written to `notes/`, `refinedByLLM=true` + metadata persisted,
  idempotent re-run does nothing.
- Confirm the web UI shows the "to refine" count and the refine button streams
  logs and finishes with `N refined`.

## Risks / notes

- Weak local models may return malformed JSON; the refiner must tolerate code
  fences and log a clear "not refined, will retry" error without crashing the
  batch (per-file try/catch, `continue` on failure, mirroring copy/process).
- The strict "never add/remove text" constraint relies on prompt adherence; the
  code stores both the raw `.txt` (untouched) and the refined text so nothing is
  lost if the model misbehaves.
- `tags` must be stored/normalized as an array in JSON; never as a comma string.
