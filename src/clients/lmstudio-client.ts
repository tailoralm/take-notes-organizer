import type { Config } from '../config/config';
import { delay, OperationCancelledError, throwIfAborted } from '../core/cancellation';
import type { Logger } from '../core/logger';
import type { RefineResult } from '../domain/refinement';
import { buildRefineUserPrompt, REFINE_SYSTEM_PROMPT } from '../prompts/refine-prompt';

/** Upper bound for one chat completion, so a stalled server cannot hold the run lock forever. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Extracts the JSON object from a model answer. Tolerates a ```json fence or
 * surrounding prose by taking the outermost braces.
 */
function extractJsonObject(content: string): unknown {
  let text = content.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) text = text.slice(start, end + 1);
  }
  return JSON.parse(text);
}

function normalizeTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().replace(/^#/, '').toLowerCase())
    .filter((tag) => tag.length > 0);
}

function parseRefineResult(content: string): RefineResult {
  const data = extractJsonObject(content) as Partial<Record<keyof RefineResult, unknown>>;
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const resume = typeof data.resume === 'string' ? data.resume.trim() : '';
  const refinedText = typeof data.refinedText === 'string' ? data.refinedText.trim() : '';
  const tags = normalizeTags(data.tags);

  if (!title || !resume || !refinedText) {
    throw new Error('LLM answer is missing one of title/resume/refinedText');
  }
  return { title, tags, resume, refinedText };
}

/**
 * Refines one transcription through LMStudio's OpenAI-compatible chat API and
 * returns the parsed refinement. Throws on transport or JSON errors so the
 * caller can leave the entry un-refined and retry it on the next run.
 */
export async function refineText(
  config: Config,
  logger: Logger,
  text: string,
  signal?: AbortSignal,
): Promise<RefineResult> {
  throwIfAborted(signal);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.lmstudioApiKey) headers.Authorization = `Bearer ${config.lmstudioApiKey}`;

  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(`${config.lmstudioUrl}/chat/completions`, {
    method: 'POST',
    headers,
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    body: JSON.stringify({
      model: config.lmstudioModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: REFINE_SYSTEM_PROMPT },
        { role: 'user', content: buildRefineUserPrompt(text) },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`LMStudio refinement failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LMStudio returned an empty refinement');
  }
  logger.info(`LMStudio answered (${content.length} chars).`);
  return parseRefineResult(content);
}

/** Digs the socket error code (e.g. ECONNREFUSED, ENOTFOUND) out of a failed fetch. */
function connectionErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const cause = error.cause as { code?: string; errors?: Array<{ code?: string }> } | undefined;
  const code = cause?.code ?? cause?.errors?.[0]?.code;
  return code ? ` (${code})` : '';
}

/**
 * Polls the LMStudio server until its model list answers, mirroring the Whisper
 * readiness check. Refinement is only attempted once the server is reachable.
 */
export async function waitForLmStudio(
  config: Config,
  logger: Logger,
  signal?: AbortSignal,
  timeoutMs = 5 * 60 * 1000,
): Promise<void> {
  const startedAt = Date.now();
  const headers = config.lmstudioApiKey ? { Authorization: `Bearer ${config.lmstudioApiKey}` } : undefined;

  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(signal);
    try {
      const res = await fetch(`${config.lmstudioUrl}/models`, {
        headers,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
      const body = (await res.text()).slice(0, 300);
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `LMStudio rejected the request (${res.status}): ${body} — set LMSTUDIO_API_KEY in .env ` +
            `to the API token from LMStudio's Developer tab (or disable authentication there).`,
        );
      }
      throw new Error(`LMStudio answered with an unexpected status (${res.status}): ${body}`);
    } catch (error) {
      if (signal?.aborted) throw new OperationCancelledError();
      if (error instanceof Error && error.message.startsWith('LMStudio')) throw error;
      const detail = connectionErrorCode(error);
      logger.info(`Cannot reach LMStudio at ${config.lmstudioUrl}${detail}. Waiting for it to be ready...`);
    }
    await delay(10_000, signal);
  }

  throw new Error(
    `LMStudio server not ready at ${config.lmstudioUrl} after ${timeoutMs / 1000}s. ` +
      `If the error above is ECONNREFUSED, LMStudio is not accepting network connections: ` +
      `enable "Serve on Local Network" in the Developer tab (it must bind 0.0.0.0, not 127.0.0.1).`,
  );
}