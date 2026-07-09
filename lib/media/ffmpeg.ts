/**
 * ffmpeg command/argument builders (pure) plus a runner interface with a mock
 * implementation for demo/local mode. A native runner (child_process) would be
 * selected when real clips exist; the MVP ships the mock so assembly is testable
 * without ffmpeg or generated media (spec Section 17).
 */

/** Build the content of an ffmpeg concat demuxer list file. */
export function buildConcatListFile(clips: string[]): string {
  return clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

/** ffmpeg args for a copy-concat: `ffmpeg -f concat -safe 0 -i list -c copy out`. */
export function buildConcatArgs(listPath: string, output: string): string[] {
  return ["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", output];
}

/** ffmpeg args to trim a clip to a fixed duration. */
export function buildTrimArgs(input: string, output: string, durationSeconds: number): string[] {
  return ["-i", input, "-t", String(durationSeconds), "-c", "copy", output];
}

export interface FfmpegRunner {
  readonly mode: "mock" | "native";
  concat(clips: string[], output: string): Promise<string>;
}

/** Mock runner: records the intended command and returns the output path. */
export class MockFfmpegRunner implements FfmpegRunner {
  readonly mode = "mock" as const;
  lastArgs: string[] = [];

  async concat(clips: string[], output: string): Promise<string> {
    this.lastArgs = buildConcatArgs("clips.txt", output);
    void buildConcatListFile(clips);
    return output;
  }
}

const globalRef = globalThis as unknown as { __storyforgeFfmpeg?: FfmpegRunner };

export function getFfmpegRunner(): FfmpegRunner {
  if (globalRef.__storyforgeFfmpeg) return globalRef.__storyforgeFfmpeg;
  const runner = new MockFfmpegRunner();
  globalRef.__storyforgeFfmpeg = runner;
  return runner;
}
