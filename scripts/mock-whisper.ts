import * as http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 9000);

const CLEAN_TEXT =
  'Olá, este é um teste de transcrição bem sucedido. O áudio foi dividido em blocos. ' +
  'Cada bloco foi transcrito separadamente. E depois os resultados foram mesclados. ' +
  'A detecção de repetição foi aplicada ao final. Tudo funcionou como esperado. Obrigado.';

const LOOP_TEXT = 'Obrigado por assistir. ';

function cleanSegments(): Array<{ start: number; end: number; text: string }> {
  const sentences = CLEAN_TEXT.match(/[^.!?]+[.!?]?\s*/g) ?? [CLEAN_TEXT];
  const segments = sentences.map((sentence, i) => {
    const start = i * 5;
    return { start, end: start + 4.5, text: sentence.trim() };
  });
  return segments;
}

function loopSegments(): Array<{ start: number; end: number; text: string }> {
  return Array.from({ length: 12 }, (_, i) => ({
    start: i * 4.3,
    end: i * 4.3 + 3.8,
    text: LOOP_TEXT.trim(),
  }));
}

/**
 * Reads a field value out of a raw multipart/form-data body. Only handles the
 * simple string form fields used by the app (no file parsing needed).
 */
function multipartField(body: string, name: string): string | undefined {
  const marker = `name="${name}"`;
  const fieldIndex = body.indexOf(marker);
  if (fieldIndex === -1) return undefined;
  const valueStart = body.indexOf('\r\n\r\n', fieldIndex);
  if (valueStart === -1) return undefined;
  const valueEnd = body.indexOf('\r\n', valueStart + 4);
  return body.slice(valueStart + 4, valueEnd === -1 ? undefined : valueEnd).trim();
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'whisper-1' }] }));
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      const temperature = multipartField(body, 'temperature') ?? '0';
      const beam = multipartField(body, 'beam');
      const language = multipartField(body, 'language') ?? 'auto';
      const responseFormat = multipartField(body, 'response_format') ?? 'json';

      if (language !== 'pt') {
        console.warn(`mock: unexpected language "${language}"`);
      }

      const segments = temperature === '0.2' ? cleanSegments() : loopSegments();
      const data = {
        task: 'transcribe',
        language,
        duration: segments.length ? segments[segments.length - 1].end : 0,
        text: segments.map((s) => s.text).join(' '),
        segments,
      };
      if (responseFormat === 'json' || responseFormat === 'text') {
        const payload =
          responseFormat === 'text' ? data.text : JSON.stringify({ text: data.text });
        res.writeHead(200, { 'Content-Type': responseFormat === 'text' ? 'text/plain' : 'application/json' });
        res.end(payload);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Mock Whisper server running at http://127.0.0.1:${PORT}`);
  console.log('Returns looping segments for temperature != 0.2, clean segments for temperature = 0.2.');
});