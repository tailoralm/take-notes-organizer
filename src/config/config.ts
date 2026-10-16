export interface Config {
  inputFolder: string;
  outputFolder: string;
  whisperUrl: string;
  apiKey?: string;
  /** Sound level (dB) under which a region counts as silence, e.g. -35. */
  silenceThresholdDb: number;
  /** Internal silences longer than this many seconds are trimmed. */
  silenceTrimSeconds: number;
  /** BCP-47 language sent on every transcription request. */
  language: string;
  /** Target length of each chunk in seconds. */
  chunkLengthSeconds: number;
  /** Overlap between consecutive chunks in seconds. */
  chunkOverlapSeconds: number;
  /** Sampling temperature for the primary transcription attempts. */
  temperature: number;
  /** Chunk size in seconds used by the temperature retry. */
  smallChunkSeconds: number;
  /** Number of retries per chunk after a hallucination loop is flagged. */
  maxRetries: number;
  /** Sampling temperature used for the smaller-chunk retry. */
  retryTemperature: number;
  /** A chunk is flagged when the same segment text repeats this many times. */
  repeatLimit: number;
  /** A chunk is flagged when its gzip compression ratio exceeds this. */
  compressionRatioThreshold: number;
  /** Base URL of the LMStudio OpenAI-compatible server. */
  lmstudioUrl: string;
  /** Optional Bearer token for the LMStudio server. */
  lmstudioApiKey?: string;
  /** Id of the model loaded in LMStudio. */
  lmstudioModel: string;
}

/** Reads the whole pipeline configuration from the environment. */
export function loadConfig(): Config {
  const inputFolder = process.env.AUDIO_NOTES_FOLDER;
  const outputFolder = process.env.AUDIO_NOTES_OUTPUT_FOLDER;

  if (!inputFolder || !outputFolder) {
    throw new Error(
      'Missing required env vars AUDIO_NOTES_FOLDER or AUDIO_NOTES_OUTPUT_FOLDER. Copy .env.example to .env and fill it in.',
    );
  }

  return {
    inputFolder,
    outputFolder,
    whisperUrl: process.env.WHISPER_URL ?? 'http://127.0.0.1:9000',
    apiKey: process.env.WHISPER_API_KEY || undefined,
    silenceThresholdDb: numEnv('WHISPER_SILENCE_THRESHOLD_DB', -35),
    silenceTrimSeconds: numEnv('WHISPER_SILENCE_TRIM_SECONDS', 2),
    language: process.env.WHISPER_LANGUAGE ?? 'pt',
    chunkLengthSeconds: numEnv('WHISPER_CHUNK_SECONDS', 300),
    chunkOverlapSeconds: numEnv('WHISPER_CHUNK_OVERLAP_SECONDS', 1),
    temperature: numEnv('WHISPER_TEMPERATURE', 0),
    smallChunkSeconds: numEnv('WHISPER_SMALL_CHUNK_SECONDS', 120),
    maxRetries: numEnv('WHISPER_MAX_RETRIES', 2),
    retryTemperature: numEnv('WHISPER_RETRY_TEMPERATURE', 0.2),
    repeatLimit: numEnv('WHISPER_REPEAT_LIMIT', 3),
    compressionRatioThreshold: numEnv('WHISPER_COMPRESSION_RATIO', 2.4),
    lmstudioUrl: process.env.LMSTUDIO_URL ?? 'http://127.0.0.1:1234/v1',
    lmstudioApiKey: process.env.LMSTUDIO_API_KEY || undefined,
    lmstudioModel: process.env.LMSTUDIO_MODEL ?? 'local-model',
  };
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
