import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseConsecutiveDuplicates,
  detectRepetition,
  formatTime,
  gzipRatio,
  mergeSegments,
  normalizeText,
  offsetSegments,
  segmentsToText,
  type Segment,
} from '../src/segments';

function segment(text: string, start = 0, end = 1): Segment {
  return { start, end, text };
}

test('normalizeText lowercases and strips punctuation', () => {
  assert.equal(normalizeText('  Olá, como	vai?! '), 'olá como vai');
  assert.equal(normalizeText('NÃO. Sim...'), 'não sim');
});

test('offsetSegments shifts timestamps without touching text', () => {
  const shifted = offsetSegments([segment('oi', 1.5, 2.5)], 100);
  assert.deepEqual(shifted, [{ start: 101.5, end: 102.5, text: 'oi' }]);
});

test('gzipRatio returns a number and is lower for very repetitive text', () => {
  const repeated = 'olá olá olá olá olá olá olá olá olá olá '.repeat(50);
  const diverse = 'um dois três quatro cinco seis sete oito nove dez '.repeat(10);
  assert.equal(typeof gzipRatio(repeated), 'number');
  assert.ok(gzipRatio(repeated) < gzipRatio(diverse));
});

test('detectRepetition flags three or more consecutive identical segments', () => {
  const clean = [segment('primeira frase'), segment('segunda frase'), segment('terceira frase')];
  assert.equal(detectRepetition(clean, 3, 100).flagged, false);

  const looped = [
    segment('obrigado por assistir'),
    segment('obrigado por assistir'),
    segment('obrigado por assistir'),
  ];
  const result = detectRepetition(looped, 3, 100);
  assert.equal(result.flagged, true);
  assert.equal(result.maxRun, 3);
});

test('detectRepetition is case/punctuation-insensitive and counts runs', () => {
  const run = [
    segment('Obrigado por assistir!'),
    segment('obrigado por assistir'),
    segment('Obrigado por assistir.'),
    segment('explicação diferente'),
  ];
  const result = detectRepetition(run, 3, 100);
  assert.equal(result.flagged, true);
  assert.equal(result.maxRun, 3);
});

test('detectRepetition does not flag two identical segments', () => {
  const two = [segment('repetido'), segment('repetido')];
  assert.equal(detectRepetition(two, 3, 100).flagged, false);
});

test('detectRepetition flags compression ratio above the configured threshold', () => {
  const ratioText = Array.from({ length: 300 }, (_, i) => `palavra${i}`).join(' ');
  const segments = ratioText.split(' ').map((word, i) => segment(word, i, i + 0.1));
  const observed = gzipRatio(ratioText);
  assert.ok(observed > 0, 'ratio is computable');
  assert.equal(detectRepetition(segments, 3, observed - 0.05).flagged, true);
  assert.equal(detectRepetition(segments, 3, observed + 0.05).flagged, false);
});

test('mergeSegments drops identical overlapping segments from chunk overlap', () => {
  const chunk1 = [segment('corte da fala', 0, 5), segment('obrigado', 5, 7)];
  const chunk2 = [segment('obrigado', 6, 8), segment('até mais', 8, 10)];
  const merged = mergeSegments(chunk1, chunk2);
  assert.deepEqual(merged.map((s) => s.text), ['corte da fala', 'obrigado', 'até mais']);
});

test('mergeSegments keeps identical text that does not overlap in time', () => {
  const first = [segment('repetido', 0, 2)];
  const second = [segment('repetido', 10, 12)];
  const merged = mergeSegments(first, second);
  assert.equal(merged.length, 2);
});

test('collapseConsecutiveDuplicates keeps first of each run but keeps separated repeats', () => {
  const segments = [
    segment('obrigado por assistir'),
    segment('Obrigado por assistir'),
    segment('obrigado por assistir'),
    segment('próxima frase'),
    segment('Próxima frase'),
    segment('obrigado por assistir'),
  ];
  const collapsed = collapseConsecutiveDuplicates(segments);
  assert.deepEqual(collapsed.map((s) => s.text), [
    'obrigado por assistir',
    'próxima frase',
    'obrigado por assistir',
  ]);
});

test('segmentsToText joins segment texts', () => {
  assert.equal(segmentsToText([segment('um', 0, 1), segment(' dois ', 1, 2)]), 'um dois');
});

test('formatTime renders mm:ss and hh:mm:ss', () => {
  assert.equal(formatTime(65), '01:05');
  assert.equal(formatTime(3600 + 65), '01:01:05');
});