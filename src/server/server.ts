import 'dotenv/config';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { loadConfig, type Config } from '../config/config';
import type { Logger } from '../core/logger';
import { copyAll } from '../services/copy-service';
import { processAll } from '../services/process-service';
import { refineAll } from '../services/refine-service';
import { getStatus } from '../services/status-service';

const PORT = Number(process.env.PORT ?? 8080);
const STATIC_DIR = path.join(__dirname, '..', '..', 'public');

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

let running = false;

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

type Run = (config: Config, logger: Logger) => Promise<object>;

/**
 * Runs one pipeline operation and streams its NDJSON log. Copy, process and
 * refine share the same lock, so only one of them can run at a time.
 */
function runStream(req: http.IncomingMessage, res: http.ServerResponse, run: Run): void {
  if (!config) {
    sendJson(res, 500, { error: configError });
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return;
  }
  if (running) {
    sendJson(res, 409, { error: 'Another run is already in progress.' });
    return;
  }

  running = true;
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

  run(config, logger)
    .then((result) => {
      res.write(JSON.stringify({ type: 'done', ...result }) + '\n');
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(message);
      streamEvent(res, 'error', { message });
    })
    .finally(() => {
      running = false;
      res.end();
    });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  switch (url.pathname) {
    case '/api/status':
      handleStatus(res);
      return;
    case '/api/copy':
      runStream(req, res, copyAll);
      return;
    case '/api/process':
      runStream(req, res, processAll);
      return;
    case '/api/refine':
      runStream(req, res, refineAll);
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
