import type { Silence } from './audio';

export interface Chunk {
  start: number;
  end: number;
}

/**
 * Splits a piece of audio of the given duration into chunks of about
 * chunkLength seconds. Boundaries are shifted to the start of the nearest
 * sufficiently long silence within a margin of the ideal boundary, so words
 * are rarely cut in half. The next chunk starts overlap seconds before the
 * previous boundary, giving Whisper context across the cut.
 */
export function buildChunks(
  duration: number,
  silences: Silence[],
  chunkLength: number,
  overlap: number,
  minSilence = 0.5,
): Chunk[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  if (duration <= chunkLength) return [{ start: 0, end: duration }];

  const sorted = silences
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end - s.start >= minSilence)
    .sort((a, b) => a.start - b.start);

  const margin = Math.min(chunkLength * 0.25, 90);
  const minChunk = overlap * 2;
  const chunks: Chunk[] = [];
  let start = 0;
  let target = chunkLength;

  while (target < duration) {
    let boundary = target;
    let bestDistance = Infinity;
    for (const silence of sorted) {
      if (silence.start < start + minChunk) continue;
      if (silence.start < target - margin) continue;
      if (silence.start > target + margin) break;
      const distance = Math.abs(silence.start - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        boundary = silence.start;
      }
    }
    if (boundary - start < minChunk) {
      boundary = Math.min(duration, start + minChunk);
    }
    if (boundary <= start) {
      boundary = Math.min(duration, start + chunkLength);
    }
    chunks.push({ start, end: boundary });
    start = Math.max(0, boundary - overlap);
    target = boundary + chunkLength;
  }

  const tail = duration - start;
  if (tail > minChunk) {
    chunks.push({ start, end: duration });
  } else if (chunks.length > 0) {
    chunks[chunks.length - 1].end = duration;
  }
  return chunks;
}
