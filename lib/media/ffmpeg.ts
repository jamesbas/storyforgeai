import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { buildAudioMixArgs, type ResolvedCue } from "@/lib/media/audio-mix";

/**
 * ffmpeg command builders (pure), plus a runner interface with a mock and a
 * native subprocess implementation.
 *
 * The native runner concatenates through a filter graph rather than the concat
 * demuxer, because WanGP clips across scenes routinely differ in resolution,
 * frame rate, and pixel format — a stream-copy concat would either fail or
 * produce a broken file. The filter graph also applies each clip's planned trim
 * in the same pass (spec Section 17).
 */

export type FfmpegClip = {
  path: string;
  durationSeconds?: number;
  /** Whether the source carries an audio stream (LTX-2 clips do). */
  hasAudio?: boolean;
};
export type ClipInput = string | FfmpegClip;

export function normalizeClips(clips: ClipInput[]): FfmpegClip[] {
  return clips.map((clip) => (typeof clip === "string" ? { path: clip } : clip));
}

/** Build the content of an ffmpeg concat demuxer list file. */
export function buildConcatListFile(clips: ClipInput[]): string {
  return (
    normalizeClips(clips)
      .map((c) => `file '${c.path.replace(/'/g, "'\\''")}'`)
      .join("\n") + "\n"
  );
}

/** ffmpeg args for a copy-concat: `ffmpeg -f concat -safe 0 -i list -c copy out`. */
export function buildConcatArgs(listPath: string, output: string): string[] {
  return ["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", output];
}

/** ffmpeg args to trim a clip to a fixed duration. */
export function buildTrimArgs(input: string, output: string, durationSeconds: number): string[] {
  return ["-i", input, "-t", String(durationSeconds), "-c", "copy", output];
}

export function parseResolution(resolution: string): [number, number] {
  const match = /^(\d+)x(\d+)$/.exec(resolution.trim());
  if (!match) return [1280, 720];
  return [Number(match[1]), Number(match[2])];
}

export type FilterConcatOptions = {
  width: number;
  height: number;
  fps: number;
  crf: number;
  preset: string;
  audioSampleRate: number;
  audioChannelLayout: string;
  audioCodec: string;
  audioBitrate: string;
};

/**
 * Build a filter-graph concat that normalizes every clip to a common
 * resolution/fps and trims it to its planned duration.
 *
 * Audio: WanGP's LTX-2 models emit a real audio track alongside the video, so
 * the graph carries audio through whenever any clip has it. Clips without audio
 * get an `anullsrc` silence input of matching length, because the concat filter
 * requires every segment to expose the same set of streams. When no clip has
 * audio the output stays video-only.
 */
