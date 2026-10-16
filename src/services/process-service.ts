import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/config';
import { throwIfAborted } from '../core/cancellation';
import type { Logger } from '../core/logger';
import { waitForWhisper } from '../clients/whisper-client';
import { openDb, pendingVoiceNotes } from './inventory-service';
import { transcribeFile } from './transcription-service';

export interface ProcessingResult {
  transcribed: number;
}

/**
 * Transcribes the voice notes already present in the output folder (copied by the
 * copy run or moved in by hand). Each file is moved into processed/ with its txt
 * once transcribed. This run never copies from the origin folder.
 */
export async function processAll(
  config: Config,
  logger: Logger,
  signal?: AbortSignal,
): Promise<ProcessingResult> {
  const { db, processedDir } = openDb(config, logger);

  const pending = pendingVoiceNotes(config, db);
  if (pending.length === 0) {
    logger.info('No voice notes to process.');
    return { transcribed: 0 };
  }

  await waitForWhisper(config, logger, signal);

  let transcribed = 0;
  for (const name of pending) {
    throwIfAborted(signal);
    const workingAudio = path.join(config.outputFolder, name);

    logger.info(`Transcribing ${name}`);
    const { text } = await transcribeFile(config, logger, name.replace(/\.ogg$/, ''), workingAudio, signal);

    const txtName = name.replace(/\.ogg$/, '.txt');
    fs.writeFileSync(path.join(config.outputFolder, txtName), text, 'utf8');

    fs.renameSync(workingAudio, path.join(processedDir, name));
    fs.renameSync(path.join(config.outputFolder, txtName), path.join(processedDir, txtName));

    db.markTranscribed(name);
    db.save();
    transcribed++;
    logger.success(`Transcribed ${name}`);
  }

  logger.success(`Done. ${transcribed} file(s) transcribed.`);
  return { transcribed };
}
