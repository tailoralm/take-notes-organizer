import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/config';
import { DB_FILE, NOTES_DIR, PROCESSED_DIR, VOICE_NOTE_PATTERN } from '../config/constants';
import type { Logger } from '../core/logger';
import { TranscriptsDb } from '../repositories/transcripts-repository';

/** Voice note names present in a folder, sorted for stable, resumable runs. */
export function findVoiceNotes(folder: string): string[] {
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((name) => VOICE_NOTE_PATTERN.test(name))
    .sort();
}

/**
 * Voice notes already sitting in the output folder that still need transcription.
 * These are files that were copied by the app or moved in by hand (e.g. to re-run
 * a transcription), so the source folder is irrelevant here.
 */
export function pendingVoiceNotes(config: Config, db: TranscriptsDb): string[] {
  return findVoiceNotes(config.outputFolder).filter((name) => !db.get(name)?.transcribed);
}

/**
 * Voice notes still only present in the origin folder that have not been copied to
 * the output folder yet. Only the explicit "copy from origin" run uses this list.
 */
export function copyPendingVoiceNotes(config: Config, db: TranscriptsDb): string[] {
  const processedDir = path.join(config.outputFolder, PROCESSED_DIR);
  return findVoiceNotes(config.inputFolder).filter((name) => {
    if (db.get(name)?.transcribed) return false;
    if (fs.existsSync(path.join(processedDir, name))) return false;
    if (fs.existsSync(path.join(config.outputFolder, name))) return false;
    return true;
  });
}

/**
 * Transcribed notes that have not been LLM-refined yet and whose raw .txt is
 * still present in the processed folder. These are the files the refine run
 * works on. Entries whose name is not a valid voice note name are ignored so a
 * malformed JSON entry can never drive a read or write outside the folders.
 */
export function pendingRefineNotes(config: Config, db: TranscriptsDb): string[] {
  const processedDir = path.join(config.outputFolder, PROCESSED_DIR);
  return db
    .all()
    .filter((entry) => entry.transcribed && !entry.refinedByLLM && VOICE_NOTE_PATTERN.test(entry.audioFile))
    .map((entry) => entry.audioFile)
    .filter((name) => fs.existsSync(path.join(processedDir, name.replace(/\.ogg$/, '.txt'))))
    .sort();
}

/**
 * Warns about entries whose state in the JSON does not match the actual files:
 * transcribed entries must have their audio and txt in the processed folder,
 * refined entries their refined text and note, and pending entries must still
 * have the copied audio in the output folder.
 */
export function validateMismatches(config: Config, db: TranscriptsDb, logger: Logger): void {
  for (const entry of db.all()) {
    if (entry.transcribed) {
      const processedDir = path.join(config.outputFolder, PROCESSED_DIR);
      const audioPath = path.join(processedDir, entry.audioFile);
      const txtPath = path.join(processedDir, entry.audioFile.replace(/\.ogg$/, '.txt'));
      if (!fs.existsSync(audioPath) || !fs.existsSync(txtPath)) {
        logger.warn(
          `Mismatch: JSON says ${entry.audioFile} is transcribed, but the file is missing in the ${PROCESSED_DIR} folder.`,
        );
      }
      if (entry.refinedByLLM) {
        const refinedPath = path.join(
          processedDir,
          entry.refinedTextFile ?? entry.audioFile.replace(/\.ogg$/, '.refined.txt'),
        );
        const notePath = path.join(config.outputFolder, NOTES_DIR, entry.audioFile.replace(/\.ogg$/, '.md'));
        if (!fs.existsSync(refinedPath) || !fs.existsSync(notePath)) {
          logger.warn(
            `Mismatch: JSON says ${entry.audioFile} is refined, but the refined text or note is missing.`,
          );
        }
      }
    } else {
      const copyPath = path.join(config.outputFolder, entry.audioFile);
      if (!fs.existsSync(copyPath)) {
        logger.warn(
          `Mismatch: JSON says ${entry.audioFile} was copied, but the copied file is missing in the output folder.`,
        );
      }
    }
  }
}

/**
 * Ensures the output folders exist, loads the transcripts repository and logs
 * file/state mismatches. Shared by every pipeline step.
 */
export function openDb(config: Config, logger: Logger): { db: TranscriptsDb; processedDir: string } {
  const processedDir = path.join(config.outputFolder, PROCESSED_DIR);
  fs.mkdirSync(config.outputFolder, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });

  const db = new TranscriptsDb(path.join(config.outputFolder, DB_FILE));
  db.load();
  validateMismatches(config, db, logger);
  return { db, processedDir };
}
