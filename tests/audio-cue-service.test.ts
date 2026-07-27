import { describe, it, expect, afterEach } from "vitest";
import { createProject, generateStoryboard, generateAudioPlan } from "@/lib/services/project-service";
import { generateSceneMedia, approveAttempt } from "@/lib/services/media-service";
import { assembleRoughCut, listMedia } from "@/lib/services/assembly-service";
import {
  addAudioCue,
  approveAudioCue,
  generateAudioCue,
  removeAudioCue,
  updateAudioCue,
} from "@/lib/services/audio-service";
import { setFfmpegRunner, type ClipInput, type FfmpegRunner } from "@/lib/media/ffmpeg";
import type { ResolvedCue } from "@/lib/media/audio-mix";
import { parseMediaRef } from "@/lib/media/refs";

/** Runner that records what assembly asked it to mix. */
class RecordingRunner implements FfmpegRunner {
  readonly mode = "mock" as const;
  mixCalls: { videoPath: string; cues: ResolvedCue[]; output: string }[] = [];

  async concat(_clips: ClipInput[], output: string): Promise<string> {
    return output;
  }

  async mixAudio(videoPath: string, cues: ResolvedCue[], output: string): Promise<string> {
    this.mixCalls.push({ videoPath, cues, output });
    return output;
  }
}

afterEach(() => setFfmpegRunner(undefined));

async function projectReadyToAssemble(seconds: number) {
  const project = await createProject({
    concept: "A lighthouse keeper waits out a storm.",
    requestedDurationSeconds: seconds,
    musicRequired: true,
  });
  const withStoryboard = await generateStoryboard(project.id);
  for (const scene of withStoryboard.storyboard!.scenes) {
    const gen = await generateSceneMedia(project.id, scene.id);
    await approveAttempt(project.id, scene.id, gen.attempts![scene.id]![0]!.id);
  }
  return { project, scenes: withStoryboard.storyboard!.scenes };
}

