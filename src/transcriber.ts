import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config, Logger } from './processor';
import { convertToWav, detectSilence, extractWav, getDuration } from './audio';
import { buildChunks, type Chunk } from './chunking';
import { formatTime, mergeSegments, offsetSegments, segmentsToText, type Segment } from './segments';
import { transcribeAudio } from './whisper';

const SILENCE_TOLERANCE = 0.5;

export interface FileTranscript {
  text: string;
  possibleHallucination: boolean;
}

/**
 * Transcribes one audio file end to end: converts it to a 16 kHz mono WAV
 * (trimming long silences), splits it into ~chunkLength chunks cut at silence
 * points, transcribes each chunk in its own request (offsets applied, overlap
 * duplicates removed) and merges everything back into a single text.
 */
export async function transcribeFile(
  config: Config,
  logger: Logger,
  baseName: string,
  inputPath: string,
): Promise<FileTranscript> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-organizer-'));
  try {
    const wavPath = path.join(workDir, `${baseName}.wav`);
    await convertToWav(inputPath, wavPath, config.silenceThresholdDb, config.silenceTrimSeconds);
    const duration = await getDuration(wavPath);
    if (!(duration > 0)) {
      throw new Error('Audio is empty after preprocessing');
    }

    const silences = await detectSilence(wavPath, config.silenceThresholdDb, SILENCE_TOLERANCE);
    const chunks = buildChunks(
      duration,
      silences,
      config.chunkLengthSeconds,
      config.chunkOverlapSeconds,
      SILENCE_TOLERANCE,
    );
    logger.info(
      `Preprocessed ${baseName}: ${duration.toFixed(1)}s split into ${chunks.length} chunk(s) of ~${config.chunkLengthSeconds}s.`,
    );

    const groups: Segment[][] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      logger.info(`Transcribing chunk ${i + 1}/${chunks.length} (${formatTime(chunk.start)}-${formatTime(chunk.end)}).`);
      const chunkWav = path.join(workDir, `chunk${i}.wav`);
      await extractWav(wavPath, chunkWav, chunk.start, chunk.end);
      const result = await transcribeAudio(config, chunkWav, { temperature: config.temperature });
      groups.push(offsetSegments(result.segments, chunk.start));
    }

    const merged = mergeSegments(...groups);
    return { text: segmentsToText(merged), possibleHallucination: false };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}