import type { AudioCue } from "@/lib/schemas/audio";
import type { FinalCutPlan } from "@/lib/schemas/assembly";

/**
 * Audio cue timeline resolution and the ffmpeg mix filter graph.
 *
 * Cues are authored relative to an anchor scene, then resolved here to absolute
 * offsets on the assembled cut. Everything in this module is pure so the timing
 * maths and the filter string are testable without ffmpeg.
 */

export type ResolvedCue = {
  cue: AudioCue;
  path: string;
  /** Absolute offset on the assembled timeline. */
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
};

/** Start offset of every scene on the assembled timeline. */
export function sceneStartOffsets(plan: FinalCutPlan): Map<string, number> {
  const offsets = new Map<string, number>();
  let cursor = 0;
  for (const clip of plan.clips) {
    offsets.set(clip.sceneId, cursor);
    cursor += clip.durationSeconds;
  }
  return offsets;
}

export function timelineDuration(plan: FinalCutPlan): number {
  return plan.clips.reduce((sum, clip) => sum + clip.durationSeconds, 0);
}

/** dB to linear amplitude. -60 dB and below is treated as silence. */
export function dbToAmplitude(db: number): number {
  if (db <= -60) return 0;
  return Number(Math.pow(10, db / 20).toFixed(6));
}

/**
 * Resolve authored cues to absolute timeline positions.
 *
 * Cues are skipped when they have no generated audio, are unapproved, anchor to
 * a scene that is not in the cut, or start past the end of the timeline. A cue
 * that overruns the end is clamped rather than dropped.
 */
export function resolveCueTimeline(plan: FinalCutPlan, cues: AudioCue[]): ResolvedCue[] {
  const offsets = sceneStartOffsets(plan);
  const total = timelineDuration(plan);
  const resolved: ResolvedCue[] = [];

  for (const cue of cues) {
    if (!cue.generatedPath || !cue.approved) continue;
    const sceneStart = offsets.get(cue.sceneId);
    if (sceneStart === undefined) continue;

    const startSeconds = sceneStart + cue.startSeconds;
    if (startSeconds >= total) continue;

    const durationSeconds = Math.min(cue.durationSeconds, total - startSeconds);
    if (durationSeconds <= 0) continue;

    // Fades must fit inside the (possibly clamped) cue.
    const fadeInSeconds = Math.min(cue.fadeInSeconds, durationSeconds / 2);
    const fadeOutSeconds = Math.min(cue.fadeOutSeconds, durationSeconds / 2);

    resolved.push({
      cue,
      path: cue.generatedPath,
      startSeconds: round(startSeconds),
      endSeconds: round(startSeconds + durationSeconds),
      durationSeconds: round(durationSeconds),
      fadeInSeconds: round(fadeInSeconds),
      fadeOutSeconds: round(fadeOutSeconds),
    });
  }

  return resolved.sort((a, b) => a.startSeconds - b.startSeconds);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export type AudioMixOptions = {
  sampleRate: number;
  channelLayout: string;
  codec: string;
  bitrate: string;
};

export type AudioMixInputs = {
  /** Whether the assembled video already carries an audio track. */
  hasNativeAudio: boolean;
  /** Timeline length, used to size the silent base when there is no native audio. */
  timelineSeconds: number;
};

/**
 * Build the `-filter_complex` graph for laying cues over the cut.
 *
 * Native audio is attenuated only inside each cue's window using `volume`'s
 * timeline `enable` expression, so ducking is deterministic rather than
 * signal-dependent. Each cue is format-normalized, padded/trimmed to its exact
 * length, delayed into position, gained, and faded. `amix` runs with
 * `normalize=0` so summing does not silently drop the overall level.
 */
export function buildAudioMixFilter(
  cues: ResolvedCue[],
  nativeLabel: string,
  cueInputIndexes: number[],
  options: AudioMixOptions,
): string {
  const format = `aformat=sample_fmts=fltp:sample_rates=${options.sampleRate}:channel_layouts=${options.channelLayout}`;

  const ducks = cues
    .filter((c) => c.cue.duckNativeDb < 0)
    .map(
      (c) =>
        `volume=enable='between(t,${c.startSeconds},${c.endSeconds})':volume=${dbToAmplitude(c.cue.duckNativeDb)}`,
    );
  const nativeChain = `[${nativeLabel}]${[...ducks, format].join(",")}[na]`;

  const cueChains = cues.map((c, i) => {
    const delayMs = Math.round(c.startSeconds * 1000);
    const parts = [
      format,
      "apad",
      `atrim=0:${c.durationSeconds}`,
      "asetpts=PTS-STARTPTS",
      `adelay=${delayMs}|${delayMs}`,
      `volume=${dbToAmplitude(c.cue.gainDb)}`,
    ];
    if (c.fadeInSeconds > 0) {
      parts.push(`afade=t=in:st=${c.startSeconds}:d=${c.fadeInSeconds}`);
    }
    if (c.fadeOutSeconds > 0) {
      parts.push(`afade=t=out:st=${round(c.endSeconds - c.fadeOutSeconds)}:d=${c.fadeOutSeconds}`);
    }
    return `[${cueInputIndexes[i]}:a]${parts.join(",")}[c${i}]`;
  });

  const mixLabels = ["[na]", ...cues.map((_, i) => `[c${i}]`)].join("");
  const mix = `${mixLabels}amix=inputs=${cues.length + 1}:normalize=0:duration=first[outa]`;

  return [nativeChain, ...cueChains, mix].join(";");
}

/**
 * Full ffmpeg argument list for the mix pass.
 *
 * Video is stream-copied, so iterating on music never re-encodes picture.
 */
export function buildAudioMixArgs(
  videoPath: string,
  cues: ResolvedCue[],
  output: string,
  inputs: AudioMixInputs,
  options: AudioMixOptions,
): string[] {
  if (!cues.length) throw new Error("No audio cues to mix");

  const args: string[] = ["-y", "-i", videoPath];
  let nativeLabel = "0:a";
  let nextIndex = 1;

  if (!inputs.hasNativeAudio) {
    // No native track: synthesize a silent bed of the right length so the mix
    // graph has a base to lay cues over.
    args.push(
      "-f",
      "lavfi",
      "-t",
      String(inputs.timelineSeconds),
      "-i",
      `anullsrc=channel_layout=${options.channelLayout}:sample_rate=${options.sampleRate}`,
    );
    nativeLabel = "1:a";
    nextIndex = 2;
  }

  const cueInputIndexes: number[] = [];
  for (const cue of cues) {
    args.push("-i", cue.path);
    cueInputIndexes.push(nextIndex);
    nextIndex += 1;
  }

  args.push(
    "-filter_complex",
    buildAudioMixFilter(cues, nativeLabel, cueInputIndexes, options),
    "-map",
    "0:v",
    "-map",
    "[outa]",
    "-c:v",
    "copy",
    "-c:a",
    options.codec,
    "-b:a",
    options.bitrate,
    "-ar",
    String(options.sampleRate),
    "-movflags",
    "+faststart",
    output,
  );

  return args;
}
