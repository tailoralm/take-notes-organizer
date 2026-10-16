import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChunks } from '../src/audio/chunking';
import type { Silence } from '../src/audio/audio';

const silence = (start: number, end: number): Silence => ({ start, end });

test('short audio yields a single chunk', () => {
  assert.deepEqual(buildChunks(120, [], 300, 1), [{ start: 0, end: 120 }]);
});

test('no silences: fixed boundaries with overlap', () => {
  const chunks = buildChunks(640, [], 300, 1);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[0].end, 300);
  assert.equal(chunks[1].start, 299);
  assert.equal(chunks[1].end, 600);
  assert.equal(chunks[2].start, 599);
  assert.equal(chunks[2].end, 640);
});

test('boundary shifts to the nearest silence start', () => {
  const chunks = buildChunks(640, [silence(305, 307)], 300, 1);
  assert.equal(chunks[0].end, 305);
  assert.equal(chunks[1].start, 304);
});

test('silence too far from the ideal boundary is ignored', () => {
  const chunks = buildChunks(640, [silence(500, 501)], 300, 1);
  assert.equal(chunks[0].end, 300);
  assert.equal(chunks[1].start, 299);
});

test('tiny trailing remainder is folded into the last chunk', () => {
  const chunks = buildChunks(601, [], 300, 1);
  assert.equal(chunks[chunks.length - 1].end, 601);
  assert.equal(chunks.length, 2);
});

test('chunks never cut closer than the overlap allows', () => {
  const chunks = buildChunks(1000, [silence(10, 12)], 300, 60);
  assert.ok(chunks[0].end >= 120, `chunk ends too early: ${chunks[0].end}`);
  assert.equal(chunks[0].start, 0);
});

test('all chunks are contiguous with the requested overlap', () => {
  const chunks = buildChunks(1000, [silence(305, 307), silence(610, 612)], 300, 1);
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].start >= chunks[i - 1].end - 1 - 0.001);
    assert.ok(chunks[i].end > chunks[i].start);
  }
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[chunks.length - 1].end, 1000);
});