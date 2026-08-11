import { describe, it, expect } from "vitest";
import { buildSettingsManifest } from "@/lib/wangp/settings";
import { familyOf, supportsNegativePrompt } from "@/lib/wangp/family";
import { hasNativeAudio, videoPromptDirective } from "@/lib/agents/model-directives";
import { positiveConstraintClause } from "@/lib/agents/negative-prompt";
import { clampPreset, videoResolutionCeiling } from "@/lib/wangp/resolution";
import { clipLengthGuidance, recommendedSegmentSeconds } from "@/lib/wangp/clip-length";
import type { WangpModelSchema } from "@/lib/schemas/wangp";

/**
 * MiniMax H3 support.
 *
 * The schema fixture mirrors a live dump of `minimax_h3_fl2va`: it declares
 * `duration_seconds` (which video models mean something else by), carries
 * `spatial_upsampling` as a bare default rather than a declared field, and
 * declares **no** `negative_prompt` — which is why exclusions have to travel
 * inside the positive prompt.
 */
const h3Schema: WangpModelSchema = {
  modelType: "minimax_h3_fl2va_pruned",
  defaultSettings: {
    prompt: "",
    resolution: "832x480",
    video_length: 124,
    duration_seconds: 0,
    spatial_upsampling: "flashvsr2",
    sliding_window_size: 362,
    flow_shift: 12,
    batch_size: 1,
    // Live defaults always supply these two. Omitting them let `setIf` and the
    // `image_prompt_type` derivation take branches production never reaches.
    image_prompt_type: "",
    multi_prompts_gen_type: "PG",
    model_type: "minimax_h3_fl2va_pruned",
  },
  fields: [
    { name: "prompt", type: "string" },
    { name: "resolution", type: "string" },
    { name: "video_length", type: "number" },
    { name: "duration_seconds", type: "number" },
    { name: "image_start", type: "string" },
    { name: "image_end", type: "string" },
  ],
};

const audioSchema: WangpModelSchema = {
  modelType: "stable_audio3_small",
  defaultSettings: { prompt: "", duration_seconds: 0, model_type: "stable_audio3_small" },
  fields: [
    { name: "prompt", type: "string" },
    { name: "duration_seconds", type: "number" },
  ],
};

describe("duration_seconds is an audio control", () => {
  it("is not written on a video job", () => {
    const manifest = buildSettingsManifest(h3Schema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "x",
      fps: 24,
      durationSeconds: 20,
    });
    // The model declares the field and defaults it to 0; a clip's length belongs
    // in video_length, and writing it here changed a setting nobody chose.
    expect(manifest.settings.duration_seconds).toBe(0);
  });

  it("is still written on an audio job", () => {
    const manifest = buildSettingsManifest(audioSchema, {
      sceneId: "s1",
      purpose: "audio",
      prompt: "x",
      durationSeconds: 12,
    });
    expect(manifest.settings.duration_seconds).toBe(12);
  });
});

describe("spatial_upsampling is written, not inherited", () => {
  it("is set when asked for, despite not being a declared field", () => {
    const manifest = buildSettingsManifest(h3Schema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "x",
      fps: 24,
      spatialUpsampling: "flashvsr2",
    });
    expect(manifest.settings.spatial_upsampling).toBe("flashvsr2");
  });

  it("can be cleared explicitly", () => {
    const manifest = buildSettingsManifest(h3Schema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "x",
      fps: 24,
      spatialUpsampling: "",
    });
    expect(manifest.settings.spatial_upsampling).toBe("");
  });

  it("leaves the model default alone when not asked for", () => {
    const manifest = buildSettingsManifest(h3Schema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "x",
      fps: 24,
    });
    expect(manifest.settings.spatial_upsampling).toBe("flashvsr2");
  });

  it("does not invent the key on a model that has no upsampler", () => {
    const manifest = buildSettingsManifest(audioSchema, {
      sceneId: "s1",
      purpose: "audio",
      prompt: "x",
      spatialUpsampling: "flashvsr2",
    });
    expect("spatial_upsampling" in manifest.settings).toBe(false);
  });
});

describe("MiniMax is a recognised family", () => {
  it("resolves from the model type", () => {
    expect(familyOf("minimax_h3_fl2va_pruned")).toBe("minimax");
  });

  it("resolves from WanGP's declared family", () => {
    expect(familyOf("something_else", "minimax_h3")).toBe("minimax");
  });

  it("does not steal models from the other families", () => {
    expect(familyOf("ltx2_22B_distilled_1_1")).toBe("ltx");
    expect(familyOf("wan_i2v_14b")).toBe("wan");
    expect(familyOf("flux2_klein_base_9b")).toBe("flux");
  });
});

