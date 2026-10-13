import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TranscriptEntry {
  audioFile: string;
  transcribed: boolean;
  refinedByLLM: boolean;
}

/**
 * File-backed repository for the transcripts database (transcripts.json).
 * The JSON is an array of entries: { audioFile, transcribed, refinedByLLM }.
 */
export class TranscriptsDb {
  private readonly entries = new Map<string, TranscriptEntry>();

  constructor(private readonly filePath: string) {}

  load(): void {
    if (!fs.existsSync(this.filePath)) return;
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error(`Transcripts database ${this.filePath} must be a JSON array`);
    }
    for (const item of raw as Array<Partial<TranscriptEntry>>) {
      if (typeof item.audioFile !== 'string') continue;
      this.entries.set(item.audioFile, {
        audioFile: item.audioFile,
        transcribed: item.transcribed === true,
        refinedByLLM: item.refinedByLLM === true,
      });
    }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify([...this.entries.values()], null, 2) + '\n',
      'utf8',
    );
  }

  get(audioFile: string): TranscriptEntry | undefined {
    return this.entries.get(audioFile);
  }

  all(): TranscriptEntry[] {
    return [...this.entries.values()];
  }

  markCopied(audioFile: string): void {
    const existing = this.entries.get(audioFile);
    this.entries.set(audioFile, existing ?? { audioFile, transcribed: false, refinedByLLM: false });
  }

  markTranscribed(audioFile: string): void {
    const existing = this.entries.get(audioFile) ?? {
      audioFile,
      transcribed: false,
      refinedByLLM: false,
    };
    this.entries.set(audioFile, { ...existing, transcribed: true });
  }
}