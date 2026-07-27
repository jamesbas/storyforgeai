import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  buildAudioMixArgs,
  buildAudioMixFilter,
  dbToAmplitude,
  resolveCueTimeline,
  sceneStartOffsets,
  timelineDuration,
  type ResolvedCue,
} from "@/lib/media/audio-mix";
import { NativeFfmpegRunner, probeMedia, runProcess } from "@/lib/media/ffmpeg";
import type { FinalCutPlan } from "@/lib/schemas/assembly";
import type { AudioCue } from "@/lib/schemas/audio";

const plan: FinalCutPlan = {
  projectId: "p1",
  clips: [
    { sceneId: "s1", sceneNumber: 1, path: "a.mp4", durationSeconds: 20, transitionIn: "cut", transitionOut: "cut" },
    { sceneId: "s2", sceneNumber: 2, path: "b.mp4", durationSeconds: 20, transitionIn: "cut", transitionOut: "cut" },
    { sceneId: "s3", sceneNumber: 3, path: "c.mp4", durationSeconds: 10, transitionIn: "cut", transitionOut: "cut" },
  ],
  totalDurationSeconds: 50,
  finalTrimSeconds: 10,
};

function cue(overrides: Partial<AudioCue> = {}): AudioCue {
  return {
    id: "cue-1",
    sceneId: "s2",
    kind: "music",
    prompt: "moody underscore",
    startSeconds: 5,
    durationSeconds: 10,
    gainDb: -8,
    fadeInSeconds: 1,
    fadeOutSeconds: 1.5,
    duckNativeDb: -12,
    generatedPath: "music.wav",
    approved: true,
    ...overrides,
  };
}

describe("cue timeline resolution", () => {
  it("computes scene start offsets and total duration", () => {
    expect([...sceneStartOffsets(plan).entries()]).toEqual([
      ["s1", 0],
      ["s2", 20],
      ["s3", 40],
    ]);
    expect(timelineDuration(plan)).toBe(50);
  });

  it("anchors a cue to its scene and resolves an absolute offset", () => {
    const [resolved] = resolveCueTimeline(plan, [cue()]);
    // scene 2 starts at 20s, cue starts 5s into it.
    expect(resolved!.startSeconds).toBe(25);
    expect(resolved!.endSeconds).toBe(35);
  });

  it("skips cues that are ungenerated, unapproved, or orphaned", () => {
    expect(resolveCueTimeline(plan, [cue({ generatedPath: undefined })])).toHaveLength(0);
    expect(resolveCueTimeline(plan, [cue({ approved: false })])).toHaveLength(0);
    expect(resolveCueTimeline(plan, [cue({ sceneId: "deleted-scene" })])).toHaveLength(0);
  });

  it("clamps a cue that overruns the end of the timeline", () => {
    const [resolved] = resolveCueTimeline(plan, [
      cue({ sceneId: "s3", startSeconds: 5, durationSeconds: 30 }),
    ]);
    // s3 starts at 40s, cue at 45s, timeline ends at 50s -> 5s not 30s.
    expect(resolved!.startSeconds).toBe(45);
    expect(resolved!.durationSeconds).toBe(5);
    expect(resolved!.endSeconds).toBe(50);
  });

  it("shrinks fades so they fit a clamped cue", () => {
    const [resolved] = resolveCueTimeline(plan, [
      cue({ sceneId: "s3", startSeconds: 9, durationSeconds: 30, fadeInSeconds: 5, fadeOutSeconds: 5 }),
    ]);
    expect(resolved!.durationSeconds).toBe(1);
    expect(resolved!.fadeInSeconds).toBeLessThanOrEqual(0.5);
    expect(resolved!.fadeOutSeconds).toBeLessThanOrEqual(0.5);
  });

  it("drops a cue that starts past the end of the timeline", () => {
    expect(resolveCueTimeline(plan, [cue({ sceneId: "s3", startSeconds: 15 })])).toHaveLength(0);
  });

  it("orders cues by absolute start", () => {
    const resolved = resolveCueTimeline(plan, [
      cue({ id: "late", sceneId: "s3", startSeconds: 1 }),
      cue({ id: "early", sceneId: "s1", startSeconds: 1 }),
    ]);
    expect(resolved.map((r) => r.cue.id)).toEqual(["early", "late"]);
  });

  it("survives a re-trimmed upstream scene by re-resolving, not breaking", () => {
    const shortened: FinalCutPlan = {
      ...plan,
      clips: [{ ...plan.clips[0]!, durationSeconds: 12 }, plan.clips[1]!, plan.clips[2]!],
    };
    const [resolved] = resolveCueTimeline(shortened, [cue()]);
    // Anchor is scene-relative, so the cue simply moves with its scene.
    expect(resolved!.startSeconds).toBe(17);
  });
});

