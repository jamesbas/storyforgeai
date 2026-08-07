import { describe, it, expect, vi } from "vitest";
import { MockWangpClient } from "@/lib/wangp/mock-client";
import { familyOf } from "@/lib/wangp/family";
import { clipLengthGuidance } from "@/lib/wangp/clip-length";
import { buildSettingsManifest } from "@/lib/wangp/settings";
import { ref2vaEstimateMinutes } from "@/lib/wangp/render-estimate";
import { videoPromptDirective } from "@/lib/agents/model-directives";
import { echoesInstructions } from "@/lib/agents/media-prompt-normalise";
import {
  H3_REFERENCE_MIN_WORDS,
  countWords,
  h3ReferenceTaskType,
  isH3ReferencePrompt,
  renderH3ReferencePrompt,
  stripH3ReferencePrompt,
  usesH3ReferenceFormat,
} from "@/lib/agents/h3-reference-prompt";
import type { WangpModel, WangpModelSchema } from "@/lib/schemas/wangp";

/**
 * MiniMax H3 reference mode.
 *
 * Ref2VA supplies its keyframes as references rather than positionally, so the
 * two things worth proving are that the manifest never sends a field this
 * checkpoint does not declare, and that the prose numbers the references in the
 * order WanGP will emit them. Everything downstream of a wrong number still
 * renders — it just renders the wrong picture as the wrong thing.
 */

const TRACEY = { name: "Tracey", description: "Late thirties, dark curls.", pictureIndex: 3 };

describe("the directive the prompt agents are given", () => {
  const reference = videoPromptDirective("minimax_ref2va", {
    segmentSeconds: 14,
    nativeAudio: true,
  });
  const keyframe = videoPromptDirective("minimax", { segmentSeconds: 15, nativeAudio: true });

  it("does not tell reference mode its frames are pinned", () => {
    // Ref2VA declares no image_start or image_end at all, so describing the
    // frames as pinned would have the agent write for conditioning that never
    // arrives — and leave the endpoints unstated, fixed by nothing.
    expect(keyframe).toContain("first-and-last-frame mode");
    expect(reference).not.toContain("first-and-last-frame mode");
    expect(reference).toContain("reference mode");
  });

  it("asks for the whole shot rather than only the path between the ends", () => {
    expect(keyframe).toContain("Describe that path, not the endpoints");
    expect(reference).toContain("including how it opens and how it ends");
  });

  it("asks for characters to be named and described, since that binds the photograph", () => {
    expect(reference).toContain("Name each character");
  });

  it("keeps everything the two variants genuinely share", () => {
    for (const directive of [reference, keyframe]) {
      expect(directive).toContain("one continuous shot with no cuts");
      expect(directive).toContain("no negative prompt");
      expect(directive).toContain("350 to 500 words");
      expect(directive).toContain("videoSoundscape");
    }
  });

  it("asks for the shape without handing over a name for it", () => {
    // Given the phrase, a model writes "the robot performs its dominant
    // action:" and the video model renders that sentence as description.
    for (const directive of [reference, keyframe]) {
      expect(directive).not.toMatch(/dominant action|secondary movement/i);
      expect(directive).toContain("one thing that happens");
    }
  });
});

describe("catching an instruction a model narrated anyway", () => {
  it("flags the phrasings that mean the brief leaked into the prose", () => {
    expect(echoesInstructions("The Robot performs its dominant action: it tilts its head.")).toEqual(
      ["dominant action"],
    );
    expect(echoesInstructions("As a secondary movement, it reaches down.")).toEqual([
      "secondary movement",
    ]);
    expect(echoesInstructions("The prompt should convey warmth.")).toHaveLength(1);
  });

  it("leaves ordinary prose alone", () => {
    expect(echoesInstructions("She tilts her head and reaches for the brush.")).toEqual([]);
    // "action" and "movement" are perfectly good words on their own.
    expect(echoesInstructions("The action moves left as the crowd movement slows.")).toEqual([]);
  });
});

describe("family split", () => {
  it("separates the two H3 variants", () => {
    expect(familyOf("minimax_h3_ref2va")).toBe("minimax_ref2va");
    expect(familyOf("minimax_h3_fl2va_pruned")).toBe("minimax");
  });

  it("anchors the variant token to the H3 lineage", () => {
    expect(familyOf("some_ref2va_thing")).toBe("unknown");
    expect(familyOf("something_else", "minimax_h3_ref2va")).toBe("minimax_ref2va");
  });

  it("gives only the reference variant a hard frame cap", () => {
    expect(clipLengthGuidance("minimax_ref2va")?.maxFrames).toBe(337);
    expect(clipLengthGuidance("minimax")?.maxFrames).toBeUndefined();
  });

  it("routes the format to the reference variant alone", () => {
    expect(usesH3ReferenceFormat("minimax_ref2va")).toBe(true);
    expect(usesH3ReferenceFormat("minimax")).toBe(false);
  });
});