export function buildFilterConcatArgs(
  clips: FfmpegClip[],
  output: string,
  options: FilterConcatOptions,
): string[] {
  if (!clips.length) throw new Error("No clips to assemble");
  const { width, height, fps, crf, preset } = options;
  const { audioSampleRate, audioChannelLayout, audioCodec, audioBitrate } = options;

  const includeAudio = clips.some((clip) => clip.hasAudio);

  const inputs: string[] = [];
  for (const clip of clips) inputs.push("-i", clip.path);

  // Silence inputs are appended after all real inputs so clip indices stay stable.
  const silenceInputIndex = new Map<number, number>();
  if (includeAudio) {
    let nextIndex = clips.length;
    clips.forEach((clip, index) => {
      if (clip.hasAudio) return;
      if (clip.durationSeconds === undefined) {
        throw new Error(
          `Clip ${clip.path} has no audio and no known duration, so silence cannot be generated.`,
        );
      }
      inputs.push(
        "-f",
        "lavfi",
        "-t",
        String(clip.durationSeconds),
        "-i",
        `anullsrc=channel_layout=${audioChannelLayout}:sample_rate=${audioSampleRate}`,
      );
      silenceInputIndex.set(index, nextIndex);
      nextIndex += 1;
    });
  }

  const audioFormat = `aformat=sample_fmts=fltp:sample_rates=${audioSampleRate}:channel_layouts=${audioChannelLayout}`;

  const chains = clips.flatMap((clip, index) => {
    const videoTrim = clip.durationSeconds ? `trim=0:${clip.durationSeconds},` : "";
    const video =
      `[${index}:v]${videoTrim}setpts=PTS-STARTPTS,` +
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:-1:-1:color=black,setsar=1,fps=${fps}[v${index}]`;
    if (!includeAudio) return [video];

    const audioInput = clip.hasAudio ? `${index}:a` : `${silenceInputIndex.get(index)}:a`;
    // apad before atrim guarantees the audio is exactly as long as the video,
    // even when the source audio runs short of its planned duration.
    const audioTrim = clip.durationSeconds
      ? `apad,atrim=0:${clip.durationSeconds},`
      : "";
    const audio = `[${audioInput}]${audioTrim}asetpts=PTS-STARTPTS,${audioFormat}[a${index}]`;
    return [video, audio];
  });

  const concatInputs = clips
    .map((_, index) => (includeAudio ? `[v${index}][a${index}]` : `[v${index}]`))
    .join("");
  const concatOutputs = includeAudio ? "[outv][outa]" : "[outv]";
  const filter =
    `${chains.join(";")};${concatInputs}` +
    `concat=n=${clips.length}:v=1:a=${includeAudio ? 1 : 0}${concatOutputs}`;

  return [
    "-y",
    ...inputs,
    "-filter_complex",
    filter,
    "-map",
    "[outv]",
    ...(includeAudio ? ["-map", "[outa]"] : []),
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    ...(includeAudio
      ? ["-c:a", audioCodec, "-b:a", audioBitrate, "-ar", String(audioSampleRate)]
      : []),
    "-movflags",
    "+faststart",
    output,
  ];
}

export interface FfmpegRunner {
  readonly mode: "mock" | "native";
  concat(clips: ClipInput[], output: string): Promise<string>;
  /** Lay generated music/SFX cues over an assembled cut. */
  mixAudio(videoPath: string, cues: ResolvedCue[], output: string): Promise<string>;
}

/** Mock runner: records the intended command and returns the output path. */
export class MockFfmpegRunner implements FfmpegRunner {
  readonly mode = "mock" as const;
  lastArgs: string[] = [];

  async concat(clips: ClipInput[], output: string): Promise<string> {
    this.lastArgs = buildConcatArgs("clips.txt", output);
    void buildConcatListFile(clips);
    return output;
  }

  async mixAudio(_videoPath: string, _cues: ResolvedCue[], output: string): Promise<string> {
    return output;
  }
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Run a binary to completion, capturing stderr for diagnostics. */
export function runProcess(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // `shell: false` (the default) passes args to the OS directly, so clip
    // paths can never be interpreted as shell metacharacters.
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new FfmpegError(`${bin} timed out after ${timeoutMs}ms`, null, stderr));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      // ffmpeg is chatty; keep only the tail for error reporting.
      stderr = (stderr + String(chunk)).slice(-8000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new FfmpegError(`${bin} could not be started: ${err.message}`, null, stderr));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Native runner backed by the ffmpeg binary on PATH (or FFMPEG_PATH). */
export class NativeFfmpegRunner implements FfmpegRunner {
  readonly mode = "native" as const;

  constructor(
    private readonly bin = config.ffmpeg.path,
    private readonly timeoutMs = config.ffmpeg.timeoutMs,
  ) {}

  async concat(clips: ClipInput[], output: string): Promise<string> {
    const normalized = normalizeClips(clips);
    if (!normalized.length) throw new Error("No clips to assemble");

    for (const clip of normalized) {
      await fs.access(clip.path).catch(() => {
        throw new Error(`Clip is missing on disk: ${clip.path}`);
      });
    }

    // Probe each clip so the graph knows which sources carry audio, and so a
    // planned duration never exceeds what the source actually contains
    // (over-trimming would freeze the last frame).
    const probed = await Promise.all(
      normalized.map(async (clip) => {
        const probe = await probeMedia(clip.path);
        if (!probe) return clip;
        const planned = clip.durationSeconds;
        const actual = probe.durationSeconds ?? undefined;
        const durationSeconds =
          planned !== undefined && actual !== undefined
            ? Math.min(planned, Math.floor(actual * 100) / 100)
            : (planned ?? actual);
        return {
          ...clip,
          hasAudio: clip.hasAudio ?? probe.hasAudio,
          ...(durationSeconds === undefined ? {} : { durationSeconds }),
        };
      }),
    );

    await fs.mkdir(path.dirname(output), { recursive: true });

    const [width, height] = parseResolution(config.defaults.resolution);
    const args = buildFilterConcatArgs(probed, output, {
      width,
      height,
      fps: config.defaults.fps,
      crf: config.ffmpeg.crf,
      preset: config.ffmpeg.preset,
      audioSampleRate: config.ffmpeg.audioSampleRate,
      audioChannelLayout: config.ffmpeg.audioChannelLayout,
      audioCodec: config.ffmpeg.audioCodec,
      audioBitrate: config.ffmpeg.audioBitrate,
    });

    const result = await runProcess(this.bin, args, this.timeoutMs);
    if (result.code !== 0) {
      throw new FfmpegError(
        `ffmpeg concat failed with exit code ${result.code}`,
        result.code,
        result.stderr,
      );
    }
    return output;
  }

  /**
   * Lay generated cues over an assembled cut.
   *
   * The video stream is copied, so re-mixing music is cheap. When the cut has
   * no audio at all (every clip silent), a silent bed is synthesized so cues
   * still have somewhere to land.
   */
  async mixAudio(videoPath: string, cues: ResolvedCue[], output: string): Promise<string> {
    if (!cues.length) throw new Error("No audio cues to mix");

    for (const cue of cues) {
      await fs.access(cue.path).catch(() => {
        throw new Error(`Cue audio is missing on disk: ${cue.path}`);
      });
    }

    const probe = await probeMedia(videoPath);
    const timelineSeconds =
      probe?.durationSeconds ?? Math.max(...cues.map((c) => c.endSeconds), 1);

    await fs.mkdir(path.dirname(output), { recursive: true });

    const args = buildAudioMixArgs(
      videoPath,
      cues,
      output,
      { hasNativeAudio: probe?.hasAudio ?? false, timelineSeconds },
      {
        sampleRate: config.ffmpeg.audioSampleRate,
        channelLayout: config.ffmpeg.audioChannelLayout,
        codec: config.ffmpeg.audioCodec,
        bitrate: config.ffmpeg.audioBitrate,
      },
    );

    const result = await runProcess(this.bin, args, this.timeoutMs);
    if (result.code !== 0) {
      throw new FfmpegError(
        `ffmpeg audio mix failed with exit code ${result.code}`,
        result.code,
        result.stderr,
      );
    }
    return output;
  }

  /**
   * Trim a rendered file to a fixed runtime. Used for platform derivatives and
   * any post-assembly correction; the main concat already applies scene trims.
   * Copies both streams, so audio survives.
   */
  async trim(input: string, output: string, durationSeconds: number): Promise<string> {
    await fs.mkdir(path.dirname(output), { recursive: true });
    const result = await runProcess(
      this.bin,
      [
        "-y",
        "-i",
        input,
        "-t",
        String(durationSeconds),
        "-map",
        "0",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        output,
      ],
      this.timeoutMs,
    );
    if (result.code !== 0) {
      throw new FfmpegError(
        `ffmpeg trim failed with exit code ${result.code}`,
        result.code,
        result.stderr,
      );
    }
    return output;
  }
}

export type MediaProbe = {
  durationSeconds: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
};

/** Inspect a media file's duration and stream layout via ffprobe. */
export async function probeMedia(filePath: string): Promise<MediaProbe | null> {
  try {
    const result = await runProcess(
      config.ffmpeg.probePath,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      60_000,
    );
    if (result.code !== 0) return null;

    const parsed = JSON.parse(result.stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string }[];
    };
    const duration = Number(parsed.format?.duration);
    const streams = parsed.streams ?? [];
    return {
      durationSeconds: Number.isFinite(duration) ? duration : null,
      hasAudio: streams.some((s) => s.codec_type === "audio"),
      hasVideo: streams.some((s) => s.codec_type === "video"),
    };
  } catch {
    return null;
  }
}

/** Read a media file's duration in seconds via ffprobe. Null when unavailable. */
export async function probeDurationSeconds(filePath: string): Promise<number | null> {
  return (await probeMedia(filePath))?.durationSeconds ?? null;
}

/** Temp path for scratch files (concat lists, intermediate cuts). */
export function tempPath(suffix: string): string {
  return path.join(os.tmpdir(), `storyforge-${randomUUID()}${suffix}`);
}

const globalRef = globalThis as unknown as { __storyforgeFfmpeg?: FfmpegRunner };

export function getFfmpegRunner(): FfmpegRunner {
  if (globalRef.__storyforgeFfmpeg) return globalRef.__storyforgeFfmpeg;
  const runner: FfmpegRunner = config.flags.ffmpeg
    ? new NativeFfmpegRunner()
    : new MockFfmpegRunner();
  globalRef.__storyforgeFfmpeg = runner;
  return runner;
}

/** Override the process-wide runner (tests, or a swap after a config change). */
export function setFfmpegRunner(runner?: FfmpegRunner): void {
  globalRef.__storyforgeFfmpeg = runner;
}
