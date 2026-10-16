import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/config';
import { NOTES_DIR } from '../config/constants';
import { throwIfAborted } from '../core/cancellation';
import type { Logger } from '../core/logger';
import type { RefineResult } from '../domain/refinement';
import { refineText, waitForLmStudio } from '../clients/lmstudio-client';
import { openDb, pendingRefineNotes } from './inventory-service';

export interface RefiningResult {
  refined: number;
}

/** ISO timestamp read from a `voice_<timestamp>.ogg` name, falling back to now. */
function audioTimestamp(audioFile: string): string {
  const match = audioFile.match(/^voice_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.\d{3}Z\.ogg$/);
  if (!match) return new Date().toISOString();
  const [, date, hours, minutes, seconds] = match;
  return `${date}T${hours}:${minutes}:${seconds}.000Z`;
}

/** JSON.stringify yields a valid double-quoted YAML scalar. */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/** Builds the Obsidian-ready markdown note from a parsed refinement. */
function renderMarkdownNote(audioFile: string, result: RefineResult): string {
  const lines = [
    '---',
    `title: ${yamlScalar(result.title)}`,
    result.tags.length > 0 ? 'tags:' : 'tags: []',
    ...result.tags.map((tag) => `  - ${yamlScalar(tag)}`),
    `created: ${yamlScalar(audioTimestamp(audioFile))}`,
    `source: ${yamlScalar(audioFile)}`,
    '---',
    '',
    `# ${result.title}`,
    '',
    `> ${result.resume}`,
    '',
    result.refinedText,
    '',
  ];
  return lines.join('\n');
}

/**
 * Refines the transcriptions that are already done (transcribed but not yet
 * refined) with the LMStudio LLM. For each note it writes the refined text to
 * processed/<name>.refined.txt, an Obsidian markdown note to notes/<name>.md,
 * and records title, tags, resume and refinedByLLM in the JSON. The raw .txt is
 * never touched. This run does not transcribe or copy.
 */
export async function refineAll(config: Config, logger: Logger, signal?: AbortSignal): Promise<RefiningResult> {
  const { db, processedDir } = openDb(config, logger);
  const notesDir = path.join(config.outputFolder, NOTES_DIR);
  fs.mkdirSync(notesDir, { recursive: true });

  const pending = pendingRefineNotes(config, db);
  if (pending.length === 0) {
    logger.info('No transcribed files to refine.');
    return { refined: 0 };
  }

  await waitForLmStudio(config, logger, signal);

  let refined = 0;
  for (const name of pending) {
    throwIfAborted(signal);
    const txtName = name.replace(/\.ogg$/, '.txt');
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(processedDir, txtName), 'utf8').trim();
    } catch (error) {
      logger.error(`Failed to read ${txtName}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!raw) {
      logger.warn(`Skipping ${name}: transcription is empty.`);
      continue;
    }

    logger.info(`Refining ${name}`);
    try {
      const result = await refineText(config, logger, raw, signal);
      const refinedName = name.replace(/\.ogg$/, '.refined.txt');
      fs.writeFileSync(path.join(processedDir, refinedName), result.refinedText + '\n', 'utf8');
      fs.writeFileSync(path.join(notesDir, name.replace(/\.ogg$/, '.md')), renderMarkdownNote(name, result), 'utf8');

      db.markRefined(name, {
        refinedTextFile: refinedName,
        title: result.title,
        tags: result.tags,
        resume: result.resume,
      });
      db.save();
      refined++;
      logger.success(`Refined ${name}`);
    } catch (error) {
      throwIfAborted(signal);
      logger.error(`Failed to refine ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logger.success(`Done. ${refined} file(s) refined.`);
  return { refined };
}
