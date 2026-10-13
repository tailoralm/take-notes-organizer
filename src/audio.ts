import { execFile } from 'node:child_process';

export interface Silence {
  start: number;
  end: number;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`ffmpeg command failed: ${stderr.toString().trim() || error.message}`));
        return;
      }
      const stderrText = stderr.toString();
      resolve(stdout.toString() + (stderrText.length ? `\n${stderrText}` : ''));
    });
  });
}

/**
 * ffmpeg filter chain that trimms long silences: trims leading silence and
 * caps any internal silence longer than trimSeconds down to ~0.8s, so quiet
 * stretches (where Whisper tends to hallucinate) are shortened while a little
 * silence remains as a natural chunk boundary.
 */
export function silenceFilter(thresholdDb: number, trimSeconds: number): string {
  const db = `${thresholdDb}dB`;
  return (
    'silenceremove=' +
    `start_periods=1:start_duration=0.4:start_threshold=${db},` +
    `stop_periods=-1:stop_duration=${trimSeconds}:stop_threshold=${db}:stop_silence=0.8`
  );
}

/** Convert any input to a 16 kHz mono PCM WAV, trimming long silences. */
export async function convertToWav(
  inputPath: string,
  outputPath: string,
  thresholdDb: number,
  trimSeconds: number,
): Promise<void> {
  await run('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-af',
    silenceFilter(thresholdDb, trimSeconds),
    outputPath,
  ]);
}

/** Extract the [start, end) slice of a WAV into its own WAV file. */
export async function extractWav(srcWav: string, outWav: string, start: number, end: number): Promise<void> {
  await run('ffmpeg', ['-y', '-ss', String(start), '-i', srcWav, '-t', String(end - start), '-c', 'copy', outWav]);
}

/** Duration of an audio file in seconds. */
export async function getDuration(wavPath: string): Promise<number> {
  const output = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wavPath]);
  const seconds = Number(output.split('\n')[0].trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Could not read duration of ${wavPath}`);
  }
  return seconds;
}

/** Silence regions (seconds) longer than minDuration, parsed from silencedetect output. */
export async function detectSilence(wavPath: string, thresholdDb: number, minDuration: number): Promise<Silence[]> {
  const output = await run('ffmpeg', [
    '-i',
    wavPath,
    '-vn',
    '-af',
    `silencedetect=noise=${thresholdDb}dB:d=${minDuration}`,
    '-f',
    'null',
    '-',
  ]);
  const silences: Silence[] = [];
  const regex = /silence_(start|end):\s*(-?[\d.]+)/g;
  let pendingStart: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    const value = Number(match[2]);
    if (match[1] === 'start') {
      pendingStart = value;
    } else if (pendingStart !== null) {
      if (value - pendingStart >= minDuration) {
        silences.push({ start: pendingStart, end: value });
      }
      pendingStart = null;
    }
  }
  return silences;
}