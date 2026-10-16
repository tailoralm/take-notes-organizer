import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/config';
import { delay, OperationCancelledError, throwIfAborted } from '../core/cancellation';
import type { Logger } from '../core/logger';
import type { Segment } from '../audio/segments';

export interface TranscribeOptions {
  /** Per-request beam size override (faster-whisper `beam`), e.g. 1. */
  beam?: number;
  /** Sampling temperature, e.g. 0.2. */
  temperature?: number;
}

export interface WhisperResult {
  segments: Segment[];
  text: string;
}

/**
 * One transcription request against the OpenAI-compatible Whisper API.
 * Uses verbose_json so segments (and their timestamps) can be inspected;
 * always sets language explicitly and never sends a prompt.
 */
export async function transcribeAudio(
  config: Config,
  audioPath: string,
  options: TranscribeOptions = {},
  signal?: AbortSignal,
): Promise<WhisperResult> {
  throwIfAborted(signal);
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('file', new Blob([fs.readFileSync(audioPath)]), path.basename(audioPath));
  form.append('language', config.language);
  form.append('response_format', 'verbose_json');
  form.append('temperature', String(options.temperature ?? 0));
  if (options.beam !== undefined) {
    form.append('beam', String(options.beam));
  }

  const headers: Record<string, string> = {};
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const res = await fetch(`${config.whisperUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
    signal,
  });

  if (!res.ok) {
    throw new Error(`Whisper transcription failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    text?: string;
    duration?: number;
    segments?: Array<{ start?: number; end?: number; text?: string }>;
  };

  const text = (data.text ?? '').trim();
  const segments: Segment[] = (data.segments ?? [])
    .map((segment) => ({
      start: Number(segment.start ?? 0),
      end: Number(segment.end ?? (segment.start ?? 0)),
      text: (segment.text ?? '').trim(),
    }))
    .filter((segment) => segment.text.length > 0);

  if (segments.length === 0) {
    if (!text) throw new Error('Whisper returned an empty transcription');
    const duration = Number(data.duration ?? 1);
    segments.push({ start: 0, end: duration > 0 ? duration : 1, text });
  }

  return { segments, text: text || segments.map((s) => s.text).join(' ') };
}

/**
 * Polls the Whisper server until its model list answers. large-v3 on CUDA can
 * load slowly, so the default timeout is generous (10 minutes).
 */
export async function waitForWhisper(
  config: Config,
  logger: Logger,
  signal?: AbortSignal,
  timeoutMs = 10 * 60 * 1000,
): Promise<void> {
  const startedAt = Date.now();
  const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined;

  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(signal);
    try {
      const res = await fetch(`${config.whisperUrl}/v1/models`, { headers, signal });
      if (res.ok) return;
    } catch {
      if (signal?.aborted) throw new OperationCancelledError();
    }
    logger.info('Waiting for Whisper server to be ready...');
    await delay(10_000, signal);
  }

  throw new Error(`Whisper server not ready at ${config.whisperUrl} after ${timeoutMs / 1000}s`);
}