describe("audio cue lifecycle", () => {
  it("proposes cues from the audio plan anchored to real scenes", async () => {
    const { project, scenes } = await projectReadyToAssemble(40);
    const record = await generateAudioPlan(project.id);

    const cues = record.audioPlan!.cues;
    expect(cues).toHaveLength(scenes.length);
    for (const cue of cues) {
      expect(scenes.map((s) => s.id)).toContain(cue.sceneId);
      expect(cue.kind).toBe("music");
      expect(cue.approved).toBe(false);
    }
  });

  it("runs add -> generate -> approve and only then reaches the mix", async () => {
    const { project, scenes } = await projectReadyToAssemble(20);
    await generateAudioPlan(project.id);
    const runner = new RecordingRunner();
    setFfmpegRunner(runner);

    const added = await addAudioCue(project.id, {
      sceneId: scenes[0]!.id,
      kind: "sfx",
      prompt: "distant thunder",
      startSeconds: 4,
      durationSeconds: 3,
    });
    const cue = added.audioPlan!.cues.find((c) => c.prompt === "distant thunder")!;
    expect(cue.duckNativeDb).toBe(0); // SFX is additive by default

    // Unapproved and ungenerated cues must not reach the mixer.
    await assembleRoughCut(project.id);
    expect(runner.mixCalls).toHaveLength(0);

    const generated = await generateAudioCue(project.id, cue.id);
    expect(generated.audioPlan!.cues.find((c) => c.id === cue.id)!.generatedPath).toBeTruthy();

    // Still unapproved -> still not mixed.
    await assembleRoughCut(project.id);
    expect(runner.mixCalls).toHaveLength(0);

    await approveAudioCue(project.id, cue.id);
    const assembled = await assembleRoughCut(project.id);

    expect(runner.mixCalls).toHaveLength(1);
    const mixed = runner.mixCalls[0]!.cues;
    expect(mixed.some((m) => m.cue.id === cue.id)).toBe(true);
    expect(assembled.assembly!.finalPath).toContain("final-cut.mp4");
    // The un-scored rough cut is preserved alongside the scored one.
    expect(assembled.assembly!.roughCutPath).toContain("rough-cut.mp4");
  });

  it("refuses to approve a cue that has no audio yet", async () => {
    const { project, scenes } = await projectReadyToAssemble(20);
    await generateAudioPlan(project.id);
    const added = await addAudioCue(project.id, {
      sceneId: scenes[0]!.id,
      kind: "music",
      prompt: "swelling strings",
    });
    const cue = added.audioPlan!.cues.find((c) => c.prompt === "swelling strings")!;
    await expect(approveAudioCue(project.id, cue.id)).rejects.toThrow(/Generate the cue audio/);
  });

  it("rejects a cue that starts past the end of its scene", async () => {
    const { project, scenes } = await projectReadyToAssemble(20);
    await generateAudioPlan(project.id);
    await expect(
      addAudioCue(project.id, {
        sceneId: scenes[0]!.id,
        kind: "sfx",
        prompt: "too late",
        startSeconds: 999,
      }),
    ).rejects.toThrow(/only 20s long/);
  });

  it("invalidates rendered audio when the prompt changes, but not on a timing tweak", async () => {
    const { project, scenes } = await projectReadyToAssemble(20);
    await generateAudioPlan(project.id);
    const added = await addAudioCue(project.id, {
      sceneId: scenes[0]!.id,
      kind: "music",
      prompt: "original",
    });
    const cueId = added.audioPlan!.cues.find((c) => c.prompt === "original")!.id;
    await generateAudioCue(project.id, cueId);
    await approveAudioCue(project.id, cueId);

    const moved = await updateAudioCue(project.id, cueId, { startSeconds: 6 });
    const afterMove = moved.audioPlan!.cues.find((c) => c.id === cueId)!;
    expect(afterMove.generatedPath).toBeTruthy();
    expect(afterMove.approved).toBe(true);

    const reworded = await updateAudioCue(project.id, cueId, { prompt: "completely different" });
    const afterReword = reworded.audioPlan!.cues.find((c) => c.id === cueId)!;
    expect(afterReword.generatedPath).toBeUndefined();
    expect(afterReword.approved).toBe(false);
  });

  it("removes a cue", async () => {
    const { project, scenes } = await projectReadyToAssemble(20);
    await generateAudioPlan(project.id);
    const added = await addAudioCue(project.id, {
      sceneId: scenes[0]!.id,
      kind: "sfx",
      prompt: "temporary",
    });
    const cueId = added.audioPlan!.cues.find((c) => c.prompt === "temporary")!.id;
    const removed = await removeAudioCue(project.id, cueId);
    expect(removed.audioPlan!.cues.find((c) => c.id === cueId)).toBeUndefined();
  });

  it("requires an audio plan before cues can be added", async () => {
    const { project, scenes } = await projectReadyToAssemble(20);
    await expect(
      addAudioCue(project.id, { sceneId: scenes[0]!.id, kind: "music", prompt: "x" }),
    ).rejects.toThrow(/audio plan/i);
  });

  it("exposes generated cue audio as an opaque, servable reference", async () => {
    const { project, scenes } = await projectReadyToAssemble(20);
    await generateAudioPlan(project.id);
    const added = await addAudioCue(project.id, {
      sceneId: scenes[0]!.id,
      kind: "music",
      prompt: "audition me",
    });
    const cueId = added.audioPlan!.cues.find((c) => c.prompt === "audition me")!.id;
    await generateAudioCue(project.id, cueId);

    // Mock paths are outside the approved roots, so nothing is servable in demo
    // mode; the reference itself must still round-trip.
    expect(parseMediaRef(`cue~${cueId}`)).toEqual({ kind: "cue", cueId });
    expect(parseMediaRef("cue~../../etc/passwd")).toBeNull();
    expect(parseMediaRef("cue~a~b")).toBeNull();

    await expect(listMedia(project.id)).resolves.toBeInstanceOf(Array);
  });
});