describe("MiniMax prompt guidance", () => {
  it("writes its own soundtrack", () => {
    expect(hasNativeAudio("minimax")).toBe(true);
  });

  it("gets a directive rather than the empty string an unknown model gets", () => {
    const directive = videoPromptDirective("minimax", { segmentSeconds: 15, nativeAudio: true });
    expect(directive).not.toBe("");
    expect(directive).toContain("MiniMax");
  });

  it("is told the speech budget when it renders audio", () => {
    const directive = videoPromptDirective("minimax", { segmentSeconds: 15, nativeAudio: true });
    expect(directive).toContain("30 words");
  });

  it("omits the audio paragraph when audio is off", () => {
    const directive = videoPromptDirective("minimax", { segmentSeconds: 15, nativeAudio: false });
    expect(directive).not.toContain("soundtrack");
  });

  /**
   * From MiniMax's own VIDEO_PROMPT_WRITING_GUIDE. The camera terms are a
   * controlled vocabulary, and the three audio layers are separate fields in
   * H3's native format — an agent that blurs them writes score into the
   * ambience and loses both.
   */
  it("carries MiniMax's camera vocabulary and its amplitude/speed qualifiers", () => {
    const directive = videoPromptDirective("minimax", { segmentSeconds: 15, nativeAudio: true });
    for (const term of ["push in", "truck left", "arc shot", "static shot"]) {
      expect(directive).toContain(term);
    }
    expect(directive).toContain("with small amplitude");
    expect(directive).toContain("at slow speed");
  });

  it("keeps ambience, audience-only score and speech apart, and bans mood words for score", () => {
    const directive = videoPromptDirective("minimax", { segmentSeconds: 15, nativeAudio: true });
    expect(directive).toMatch(/soundscape/i);
    expect(directive).toMatch(/only the audience can hear/i);
    expect(directive).toMatch(/instrumentation/i);
    expect(directive).toMatch(/never by the mood/i);
  });

  it("tells the agent to write exclusions positively, since H3 has no negative prompt", () => {
    const directive = videoPromptDirective("minimax", { segmentSeconds: 15, nativeAudio: false });
    expect(directive).toMatch(/no negative prompt/i);
  });

  /**
   * MiniMax ask for 350-500 words and their own worked examples run that long.
   * The instruction has to say the length is descriptive density, or an agent
   * hits the count by inventing events the motion budget cannot pay for.
   */
  it("asks for the length MiniMax's guide asks for, without inviting more action", () => {
    const directive = videoPromptDirective("minimax", { segmentSeconds: 15, nativeAudio: false });
    expect(directive).toMatch(/350 to 500 words/);
    expect(directive).toMatch(/never by adding more events/i);
  });
});

/**
 * A live `minimax_h3_fl2va` schema declares no `negative_prompt`, so `setIf`
 * dropped every exclusion without a word — the same failure FLUX had.
 */
describe("MiniMax has no negative prompt", () => {
  it("is excluded from negative-prompt support", () => {
    expect(supportsNegativePrompt("minimax")).toBe(false);
  });

  it("folds the exclusion into the positive prompt instead of losing it", () => {
    const terms = "flicker, identity drift";
    expect(positiveConstraintClause(terms)).toBeTruthy();
  });

  it("never writes the field onto a model that does not declare it", () => {
    const manifest = buildSettingsManifest(h3Schema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "a clip",
      negativePrompt: "flicker, identity drift",
      imageStart: "start.png",
      imageEnd: "end.png",
    });
    expect(manifest.settings.negative_prompt).toBeUndefined();
  });
});

/**
 * Ref2VA reports the same family as FL2VA but declares `image_refs` in place of
 * the keyframe inputs, so a project pinned to it would have both frames dropped
 * by `setIf` and render a text-to-video clip that merely looks disappointing.
 */
describe("a video model that cannot take keyframes", () => {
  const ref2va: WangpModelSchema = {
    modelType: "minimax_h3_ref2va",
    defaultSettings: {
      prompt: "",
      image_prompt_type: "",
      multi_prompts_gen_type: "PG",
      model_type: "minimax_h3_ref2va",
    },
    fields: [
      { name: "prompt", type: "string" },
      { name: "image_refs", type: "string" },
    ],
  };

  const clip = { sceneId: "s1", purpose: "video_segment" } as const;

  it("is refused rather than silently rendered from the prompt alone", () => {
    expect(() =>
      buildSettingsManifest(ref2va, { ...clip, prompt: "a clip", imageStart: "start.png" }),
    ).toThrow(/FL2VA variant, not Ref2VA/);
  });

  it("still builds when no keyframes were supplied", () => {
    expect(() => buildSettingsManifest(ref2va, { ...clip, prompt: "a clip" })).not.toThrow();
  });

  it("leaves a model that does take keyframes alone", () => {
    expect(() =>
      buildSettingsManifest(h3Schema, { ...clip, prompt: "a clip", imageStart: "start.png" }),
    ).not.toThrow();
  });
});

describe("video resolution ceiling", () => {
  it("holds MiniMax down to draft", () => {
    expect(videoResolutionCeiling("minimax")).toBe("draft");
    expect(clampPreset("high", videoResolutionCeiling("minimax"))).toBe("draft");
    expect(clampPreset("standard", videoResolutionCeiling("minimax"))).toBe("draft");
  });

  it("never raises a preset the project deliberately lowered", () => {
    expect(clampPreset("draft", "high")).toBe("draft");
    expect(clampPreset("draft", "standard")).toBe("draft");
  });

  it("leaves every other family alone", () => {
    for (const family of ["ltx", "wan", "flux", "qwen", "krea", "unknown"] as const) {
      expect(videoResolutionCeiling(family)).toBeUndefined();
      expect(clampPreset("high", videoResolutionCeiling(family))).toBe("high");
    }
  });
});

describe("clip length guidance", () => {
  /**
   * 362 frames at H3's native 24fps, read from a live `minimax_h3_fl2va`
   * schema. The earlier 20s figure came from a stale reading and made the
   * project settings screen promise a single pass it would not get.
   */
  it("recommends staying inside MiniMax's single window", () => {
    const advice = clipLengthGuidance("minimax");
    expect(advice?.singleWindowSeconds).toBe(15);
    expect(advice?.recommendedSeconds).toBe(15);
    expect(advice!.recommendedSeconds).toBeLessThanOrEqual(advice!.singleWindowSeconds);
  });

  it("has no opinion about families without a known boundary", () => {
    expect(clipLengthGuidance("wan")).toBeUndefined();
    expect(recommendedSegmentSeconds("wan")).toBe(20);
  });

  it("recommends 15s for MiniMax", () => {
    expect(recommendedSegmentSeconds("minimax")).toBe(15);
  });
});
