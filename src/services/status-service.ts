import * as path from 'node:path';
import type { Config } from '../config/config';
import { DB_FILE } from '../config/constants';
import { TranscriptsDb } from '../repositories/transcripts-repository';
import {
  copyPendingVoiceNotes,
  pendingRefineNotes,
  pendingVoiceNotes,
} from './inventory-service';

export interface Status {
  processed: number;
  pending: number;
  toCopy: number;
  toRefine: number;
}

/** Snapshot of the pipeline counts shown by the web UI. */
export function getStatus(config: Config): Status {
  const db = new TranscriptsDb(path.join(config.outputFolder, DB_FILE));
  db.load();
  return {
    processed: db.all().filter((entry) => entry.transcribed).length,
    pending: pendingVoiceNotes(config, db).length,
    toCopy: copyPendingVoiceNotes(config, db).length,
    toRefine: pendingRefineNotes(config, db).length,
  };
}
