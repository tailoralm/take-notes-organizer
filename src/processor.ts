import * as fs from 'node:fs';
import * as path from 'node:path';
import { TranscriptsDb } from './db';
import { transcribeFile } from './transcriber';

const VOICE_NOTE_PATTERN = /^voice_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.ogg$/;
const DB_FILE = 'transcripts.json';
const PROCESSED_DIR = 'processed';

export interface Config {
  inputFolder: string;
  outputFolder: string;
  whisperUrl: string;
  apiKey?: string;
  /** Sound level (dB) under which a region counts as silence, e.g. -35. */
  silenceThresholdDb: number;
  /** Internal silences longer than this many seconds are trimmed. */
  silenceTrimSeconds: number;
  /** BCP-47 language sent on every transcription request. */
  language: string;
  /** Target length of each chunk in seconds. */
  chunkLengthSeconds: number;
  /** Overlap between consecutive chunks in seconds. */
  chunkOverlapSeconds: number;
  /** Sampling temperature for the primary transcription attempts. */
  temperature: number;
}

export interface Logger {
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  success: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export function loadConfig(): Config {
  const inputFolder = process.env.AUDIO_NOTES_FOLDER;
  const outputFolder = process.env.AUDIO_NOTES_OUTPUT_FOLDER;

  if (!inputFolder || !outputFolder) {
    throw new Error(
      'Missing required env vars AUDIO_NOTES_FOLDER or AUDIO_NOTES_OUTPUT_FOLDER. Copy .env.example to .env and fill it in.',
    );
  }

  return {
    inputFolder,
    outputFolder,
    whisperUrl: process.env.WHISPER_URL ?? 'http://127.0.0.1:9000',
    apiKey: process.env.WHISPER_API_KEY || undefined,
    silenceThresholdDb: numEnv('WHISPER_SILENCE_THRESHOLD_DB', -35),
    silenceTrimSeconds: numEnv('WHISPER_SILENCE_TRIM_SECONDS', 2),
    language: process.env.WHISPER_LANGUAGE ?? 'pt',
    chunkLengthSeconds: numEnv('WHISPER_CHUNK_SECONDS', 300),
    chunkOverlapSeconds: numEnv('WHISPER_CHUNK_OVERLAP_SECONDS', 1),
    temperature: numEnv('WHISPER_TEMPERATURE', 0),
  };
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function findVoiceNotes(folder: string): string[] {
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((name) => VOICE_NOTE_PATTERN.test(name))
    .sort();
}

function pendingVoiceNotes(config: Config, db: TranscriptsDb): string[] {
  const processedDir = path.join(config.outputFolder, PROCESSED_DIR);
  return findVoiceNotes(config.inputFolder).filter((name) => {
    if (db.get(name)?.transcribed) return false;
    if (fs.existsSync(path.join(processedDir, name))) return false;
    return true;
  });
}

export interface Status {
  processed: number;
  pending: number;
}

export function getStatus(config: Config): Status {
  const db = new TranscriptsDb(path.join(config.outputFolder, DB_FILE));
  db.load();
  return {
    processed: db.all().filter((entry) => entry.transcribed).length,
    pending: pendingVoiceNotes(config, db).length,
  };
}

/**
 * Warns about entries whose state in the JSON does not match the actual files:
 * transcribed entries must have their audio and txt in the processed folder,
 * pending entries must still have the copied audio in the output folder.
 */
function validateMismatches(config: Config, db: TranscriptsDb, logger: Logger): void {
  for (const entry of db.all()) {
    if (entry.transcribed) {
      const audioPath = path.join(config.outputFolder, PROCESSED_DIR, entry.audioFile);
      const txtPath = path.join(config.outputFolder, PROCESSED_DIR, entry.audioFile.replace(/\.ogg$/, '.txt'));
      if (!fs.existsSync(audioPath) || !fs.existsSync(txtPath)) {
        logger.warn(
          `Mismatch: JSON says ${entry.audioFile} is transcribed, but the file is missing in the ${PROCESSED_DIR} folder.`,
        );
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

async function waitForWhisper(config: Config, logger: Logger, timeoutMs = 10 * 60 * 1000): Promise<void> {
  const startedAt = Date.now();
  const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${config.whisperUrl}/v1/models`, { headers });
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    logger.info('Waiting for Whisper server to be ready...');
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  throw new Error(`Whisper server not ready at ${config.whisperUrl} after ${timeoutMs / 1000}s`);
}

export interface ProcessingResult {
  copied: number;
  transcribed: number;
}

export async function processAll(config: Config, logger: Logger): Promise<ProcessingResult> {
  const processedDir = path.join(config.outputFolder, PROCESSED_DIR);
  fs.mkdirSync(config.outputFolder, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });

  const db = new TranscriptsDb(path.join(config.outputFolder, DB_FILE));
  db.load();
  validateMismatches(config, db, logger);

  const pending = pendingVoiceNotes(config, db);

  if (pending.length === 0) {
    logger.info('No voice notes to process.');
    return { copied: 0, transcribed: 0 };
  }

  await waitForWhisper(config, logger);

  let copied = 0;
  let transcribed = 0;

  for (const name of pending) {
    const workingAudio = path.join(config.outputFolder, name);
    const srcPath = path.join(config.inputFolder, name);

    if (!db.get(name)) {
      fs.copyFileSync(srcPath, workingAudio);
      db.markCopied(name);
      db.save();
      copied++;
      logger.info(`Copied ${name}`);
    } else if (!fs.existsSync(workingAudio)) {
      logger.warn(`Mismatch: copied file for ${name} is missing, re-copying from the input folder.`);
      fs.copyFileSync(srcPath, workingAudio);
      copied++;
      logger.info(`Re-copied ${name}`);
    }

    logger.info(`Transcribing ${name}`);
    const { text } = await transcribeFile(config, logger, name.replace(/\.ogg$/, ''), workingAudio);

    const txtName = name.replace(/\.ogg$/, '.txt');
    fs.writeFileSync(path.join(config.outputFolder, txtName), text, 'utf8');

    fs.renameSync(workingAudio, path.join(processedDir, name));
    fs.renameSync(path.join(config.outputFolder, txtName), path.join(processedDir, txtName));

    db.markTranscribed(name);
    db.save();
    transcribed++;
    logger.success(`Transcribed ${name}`);
  }

  logger.success(`Done. ${copied} file(s) copied, ${transcribed} file(s) transcribed.`);
  return { copied, transcribed };
}