describe("LoRAs on a variant that takes none", () => {
  const schema: WangpModelSchema = {
    modelType: "minimax_h3_ref2va",
    defaultSettings: { prompt: "" },
    fields: [{ name: "prompt", type: "string" }],
  } as unknown as WangpModelSchema;

  const build = (loras: { name: string; strength: number }[]) =>
    buildSettingsManifest(schema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "x",
      loras,
    });

  it("names the LoRAs and says where to clear them", () => {
    // The old message said only that the model "does not accept LoRAs", which
    // leaves someone staring at a failed chip with nothing to act on.
    expect(() => build([{ name: "minimax_h3_turbo_4step", strength: 1 }])).toThrow(
      /minimax_h3_turbo_4step/,
    );
    expect(() => build([{ name: "minimax_h3_turbo_4step", strength: 1 }])).toThrow(
      /project settings screen/,
    );
  });

  it("stays silent when nothing is selected", () => {
    expect(() => build([])).not.toThrow();
  });
});

describe("the six-section prompt", () => {
  const rendered = renderH3ReferencePrompt({
    body: 'Tracey turns from the window and says, "We should go."',
    style: "Warm naturalistic interior, shallow depth of field.",
    summary: "A woman turns from a window and speaks.",
    subjects: [TRACEY],
    hasStart: true,
    hasEnd: true,
    soundscape: "Rain on glass, a chair creaking.",
    score: "Low strings, slow.",
  });

  it("emits the sections in the guide's order", () => {
    const order = [
      "subject_definitions:",
      "summary:",
      "retention_analysis:",
      "detailed_description:",
      "overall_soundscape:",
      "non_diegetic_music:",
    ];
    const positions = order.map((section) => rendered.indexOf(section));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("names the task type both halves of the job", () => {
    expect(rendered).toContain("[keyframe completion + reference generation]");
    expect(h3ReferenceTaskType(true, false)).toBe("[keyframe completion]");
    expect(h3ReferenceTaskType(false, true)).toBe("[reference generation]");
  });

  it("gives anchors their own entry and cites a character's photo inside its subject", () => {
    expect(rendered).toContain("<Picture 1>: the first frame");
    expect(rendered).toContain("<Picture 2>: the last frame");
    // The character's photograph is picture 3, but must not get a standalone
    // entry of its own — that would offer the photo's setting as composition.
    expect(rendered).toContain("<Subject 1>: Tracey");
    expect(rendered).toContain("<Picture 3>.");
    expect(rendered).not.toContain("<Picture 3>: ");
  });

  it("states retention per label", () => {
    expect(rendered).toContain("fully_preserved");
    expect(rendered).toContain("<Subject 1>: attribute_transfer");
  });

  it("puts the style sentences before the shot marker", () => {
    const description = rendered.slice(rendered.indexOf("detailed_description:"));
    expect(description.indexOf("Warm naturalistic")).toBeLessThan(description.indexOf("[Shot 1]"));
  });

  it("marks spoken lines so they are performed rather than described", () => {
    expect(rendered).toContain("<d>[English] We should go.</d>");
  });

  it("writes N/A for an absent audio layer", () => {
    const silent = renderH3ReferencePrompt({
      body: "A held shot of an empty road.",
      subjects: [],
      hasStart: true,
      hasEnd: true,
    });
    expect(silent).toContain("overall_soundscape: N/A");
    expect(silent).toContain("non_diegetic_music: N/A");
  });

  it("recovers plain prose when the format has to be taken back off", () => {
    const plain = stripH3ReferencePrompt(rendered);
    expect(isH3ReferencePrompt(plain)).toBe(false);
    expect(plain).not.toContain("<Picture 1>");
    expect(plain).not.toContain("[Shot 1]");
    expect(plain).toContain('"We should go."');
    // The audio layers are direction, so they survive the fallback.
    expect(plain).toContain("Rain on glass");
  });

  it("counts words against the floor without padding to reach it", () => {
    expect(countWords("one two three")).toBe(3);
    expect(countWords("   ")).toBe(0);
    expect(H3_REFERENCE_MIN_WORDS).toBe(350);
  });
});

describe("the cost estimate", () => {
  it("matches the measured runs", () => {
    expect(ref2vaEstimateMinutes(1)).toBe(20);
    expect(ref2vaEstimateMinutes(2)).toBe(25);
    expect(ref2vaEstimateMinutes(3)).toBe(30);
  });
});

describe("the frame cap", () => {
  const schema: WangpModelSchema = {
    modelType: "minimax_h3_ref2va",
    defaultSettings: { prompt: "" },
    fields: [
      { name: "prompt", type: "string" },
      { name: "video_length", type: "number" },
    ],
  } as unknown as WangpModelSchema;

  it("clamps a request past the variant's ceiling", () => {
    const manifest = buildSettingsManifest(schema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "x",
      fps: 24,
      durationSeconds: 15,
      maxFrames: 337,
    });
    expect(manifest.settings.video_length).toBe(337);
  });

  it("leaves a variant with no cap alone", () => {
    const manifest = buildSettingsManifest(schema, {
      sceneId: "s1",
      purpose: "video_segment",
      prompt: "x",
      fps: 24,
      durationSeconds: 15,
    });
    expect(manifest.settings.video_length).toBe(361);
  });
});

/**
 * A catalogue of one Ref2VA checkpoint, declaring exactly what the live schema
 * dump declares — which notably excludes `image_start` and `image_end`.
 */
class Ref2vaClient extends MockWangpClient {
  async listModels(): Promise<WangpModel[]> {
    return [
      {
        modelType: "minimax_h3_ref2va",
        name: "MiniMax H3 Ref2VA",
        mainOutput: "video",
        outputs: ["video", "audio"],
        metadata: { family: "minimax_h3" },
      },
    ] as unknown as WangpModel[];
  }

  async getModelSchema(modelType: string): Promise<WangpModelSchema> {
    return {
      modelType,
      defaultSettings: { prompt: "", resolution: "832x480", video_prompt_type: "" },
      fields: [
        { name: "prompt", type: "string" },
        { name: "resolution", type: "string" },
        { name: "video_length", type: "number" },
        { name: "image_refs", type: "array" },
        { name: "video_prompt_type", type: "string" },
      ],
    } as unknown as WangpModelSchema;
  }
}

async function ref2vaManifest(overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  const { setWangpClient } = await import("@/lib/wangp/factory");
  setWangpClient(new Ref2vaClient());
  const { buildVideoManifest } = await import("@/lib/services/wangp-service");

  return buildVideoManifest({
    sceneId: "s1",
    prompt: "Tracey turns from the window.",
    modelStrategy: "auto",
    modelType: "minimax_h3_ref2va",
    imageStart: "/frames/start.png",
    imageEnd: "/frames/end.png",
    durationSeconds: 14,
    cast: [{ name: "Tracey", description: "Late thirties.", imagePath: "/refs/tracey.png" }],
    ...overrides,
  });
}

describe("the Ref2VA manifest", () => {
  it("sends the frames as references and never as keyframes", async () => {
    const manifest = await ref2vaManifest();
    expect(manifest.settings.image_refs).toEqual([
      "/frames/start.png",
      "/frames/end.png",
      "/refs/tracey.png",
    ]);
    expect(manifest.settings.image_start).toBeUndefined();
    expect(manifest.settings.image_end).toBeUndefined();
  });

  it("leaves the reference group at the model's own default", async () => {
    // H3 Ref2VA ships `video_prompt_type: ""` and consumes image_refs directly.
    // Forcing WanGP's "KI" onto it moved which picture the model read as the
    // opening frame, so the supplied start frame came back at the end.
    const manifest = await ref2vaManifest();
    expect(manifest.settings.video_prompt_type).toBe("");
  });

  it("does not force a cache the model publishes no control for", async () => {
    // Forcing "spectrum" onto a checkpoint that declares it nowhere produced a
    // clip unrelated to its prompt, with no error to point at.
    const manifest = await ref2vaManifest();
    expect(manifest.settings.skip_steps_cache_type).toBeUndefined();
  });

  it("caps the clip where the variant stops", async () => {
    const manifest = await ref2vaManifest({ durationSeconds: 20 });
    expect(manifest.settings.video_length).toBe(337);
  });

  it("prompts in the six-section format", async () => {
    const manifest = await ref2vaManifest();
    expect(String(manifest.settings.prompt)).toContain("subject_definitions:");
    expect(String(manifest.settings.prompt)).toContain("<Picture 3>");
  });

  it("refuses a single anchor rather than rendering from the prompt alone", async () => {
    await expect(ref2vaManifest({ imageEnd: undefined })).rejects.toThrow(/both a start and an end/);
  });

  it("reports a cast past the cap rather than trimming it", async () => {
    const cast = ["a", "b", "c", "d"].map((name) => ({ name, imagePath: `/refs/${name}.png` }));
    await expect(ref2vaManifest({ cast })).rejects.toThrow(/at most 3 characters/);
  });
});
