import { afterEach, describe, expect, it, vi } from "vitest";
import { imagePromptDirective } from "@/lib/agents/model-directives";
import { lookPromptSuffix, placeLook } from "@/lib/agents/look";
import { positiveConstraintClause, unfoldableTerms } from "@/lib/agents/negative-prompt";
import { SIMPLIFY_PROMPT_SYSTEM } from "@/lib/agents/prompt-simplifier";
import { isKreaGuided, negativePromptReaches } from "@/lib/wangp/family";
import { buildImageManifest } from "@/lib/services/wangp-service";
import { setWangpClient } from "@/lib/wangp/factory";
import { LiveWangpClient } from "@/lib/wangp/live-client";
import { WangpMcpTransport } from "@/lib/wangp/mcp/transport";
import type { Project } from "@/lib/schemas/project";

/**
 * Krea 2 prompts judged against Krea's published prompting guide and the
 * WanGP Krea 2 pipeline: a natural-language description of a visible result,
 * the medium early, no quality boilerplate, quoted lettering, and negatives
 * that reach RAW's guided sampler but not Turbo's distilled one.
 */

const project = (over: Partial<Project> = {}): Project =>
  ({
    id: "p1",
    title: "T",
    concept: "c",
    requestedDurationSeconds: 40,
    segmentSeconds: 20,
    segmentCount: 2,
    generatedDurationSeconds: 40,
    finalTrimSeconds: 0,
    aspectRatio: "16:9",
    resolutionPreset: "standard",
    style: "film noir",
    tone: "gritty",
    audience: "general audiences",
    creativeMode: "film_short",
    narrationRequired: false,
    dialogueRequired: false,
    musicRequired: false,
    sfxRequired: false,
    generationMode: "video_segments",
    modelStrategy: "auto",
    useCharacterLibrary: false,
    characterIds: [],
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as Project;

describe("what the image agent is told about Krea 2", () => {
  const directive = imagePromptDirective("krea");

  it("asks for a natural-language description of the visible result", () => {
    expect(directive).toMatch(/natural-language paragraph/i);
    expect(directive).toMatch(/visible result/i);
  });

  it("binds attributes to their subject and keeps essentials early", () => {
    expect(directive).toMatch(/bind every attribute/i);
    expect(directive).toMatch(/essential early/i);
  });

  it("asks for light by source, direction and visible effect, and concrete materials", () => {
    expect(directive).toMatch(/source, direction and visible effect/i);
    expect(directive).toMatch(/brushed steel/i);
  });

  it("quotes lettering on a named surface and forbids invented text", () => {
    expect(directive).toMatch(/double quotes/i);
    expect(directive).toMatch(/never invent visible text/i);
  });

  it("rules out syntax borrowed from other tools", () => {
    for (const term of ["masterpiece", "(subject:1.3)", "--ar", "<lora:"]) {
      expect(directive).toContain(term);
    }
  });

  it("asks for contradictions to be removed and a short task-specific negative", () => {
    expect(directive).toMatch(/remove contradictions/i);
    expect(directive).toMatch(/not a generic quality or anatomy list/i);
  });
});

describe("the look on a Krea prompt", () => {
  it("leaves a non-visual audience off Krea", () => {
    const suffix = lookPromptSuffix(project(), "A wide shot of a bar.", "krea");
    expect(suffix).toContain("film noir style");
    expect(suffix).not.toContain("Intended audience");
  });

  /** The explicit audience wording changes what is drawn, so it stays. */
  it("keeps an explicit-content audience on Krea", () => {
    const suffix = lookPromptSuffix(project({ audience: "Adults only (explicit)" }), "A bar.", "krea");
    expect(suffix).toContain("Intended audience: Adults only (explicit).");
  });

  it("leaves every other family as it was", () => {
    expect(lookPromptSuffix(project(), "A bar.", "qwen")).toContain("Intended audience: general audiences.");
    expect(lookPromptSuffix(project(), "A bar.")).toContain("Intended audience: general audiences.");
  });

  it("puts the look straight after the framing on Krea", () => {
    const prompt = "Medium shot, eye level, front. Mara sits at the bar. Exactly one woman is in frame.";
    expect(placeLook(prompt, " film noir style, gritty mood.", "krea")).toBe(
      "Medium shot, eye level, front. film noir style, gritty mood. Mara sits at the bar. Exactly one woman is in frame.",
    );
  });

  it("keeps the rest of the prompt verbatim, line breaks included", () => {
    const prompt = "Close-up, eye level. Mara smiles.\nTrigger text.";
    expect(placeLook(prompt, " noir style.", "krea")).toBe("Close-up, eye level. noir style. Mara smiles.\nTrigger text.");
  });

  it("appends where there is nothing after the framing, or on other families", () => {
    expect(placeLook("Wide shot of a bar.", " noir style.", "krea")).toBe("Wide shot of a bar. noir style.");
    expect(placeLook("Wide shot. A bar.", " noir style.", "flux")).toBe("Wide shot. A bar. noir style.");
    expect(placeLook("Wide shot. A bar.", "", "krea")).toBe("Wide shot. A bar.");
  });
});

describe("folding exclusions for Krea 2 Turbo", () => {
  const krea = { family: "krea" as const, prompt: "Medium shot, eye level. Mara sits at the bar." };

  it("drops quality boilerplate that constrains nothing visible", () => {
    const clause = positiveConstraintClause("blurry, low quality, distorted anatomy", null, krea);
    expect(clause).not.toContain("crisp subject detail");
    expect(clause).not.toContain("cleanly resolved detail");
    expect(clause).toContain("correct natural anatomy");
  });

  it("reports the dropped quality terms as lost", () => {
    expect(unfoldableTerms("blurry, low quality, distorted anatomy", krea)).toEqual(["blurry", "low quality"]);
  });

  it("never spells lettering out as an absence", () => {
    const clause = positiveConstraintClause("text artifacts, watermark", null, krea);
    expect(clause).not.toMatch(/lettering/);
    expect(clause.match(/clean unmarked surfaces/g)).toHaveLength(1);
  });

  it("does not contradict lettering the prompt quotes", () => {
    const signed = { family: "krea" as const, prompt: 'A shopfront whose ivory sign reads "OPEN DAILY".' };
    const clause = positiveConstraintClause("text artifacts, watermark, distorted anatomy", null, signed);
    expect(clause).not.toContain("unmarked");
    expect(clause).toContain("correct natural anatomy");
  });

  it("leaves FLUX's fold as it was", () => {
    const clause = positiveConstraintClause("blurry, text artifacts", null, { family: "flux", prompt: 'A sign reads "OPEN".' });
    expect(clause).toContain("crisp subject detail");
    expect(clause).toContain("no signs, labels or lettering anywhere");
  });
});

describe("whether a Krea negative reaches the render", () => {
  it("recognises the guided RAW checkpoints", () => {
    expect(isKreaGuided("krea2_raw")).toBe(true);
    expect(isKreaGuided("krea2_raw_edit")).toBe(true);
    expect(isKreaGuided("krea2_turbo_edit")).toBe(false);
    expect(isKreaGuided("krea2_turbo_general_edit_v2")).toBe(false);
    expect(isKreaGuided("flux_krea")).toBe(false);
  });

  it("passes it to RAW, folds it on Turbo", () => {
    expect(negativePromptReaches("krea", true, "krea2_raw_edit")).toBe(true);
    expect(negativePromptReaches("krea", undefined, "krea2_raw")).toBe(true);
    expect(negativePromptReaches("krea", true, "krea2_turbo_edit")).toBe(false);
    expect(negativePromptReaches("krea", true)).toBe(false);
  });

  it("still lets the schema withhold it", () => {
    expect(negativePromptReaches("krea", false, "krea2_raw_edit")).toBe(false);
  });

  it("does not let a model name grant one to another family", () => {
    expect(negativePromptReaches("flux", true, "flux_raw")).toBe(false);
  });
});

describe("Krea negatives in the final manifest", () => {
  afterEach(() => {
    setWangpClient(undefined);
    vi.restoreAllMocks();
  });

  function kreaClient(type: string) {
    const metadata = {
      model_type: type, name: type, main_output: "image", family: "krea2", base_model_type: type,
      media_inputs: { image: { reference: true, multiple_references: true } },
    };
    vi.spyOn(WangpMcpTransport.prototype, "findTool").mockResolvedValue("wangp_models");
    vi.spyOn(WangpMcpTransport.prototype, "getToolInputSchema").mockResolvedValue({
      properties: { settings: {}, wait: { type: "boolean" } },
    });
    vi.spyOn(WangpMcpTransport.prototype, "call").mockImplementation(async (name, args) => {
      if (name === "wangp_models") return { models: [metadata], has_more: false };
      if (name === "wangp_model") {
        if (args?.action === "capabilities") return { metadata };
        if (args?.action === "definition") return { definition: { image_outputs: true } };
        if (args?.action === "defaults") {
          return {
            defaults: {
              model_type: type, prompt: "", negative_prompt: "", resolution: "1024x1024",
              num_inference_steps: 8, video_prompt_type: "", image_prompt_type: "",
            },
          };
        }
      }
      throw new Error(`Unexpected tool ${name}`);
    });
    setWangpClient(new LiveWangpClient("http://127.0.0.1:1/mcp"));
  }

  const args = {
    sceneId: "s1", purpose: "start_frame" as const, modelStrategy: "auto" as const,
    prompt: "Medium shot, eye level. Mara sits at a bar.",
    negativePrompt: "blurry, distorted anatomy",
  };

  it("sends RAW its negative prompt untouched", async () => {
    kreaClient("krea2_raw_edit");
    const manifest = await buildImageManifest({ ...args, modelType: "krea2_raw_edit" });
    expect(manifest.settings.negative_prompt).toBe("blurry, distorted anatomy");
    expect(manifest.settings.prompt).toBe(args.prompt);
  });

  it("folds Turbo's into the prompt without quality boilerplate", async () => {
    kreaClient("krea2_turbo_edit");
    const manifest = await buildImageManifest({ ...args, modelType: "krea2_turbo_edit" });
    expect(manifest.settings.negative_prompt ?? "").toBe("");
    expect(manifest.settings.prompt).toBe(`${args.prompt} Render with correct natural anatomy.`);
  });
});

describe("the simplifier's view of Krea 2", () => {
  it("no longer claims Krea 2 has no negative prompt at all", () => {
    expect(SIMPLIFY_PROMPT_SYSTEM).not.toMatch(/which has no negative prompts/);
    expect(SIMPLIFY_PROMPT_SYSTEM).toMatch(/Turbo checkpoints ignore negative prompts/);
  });

  it("strips borrowed syntax but keeps trigger words and quoted lettering", () => {
    expect(SIMPLIFY_PROMPT_SYSTEM).toMatch(/keep plain trigger words/);
    expect(SIMPLIFY_PROMPT_SYSTEM).toMatch(/quoted lettering exactly/);
  });
});
