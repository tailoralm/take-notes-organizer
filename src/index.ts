import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TranscriptsDb } from './db';

const VOICE_NOTE_PATTERN = /^voice_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.ogg$/;
const DB_FILE = 'transcripts.json';
const PROCESSED_DIR = 'processed';

interface Config {
  inputFolder: string;
  outputFolder: string;
  whisperUrl: string;
  apiKey?: string;
}

function loadConfig(): Config {
  const inputFolder = process.env.AUDIO_NOTES_FOLDER;
  const outputFolder = process.env.AUDIO_NOTES_OUTPUT_FOLDER;

  if (!inputFolder || !outputFolder) {
    console.error(
      'Missing required env vars AUDIO_NOTES_FOLDER or AUDIO_NOTES_OUTPUT_FOLDER. Copy .env.example to .env and fill it in.',
    );
    process.exit(1);
  }

  return {
    inputFolder,
    outputFolder,
    whisperUrl: process.env.WHISPER_URL ?? 'http://127.0.0.1:9000',
    apiKey: process.env.WHISPER_API_KEY || undefined,
  };
}

function findVoiceNotes(folder: string): string[] {
  if (!fs.existsSync(folder)) {
    console.warn(`Input folder does not exist: ${folder}`);
    return [];
  }
  return fs
    .readdirSync(folder)
    .filter((name) => VOICE_NOTE_PATTERN.test(name))
    .sort();
}

/**
 * Warns about entries whose state in the JSON does not match the actual files:
 * transcribed entries must have their audio and txt in the processed folder,
 * pending entries must still have the copied audio in the output folder.
 */
function validateMismatches(config: Config, db: TranscriptsDb): void {
  for (const entry of db.all()) {
    if (entry.transcribed) {
      const audioPath = path.join(config.outputFolder, PROCESSED_DIR, entry.audioFile);
      const txtPath = path.join(config.outputFolder, PROCESSED_DIR, entry.audioFile.replace(/\.ogg$/, '.txt'));
      if (!fs.existsSync(audioPath) || !fs.existsSync(txtPath)) {
        console.warn(
          `Mismatch: JSON says ${entry.audioFile} is transcribed, but the file is missing in the ${PROCESSED_DIR} folder.`,
        );
      }
    } else {
      const copyPath = path.join(config.outputFolder, entry.audioFile);
      if (!fs.existsSync(copyPath)) {
        console.warn(
          `Mismatch: JSON says ${entry.audioFile} was copied, but the copied file is missing in the output folder.`,
        );
      }
    }
  }
}

async function waitForWhisper(config: Config, timeoutMs = 10 * 60 * 1000): Promise<void> {
  const startedAt = Date.now();
  const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${config.whisperUrl}/v1/models`, { headers });
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    console.log('Waiting for Whisper server to be ready...');
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  throw new Error(`Whisper server not ready at ${config.whisperUrl} after ${timeoutMs / 1000}s`);
}

async function transcribe(config: Config, audioPath: string): Promise<string> {
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('file', new Blob([fs.readFileSync(audioPath)]), path.basename(audioPath));

  const headers: Record<string, string> = {};
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const res = await fetch(`${config.whisperUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Whisper transcription failed (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as { text?: string };
  const text = data.text?.trim();
  if (!text) throw new Error('Whisper returned an empty transcription');
  return text;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const processedDir = path.join(config.outputFolder, PROCESSED_DIR);
  fs.mkdirSync(config.outputFolder, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });

  const db = new TranscriptsDb(path.join(config.outputFolder, DB_FILE));
  db.load();
  validateMismatches(config, db);

  const pending = findVoiceNotes(config.inputFolder).filter((name) => {
    if (db.get(name)?.transcribed) return false;
    if (fs.existsSync(path.join(processedDir, name))) return false;
    return true;
  });

  if (pending.length === 0) {
    console.log('No voice notes to process.');
    return;
  }

  await waitForWhisper(config);

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
      console.log(`Copied ${name}`);
    } else if (!fs.existsSync(workingAudio)) {
      console.warn(`Mismatch: copied file for ${name} is missing, re-copying from the input folder.`);
      fs.copyFileSync(srcPath, workingAudio);
      copied++;
      console.log(`Re-copied ${name}`);
    }

    console.log(`Transcribing ${name}`);
    const text = await transcribe(config, workingAudio);

    const txtName = name.replace(/\.ogg$/, '.txt');
    fs.writeFileSync(path.join(config.outputFolder, txtName), text, 'utf8');

    fs.renameSync(workingAudio, path.join(processedDir, name));
    fs.renameSync(path.join(config.outputFolder, txtName), path.join(processedDir, txtName));

    db.markTranscribed(name);
    db.save();
    transcribed++;
    console.log(`Transcribed ${name}`);
  }

  console.log(`Done. ${copied} file(s) copied, ${transcribed} file(s) transcribed.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});