import { gzipSync } from 'node:zlib';

export interface Segment {
  start: number;
  end: number;
  text: string;
}

/** Lowercases, strips punctuation and collapses whitespace for text comparison. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function offsetSegments(segments: Segment[], offset: number): Segment[] {
  return segments.map((segment) => ({
    ...segment,
    start: segment.start + offset,
    end: segment.end + offset,
  }));
}

/**
 * Merges ordered groups of (already offset) segments, dropping a segment when
 * it is identical to the last kept one and overlaps it in time. Those are the
 * duplicates introduced by the chunk overlap.
 */
export function mergeSegments(...groups: Segment[][]): Segment[] {
  const merged: Segment[] = [];
  let last: Segment | null = null;
  for (const group of groups) {
    for (const segment of group) {
      const norm = normalizeText(segment.text);
      if (
        last &&
        norm &&
        norm === normalizeText(last.text) &&
        segment.start < last.end + 0.001
      ) {
        continue;
      }
      merged.push(segment);
      last = segment;
    }
  }
  return merged;
}

export function segmentsToText(segments: Segment[]): string {
  return segments.map((s) => s.text.trim()).filter(Boolean).join(' ');
}

/** gzip-compressed size over raw byte length of the text (like Whisper's compression_ratio). */
export function gzipRatio(text: string): number {
  if (!text) return 0;
  const compressed = gzipSync(text, { level: 9 }).length;
  return compressed / Buffer.byteLength(text, 'utf8');
}

export interface RepetitionResult {
  flagged: boolean;
  maxRun: number;
  ratio: number;
}

/**
 * Flags a hallucination loop in a chunk's segments: either the same normalized
 * segment text appears repeatLimit (default 3) or more times consecutively, or
 * the gzip compression ratio of the joined text is above ratioThreshold (2.4).
 */
export function detectRepetition(
  segments: Segment[],
  repeatLimit = 3,
  ratioThreshold = 2.4,
): RepetitionResult {
  const text = segmentsToText(segments);
  let maxRun = 0;
  let run = 0;
  let previous: string | null = null;
  for (const segment of segments) {
    const norm = normalizeText(segment.text);
    const voice = norm.length >= 2;
    if (voice && norm === previous) {
      run += 1;
      if (run > maxRun) maxRun = run;
    } else {
      run = voice ? 1 : 0;
    }
    previous = voice ? norm : null;
  }
  // gzip overhead dominates tiny texts, so only trust the ratio on real-length chunks.
  const ratio = gzipRatio(text);
  const ratioFlagged = text.length >= 64 && ratio > ratioThreshold;
  return { flagged: maxRun >= repeatLimit || ratioFlagged, maxRun, ratio };
}

/** Removes consecutive duplicate segments (by normalized text) from an ordered list. */
export function collapseConsecutiveDuplicates(segments: Segment[]): Segment[] {
  const collapsed: Segment[] = [];
  let previous: string | null = null;
  for (const segment of segments) {
    const norm = normalizeText(segment.text);
    const voice = norm.length >= 2;
    if (voice && norm === previous) continue;
    collapsed.push(segment);
    previous = voice ? norm : null;
  }
  return collapsed;
}

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return hours > 0 ? `${String(hours).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}