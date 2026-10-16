import type { Config } from '../config/config';
import { delay, OperationCancelledError, throwIfAborted } from '../core/cancellation';
import type { Logger } from '../core/logger';
import type { RefineResult } from '../domain/refinement';
import { buildRefineUserPrompt, REFINE_SYSTEM_PROMPT } from '../prompts/refine-prompt';

/** Upper bound for one chat completion, so a stalled server cannot hold the run lock forever. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Penalty applied only on the retry after a degenerate (repetition-loop) or
 * truncated answer. The first attempt runs without it to keep the text faithful.
 */
const REPETITION_PENALTY = 0.4;

/**
 * Extracts the first complete JSON object from a model answer. Tolerates a
 * ```json fence, leading prose and trailing junk: it finds the opening brace and
 * scans to its matching close, ignoring braces that appear inside strings.
 */
function extractJsonObject(content: string): unknown {
  let text = content.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();

  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in the model answer');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('Unterminated JSON object in the model answer');
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

/** The strict JSON schema the model must answer with. */
const REFINE_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'refinement',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        resume: { type: 'string' },
        refinedText: { type: 'string' },
      },
      required: ['title', 'tags', 'resume', 'refinedText'],
      additionalProperties: false,
    },
  },
} as const;

interface CompletionResult {
  content: string;
  finishReason: string | undefined;
}

/**
 * One chat-completion call to LMStudio. `frequencyPenalty` is only non-zero on
 * the retry, to break a repetition loop that would otherwise truncate the answer.
 */
async function requestRefinement(
  config: Config,
  logger: Logger,
  text: string,
  frequencyPenalty: number,
  signal?: AbortSignal,
): Promise<CompletionResult> {
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
      frequency_penalty: frequencyPenalty,
      response_format: REFINE_RESPONSE_FORMAT,
      messages: [
        { role: 'system', content: REFINE_SYSTEM_PROMPT },
        { role: 'user', content: buildRefineUserPrompt(text) },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`LMStudio refinement failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    throw new Error('LMStudio returned an empty refinement');
  }
  logger.info(`LMStudio answered (${content.length} chars, finish_reason=${choice?.finish_reason ?? 'unknown'}).`);
  return { content, finishReason: choice?.finish_reason };
}

/**
 * Refines one transcription through LMStudio's OpenAI-compatible chat API and
 * returns the parsed refinement. Throws on transport or JSON errors so the
 * caller can leave the entry un-refined and retry it on the next run.
 *
 * The first attempt is faithful (no repetition penalty). If the answer is
 * truncated mid-JSON or unparsable — usually a local model looping and hitting
 * its context limit — it retries once with a repetition penalty.
 */
export async function refineText(
  config: Config,
  logger: Logger,
  text: string,
  signal?: AbortSignal,
): Promise<RefineResult> {
  throwIfAborted(signal);

  const first = await requestRefinement(config, logger, text, 0, signal);
  try {
    return parseRefineResult(first.content);
  } catch (error) {
    if (first.finishReason === 'length') {
      logger.warn('LMStudio hit its context limit and the answer was cut off; retrying with a repetition penalty.');
    } else {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(`Could not parse the refinement (${reason}); retrying with a repetition penalty.`);
    }
  }

  const retry = await requestRefinement(config, logger, text, REPETITION_PENALTY, signal);
  try {
    return parseRefineResult(retry.content);
  } catch (error) {
    if (retry.finishReason === 'length') {
      throw new Error(
        "LMStudio's answer was cut off (finish_reason=length): the model's context length is too small for " +
          'this note. Increase the context length when loading the model in LMStudio (My Models → the model → ' +
          'Context Length), then retry.',
      );
    }
    throw error;
  }
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