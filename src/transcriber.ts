import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config, Logger } from './processor';
import { convertToWav, detectSilence, extractWav, getDuration, type Silence } from './audio';
import { buildChunks, type Chunk } from './chunking';
import {
  collapseConsecutiveDuplicates,
  detectRepetition,
  formatTime,
  mergeSegments,
  normalizeText,
  offsetSegments,
  segmentsToText,
  type Segment,
} from './segments';
import { transcribeAudio, type TranscribeOptions } from './whisper';

const SILENCE_TOLERANCE = 0.5;

export interface FileTranscript {
  text: string;
  possibleHallucination: boolean;
}

interface Strategy extends TranscribeOptions {
  label: string;
  /** Retry with a smaller chunk size (about smallChunkSeconds). */
  small?: boolean;
}

interface ChunkAttempt {
  label: string;
  segments: Segment[];
  maxRun: number;
  ratio: number;
  flagged: boolean;
  failed: boolean;
  error?: string;
}

function silencesWithin(silences: Silence[], from: number, to: number): Silence[] {
  return silences
    .filter((s) => s.end > from && s.start < to)
    .map((s) => ({
      start: Math.max(0, s.start - from),
      end: Math.min(to - from, s.end - from),
    }));
}

/**
 * Transcribes the given (absolute) ranges of a WAV, one request per range,
 * merging them with timestamps offset by range start and overlap duplicates
 * removed. Everything stays on the source file's timeline.
 */
async function transcribeWavRanges(
  config: Config,
  srcWav: string,
  ranges: Chunk[],
  workDir: string,
  prefix: string,
  options: Strategy,
): Promise<Segment[]> {
  const groups: Segment[][] = [];
  for (let i = 0; i < ranges.length; i++) {
    const { start, end } = ranges[i];
    const rangeWav = path.join(workDir, `${prefix}-${i}.wav`);
    await extractWav(srcWav, rangeWav, start, end);
    const result = await transcribeAudio(config, rangeWav, options);
    groups.push(offsetSegments(result.segments, start));
  }
  return mergeSegments(...groups);
}

function buildStrategies(config: Config): Strategy[] {
  return [
    { label: 'default', temperature: config.temperature },
    { label: 'beam=1', beam: 1, temperature: config.temperature },
    {
      label: `temperature=${config.retryTemperature}, ${config.smallChunkSeconds}s chunks`,
      temperature: config.retryTemperature,
      small: true,
    },
  ];
}

function bestAttempt(attempts: ChunkAttempt[]): ChunkAttempt {
  return attempts
    .filter((a) => !a.failed)
    .sort((a, b) => {
      if (a.flagged !== b.flagged) return a.flagged ? 1 : -1;
      if (a.ratio !== b.ratio) return a.ratio - b.ratio;
      return a.maxRun - b.maxRun;
    })[0];
}

async function transcribeChunk(
  config: Config,
  logger: Logger,
  wavPath: string,
  chunk: Chunk,
  silences: Silence[],
  workDir: string,
  prefix: string,
  baseName: string,
): Promise<{ segments: Segment[]; flagged: boolean }> {
  const attempts: ChunkAttempt[] = [];
  const strategies = buildStrategies(config).slice(0, Math.min(config.maxRetries, 2) + 1);

  for (const strategy of strategies) {
    let segments: Segment[];
    try {
      const ranges: Chunk[] = strategy.small
        ? buildChunks(
            chunk.end - chunk.start,
            silencesWithin(silences, chunk.start, chunk.end),
            config.smallChunkSeconds,
            config.chunkOverlapSeconds,
            SILENCE_TOLERANCE,
          ).map((sub) => ({ start: sub.start + chunk.start, end: sub.end + chunk.start }))
        : [{ start: chunk.start, end: chunk.end }];
      segments = await transcribeWavRanges(config, wavPath, ranges, workDir, `${prefix}-${strategy.label}`, strategy);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({
        label: strategy.label,
        segments: [],
        maxRun: 0,
        ratio: 0,
        flagged: true,
        failed: true,
        error: message,
      });
      logger.warn(`${baseName} chunk ${formatTime(chunk.start)}-${formatTime(chunk.end)}: attempt (${strategy.label}) failed: ${message}`);
      continue;
    }

    const text = segmentsToText(segments);
    const { flagged, maxRun, ratio } = detectRepetition(
      segments,
      config.repeatLimit,
      config.compressionRatioThreshold,
    );
    attempts.push({ label: strategy.label, segments, maxRun, ratio, flagged, failed: false });
    logger.info(
      `${baseName} chunk ${formatTime(chunk.start)}-${formatTime(chunk.end)}: attempt (${strategy.label}) ` +
        `${segments.length} segment(s), repeat run ${maxRun}, ratio ${ratio.toFixed(2)}${flagged ? ' [flagged]' : ''}`,
    );
    if (!flagged) break;
  }

  const best = bestAttempt(attempts);
  if (!best) {
    const firstError = attempts.find((a) => a.error)?.error ?? 'unknown error';
    throw new Error(`${baseName} chunk ${formatTime(chunk.start)}-${formatTime(chunk.end)}: all transcription attempts failed (${firstError})`);
  }

  if (best.flagged) {
    const before = best.segments.length;
    const collapsed = collapseConsecutiveDuplicates(best.segments);
    logger.warn(
      `${baseName} chunk ${formatTime(chunk.start)}-${formatTime(chunk.end)}: possible hallucination detected, ` +
        `kept best attempt (${best.label}) and collapsed ${before - collapsed.length} repeated segment(s). ` +
        `Marked as possible_hallucination in the output.`,
    );
    return { segments: collapsed, flagged: true };
  }
  return { segments: best.segments, flagged: false };
}

interface ChunkResult {
  chunk: Chunk;
  segments: Segment[];
  flagged: boolean;
}

function renderText(results: ChunkResult[]): string {
  const parts: string[] = [];
  let last: Segment | null = null;
  for (const { chunk, segments, flagged } of results) {
    if (flagged) {
      parts.push(`[possible_hallucination ${formatTime(chunk.start)}-${formatTime(chunk.end)}]`);
    }
    for (const segment of segments) {
      const norm = normalizeText(segment.text);
      if (
        last &&
        norm.length >= 2 &&
        norm === normalizeText(last.text) &&
        segment.start < last.end + 0.001
      ) {
        continue;
      }
      parts.push(segment.text.trim());
      last = segment;
    }
  }
  return parts.join(' ');
}

/**
 * Transcribes one audio file end to end: converts it to a 16 kHz mono WAV
 * (trimming long silences), splits it into ~chunkLength chunks cut at silence
 * points, transcribes each chunk with retries when a hallucination loop is
 * detected, and merges everything back into a single text (chunk overlaps
 * deduplicated, flagged chunks marked as possible_hallucination).
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

    let possibleHallucination = false;
    const results: ChunkResult[] = [];
    for (let i = 0; i < chunks.length; i++) {
      logger.info(`Transcribing chunk ${i + 1}/${chunks.length} (${formatTime(chunks[i].start)}-${formatTime(chunks[i].end)}).`);
      const result = await transcribeChunk(
        config,
        logger,
        wavPath,
        chunks[i],
        silences,
        workDir,
        `chunk${i}`,
        baseName,
      );
      results.push({ chunk: chunks[i], ...result });
      if (result.flagged) possibleHallucination = true;
    }

    return { text: renderText(results), possibleHallucination };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}