describe("dbToAmplitude", () => {
  it("converts common levels", () => {
    expect(dbToAmplitude(0)).toBe(1);
    expect(dbToAmplitude(-6)).toBeCloseTo(0.501, 3);
    expect(dbToAmplitude(-12)).toBeCloseTo(0.251, 3);
  });

  it("treats -60 dB and below as silence, giving a true replace", () => {
    expect(dbToAmplitude(-60)).toBe(0);
    expect(dbToAmplitude(-90)).toBe(0);
  });
});

const mixOptions = {
  sampleRate: 48000,
  channelLayout: "stereo",
  codec: "aac",
  bitrate: "192k",
};

describe("audio mix filter graph", () => {
  const resolved = (cues: AudioCue[]) => resolveCueTimeline(plan, cues);

  it("ducks the native track only inside the cue window", () => {
    const filter = buildAudioMixFilter(resolved([cue()]), "0:a", [1], mixOptions);
    expect(filter).toContain("volume=enable='between(t,25,35)':volume=0.251");
    expect(filter).toContain("[na]");
  });

  it("does not touch the native track for an additive SFX cue", () => {
    const filter = buildAudioMixFilter(
      resolved([cue({ kind: "sfx", duckNativeDb: 0 })]),
      "0:a",
      [1],
      mixOptions,
    );
    expect(filter).not.toContain("enable=");
  });

  it("delays, gains, and fades each cue into position", () => {
    const filter = buildAudioMixFilter(resolved([cue()]), "0:a", [1], mixOptions);
    expect(filter).toContain("adelay=25000|25000");
    expect(filter).toContain("atrim=0:10");
    expect(filter).toContain("afade=t=in:st=25:d=1");
    expect(filter).toContain("afade=t=out:st=33.5:d=1.5");
    expect(filter).toContain("aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo");
  });

  it("sums without auto-normalizing, and ends with the video length", () => {
    const filter = buildAudioMixFilter(resolved([cue()]), "0:a", [1], mixOptions);
    expect(filter).toContain("amix=inputs=2:normalize=0:duration=first[outa]");
  });

  it("chains multiple ducks and mixes every cue", () => {
    const filter = buildAudioMixFilter(
      resolved([cue({ id: "a", sceneId: "s1", startSeconds: 2 }), cue({ id: "b", sceneId: "s3", startSeconds: 1 })]),
      "0:a",
      [1, 2],
      mixOptions,
    );
    expect(filter.match(/enable='between/g)).toHaveLength(2);
    expect(filter).toContain("[na][c0][c1]amix=inputs=3");
  });
});

describe("audio mix args", () => {
  it("copies video and re-encodes only audio", () => {
    const args = buildAudioMixArgs(
      "cut.mp4",
      resolveCueTimeline(plan, [cue()]),
      "final.mp4",
      { hasNativeAudio: true, timelineSeconds: 50 },
      mixOptions,
    );
    expect(args).toContain("-c:v");
    expect(args[args.indexOf("-c:v") + 1]).toBe("copy");
    expect(args).toContain("aac");
    expect(args.at(-1)).toBe("final.mp4");
  });

  it("synthesizes a silent bed when the cut has no audio at all", () => {
    const args = buildAudioMixArgs(
      "cut.mp4",
      resolveCueTimeline(plan, [cue()]),
      "final.mp4",
      { hasNativeAudio: false, timelineSeconds: 50 },
      mixOptions,
    );
    expect(args).toContain("anullsrc=channel_layout=stereo:sample_rate=48000");
    // Silence occupies input 1, so the cue shifts to input 2.
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("[1:a]");
    expect(filter).toContain("[2:a]");
  });

  it("refuses to run with no cues", () => {
    expect(() =>
      buildAudioMixArgs("cut.mp4", [], "final.mp4", { hasNativeAudio: true, timelineSeconds: 10 }, mixOptions),
    ).toThrow(/No audio cues/);
  });
});

const hasFfmpeg = await runProcess("ffmpeg", ["-version"], 15_000)
  .then((r) => r.code === 0)
  .catch(() => false);

/** Measure mean dB in a frequency band over a time window. */
async function bandDb(file: string, start: number, duration: number, freq: number) {
  const result = await runProcess(
    "ffmpeg",
    [
      "-hide_banner",
      "-ss",
      String(start),
      "-t",
      String(duration),
      "-i",
      file,
      "-af",
      `bandpass=f=${freq}:width_type=h:w=60,volumedetect`,
      "-f",
      "null",
      "-",
    ],
    60_000,
  );
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(result.stderr);
  return match ? Number(match[1]) : Number.NaN;
}

describe.skipIf(!hasFfmpeg)("audio mix (integration)", () => {
  let dir: string;
  let cutPath: string;
  let musicPath: string;
  let silentCutPath: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyforge-mix-"));
    cutPath = path.join(dir, "cut.mp4");
    musicPath = path.join(dir, "music.wav");
    silentCutPath = path.join(dir, "silent.mp4");

    // Stand-in for an LTX-2 cut: 10s of video with a 300 Hz "dialogue" tone.
    expect(
      (
        await runProcess(
          "ffmpeg",
          [
            "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=navy:s=320x240:r=24:d=10",
            "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=10",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-ac", "2", "-shortest", cutPath,
          ],
          180_000,
        )
      ).code,
    ).toBe(0);

    // Generated music bed, deliberately 44.1 kHz mono to exercise normalization.
    expect(
      (
        await runProcess(
          "ffmpeg",
          [
            "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=4",
            "-ac", "1", musicPath,
          ],
          120_000,
        )
      ).code,
    ).toBe(0);

    expect(
      (
        await runProcess(
          "ffmpeg",
          [
            "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=black:s=320x240:r=24:d=10",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", silentCutPath,
          ],
          120_000,
        )
      ).code,
    ).toBe(0);
  }, 300_000);

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function resolvedCue(overrides: Partial<ResolvedCue["cue"]> = {}): ResolvedCue[] {
    const single: FinalCutPlan = {
      projectId: "p",
      clips: [{ sceneId: "s1", sceneNumber: 1, path: cutPath, durationSeconds: 10, transitionIn: "cut", transitionOut: "cut" }],
      totalDurationSeconds: 10,
      finalTrimSeconds: 0,
    };
    return resolveCueTimeline(single, [
      cue({ sceneId: "s1", startSeconds: 3, durationSeconds: 4, generatedPath: musicPath, ...overrides }),
    ]);
  }

  it("places music in its window and ducks the native track underneath", async () => {
    const out = path.join(dir, "mixed.mp4");
    await new NativeFfmpegRunner().mixAudio(cutPath, resolvedCue(), out);

    const probe = await probeMedia(out);
    expect(probe?.hasVideo).toBe(true);
    expect(probe?.hasAudio).toBe(true);
    expect(probe!.durationSeconds!).toBeGreaterThan(9.5);

    const [nativeBefore, nativeDuring, nativeAfter] = await Promise.all([
      bandDb(out, 0, 2.5, 300),
      bandDb(out, 4, 2, 300),
      bandDb(out, 7.5, 2, 300),
    ]);
    const [musicBefore, musicDuring, musicAfter] = await Promise.all([
      bandDb(out, 0, 2.5, 880),
      bandDb(out, 4, 2, 880),
      bandDb(out, 7.5, 2, 880),
    ]);

    // Native ducked by roughly the requested -12 dB, then restored.
    expect(nativeDuring).toBeLessThan(nativeBefore - 8);
    expect(nativeAfter).toBeGreaterThan(nativeDuring + 8);
    // Music present only inside the cue window.
    expect(musicDuring).toBeGreaterThan(musicBefore + 15);
    expect(musicDuring).toBeGreaterThan(musicAfter + 15);
  }, 300_000);

  it("leaves the native track alone for an additive SFX cue", async () => {
    const out = path.join(dir, "sfx.mp4");
    await new NativeFfmpegRunner().mixAudio(
      cutPath,
      resolvedCue({ kind: "sfx", duckNativeDb: 0 }),
      out,
    );

    const [before, during] = await Promise.all([bandDb(out, 0, 2.5, 300), bandDb(out, 4, 2, 300)]);
    expect(Math.abs(during - before)).toBeLessThan(2);
  }, 300_000);

  it("silences the native track when the cue is a full replace", async () => {
    const out = path.join(dir, "replace.mp4");
    await new NativeFfmpegRunner().mixAudio(cutPath, resolvedCue({ duckNativeDb: -60 }), out);

    const [before, during] = await Promise.all([bandDb(out, 0, 2.5, 300), bandDb(out, 4, 2, 300)]);
    expect(during).toBeLessThan(before - 30);
  }, 300_000);

  it("mixes onto a cut that has no audio track at all", async () => {
    const out = path.join(dir, "from-silent.mp4");
    await new NativeFfmpegRunner().mixAudio(silentCutPath, resolvedCue(), out);

    const probe = await probeMedia(out);
    expect(probe?.hasAudio).toBe(true);
    expect(await bandDb(out, 4, 2, 880)).toBeGreaterThan(await bandDb(out, 0, 2.5, 880));
  }, 300_000);

  it("fails loudly when the cue audio is missing", async () => {
    await expect(
      new NativeFfmpegRunner().mixAudio(
        cutPath,
        resolvedCue({ generatedPath: path.join(dir, "nope.wav") }),
        path.join(dir, "never.mp4"),
      ),
    ).rejects.toThrow(/missing on disk/);
  });
});
