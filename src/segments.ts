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

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return hours > 0 ? `${String(hours).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}