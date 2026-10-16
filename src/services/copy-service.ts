import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/config';
import { throwIfAborted } from '../core/cancellation';
import type { Logger } from '../core/logger';
import { copyPendingVoiceNotes, openDb } from './inventory-service';

export interface CopyResult {
  copied: number;
}

/**
 * Copies voice notes that only exist in the origin folder into the output folder
 * and records them as copied in the JSON. Copying never transcribes; the files
 * land in the output folder where "process" picks them up.
 */
export async function copyAll(config: Config, logger: Logger, signal?: AbortSignal): Promise<CopyResult> {
  const { db } = openDb(config, logger);

  const pending = copyPendingVoiceNotes(config, db);
  if (pending.length === 0) {
    logger.info('No voice notes to copy.');
    return { copied: 0 };
  }

  let copied = 0;
  for (const name of pending) {
    throwIfAborted(signal);
    const srcPath = path.join(config.inputFolder, name);
    const destPath = path.join(config.outputFolder, name);
    try {
      fs.copyFileSync(srcPath, destPath);
    } catch (error) {
      logger.error(`Failed to copy ${name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    db.markCopied(name);
    db.save();
    copied++;
    logger.info(`Copied ${name}`);
  }

  logger.success(`Done. ${copied} file(s) copied.`);
  return { copied };
}
