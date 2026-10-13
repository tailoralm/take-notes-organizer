import 'dotenv/config';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { getStatus, loadConfig, processAll, type Config, type Logger } from './processor';

const PORT = Number(process.env.PORT ?? 8080);
const STATIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

let config: Config | null = null;
let configError: string | null = null;
try {
  config = loadConfig();
} catch (error) {
  configError = error instanceof Error ? error.message : String(error);
}

let processing = false;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendStatic(res: http.ServerResponse, pathname: string): void {
  const filePath = path.join(STATIC_DIR, path.basename(pathname));
  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function streamEvent(res: http.ServerResponse, type: string, payload: Record<string, unknown>): void {
  if (res.destroyed) return;
  res.write(JSON.stringify({ type, ...payload }) + '\n');
}

function handleStatus(res: http.ServerResponse): void {
  if (!config) {
    sendJson(res, 500, { error: configError });
    return;
  }
  try {
    sendJson(res, 200, getStatus(config));
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function handleProcess(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!config) {
    sendJson(res, 500, { error: configError });
    return;
  }
  if (processing) {
    sendJson(res, 409, { error: 'A processing run is already in progress.' });
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return;
  }

  processing = true;
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
  });

  const logger: Logger = {
    info: (message) => streamEvent(res, 'log', { level: 'info', message }),
    success: (message) => streamEvent(res, 'log', { level: 'success', message }),
    warn: (message) => streamEvent(res, 'log', { level: 'warn', message }),
    error: (message) => streamEvent(res, 'log', { level: 'error', message }),
  };

  processAll(config, logger)
    .then((result) => {
      res.write(JSON.stringify({ type: 'done', ...result }) + '\n');
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(message);
      streamEvent(res, 'error', { message });
    })
    .finally(() => {
      processing = false;
      res.end();
    });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  switch (url.pathname) {
    case '/api/status':
      handleStatus(res);
      return;
    case '/api/process':
      handleProcess(req, res);
      return;
    case '/':
      sendStatic(res, '/index.html');
      return;
    case '/index.html':
    case '/style.css':
    case '/app.js':
      sendStatic(res, url.pathname);
      return;
    case '/favicon.ico':
      res.writeHead(204);
      res.end();
      return;
    default:
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Take Notes Organizer web UI running at http://127.0.0.1:${PORT}`);
  if (configError) console.warn(configError);
});