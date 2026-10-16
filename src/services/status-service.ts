import * as path from 'node:path';
import type { Config } from '../config/config';
import { DB_FILE } from '../config/constants';
import { TranscriptsDb } from '../repositories/transcripts-repository';
import { copyPendingVoiceNotes, pendingVoiceNotes } from './inventory-service';

export interface Status {
  /** Notes still only in the origin folder, not copied yet. */
  toCopy: number;
  /** Notes in the output folder, not transcribed yet. */
  pending: number;
  /** Notes already transcribed. */
  transcribed: number;
  /** Notes refined by the LLM. */
  refined: number;
}

/** Snapshot of the pipeline counts shown by the web UI. */
export function getStatus(config: Config): Status {
  const db = new TranscriptsDb(path.join(config.outputFolder, DB_FILE));
  db.load();
  const entries = db.all();
  return {
    toCopy: copyPendingVoiceNotes(config, db).length,
    pending: pendingVoiceNotes(config, db).length,
    transcribed: entries.filter((entry) => entry.transcribed).length,
    refined: entries.filter((entry) => entry.refinedByLLM).length,
  };
}
