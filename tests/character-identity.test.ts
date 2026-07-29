import { describe, it, expect } from "vitest";
import { castPromptSuffix, castSheet } from "@/lib/agents/cast";
import { referenceImagesOf, wantsFaceSwap } from "@/lib/schemas/character";
import { faceSwapSubject } from "@/lib/services/face-swap-service";
import { FACE_SWAP_LORAS, FACE_SWAP_SETTINGS } from "@/lib/wangp/face-swap-preset";
import type { Character } from "@/lib/schemas/character";

/**
 * Character identity conditioning.
 *
 * A written face and a reference photo are competing signals, and under
 * classifier-free guidance the text wins — which is backwards when the photo was
 * supplied to fix the likeness. These pin the rules that resolve that conflict.
 */

function character(overrides: Partial<Character> = {}): Character {
  return {
    id: "c1",
    name: "Elena",
    description: "A woman in her thirties, tall and lean, shoulder-length dark curly hair.",
    createdAt: "now",
    updatedAt: "now",
    ...overrides,
  };
}

describe("withholding the facial description", () => {
  const facial = "Soft oval face, warm brown eyes, a straight nose.";

  it("includes it in render prompts when there is no reference photo", () => {
    const suffix = castPromptSuffix([character({ facialDescription: facial })]);
    expect(suffix).toContain("Soft oval face");
  });

  /** The confirmed fix: the photo carries the face, the text stops competing. */
  it("withholds it from render prompts once a reference photo exists", () => {
    const suffix = castPromptSuffix([
      character({ facialDescription: facial, referenceImages: ["c1.jpg"] }),
    ]);
    expect(suffix).not.toContain("Soft oval face");
    // Everything a headshot cannot convey still travels.
    expect(suffix).toContain("tall and lean");
  });

  /** Planning agents have no photo, so they always need the full description. */
  it("keeps it for planning agents even with a reference photo", () => {
    const sheet = castSheet([character({ facialDescription: facial, referenceImages: ["c1.jpg"] })]);
    expect(sheet).toContain("Soft oval face");
  });

  it("is unaffected when no facial description is set", () => {
    const suffix = castPromptSuffix([character({ referenceImages: ["c1.jpg"] })]);
    expect(suffix).toContain("tall and lean");
  });

  it("still appends wardrobe when the face is withheld", () => {
    const suffix = castPromptSuffix([
      character({ facialDescription: facial, referenceImages: ["c1.jpg"], wardrobe: "red coat" }),
    ]);
    expect(suffix).toContain("Wearing exactly: red coat");
  });
});

describe("reference images", () => {
  it("reads the modern list", () => {
    expect(referenceImagesOf({ referenceImages: ["a.jpg", "b.jpg"] })).toEqual(["a.jpg", "b.jpg"]);
  });

  /** Records written before multi-image support carry a single filename. */
  it("falls back to the legacy single field", () => {
    expect(referenceImagesOf({ referenceImage: "old.jpg" })).toEqual(["old.jpg"]);
  });

  it("caps at the supported maximum", () => {
    expect(referenceImagesOf({ referenceImages: ["a", "b", "c", "d", "e"] })).toHaveLength(4);
  });

  it("returns nothing when neither field is set", () => {
    expect(referenceImagesOf({})).toEqual([]);
  });
});

describe("choosing a face-swap subject", () => {
  it("requires both the toggle and a reference photo", () => {
    expect(wantsFaceSwap(character({ faceSwap: true }))).toBe(false);
    expect(wantsFaceSwap(character({ referenceImages: ["a.jpg"] }))).toBe(false);
    expect(wantsFaceSwap(character({ faceSwap: true, referenceImages: ["a.jpg"] }))).toBe(true);
  });

  it("selects the single opted-in character", () => {
    const subject = faceSwapSubject([
      character({ id: "a", faceSwap: true, referenceImages: ["a.jpg"] }),
      character({ id: "b", name: "Other" }),
    ]);
    expect(subject?.id).toBe("a");
  });

  /**
   * The preset's prompt names "the woman" in each picture, so it assumes one
   * subject. With two there is no way to say which face belongs where, and
   * swapping the wrong one is worse than not swapping.
   */
  it("declines when more than one character opts in", () => {
    const subject = faceSwapSubject([
      character({ id: "a", faceSwap: true, referenceImages: ["a.jpg"] }),
      character({ id: "b", name: "Other", faceSwap: true, referenceImages: ["b.jpg"] }),
    ]);
    expect(subject).toBeNull();
  });

  it("declines when nobody opts in", () => {
    expect(faceSwapSubject([character({ referenceImages: ["a.jpg"] })])).toBeNull();
    expect(faceSwapSubject([])).toBeNull();
  });
});

describe("the face-swap preset", () => {
  /**
   * The prompt, LoRA pair, strengths and step count are a matched set carried
   * over from a proven recipe: the head LoRA expects the Lightning schedule, and
   * the multipliers are positional. Drift here is silent, so it is pinned.
   */
  it("keeps the LoRA order and multipliers aligned", () => {
    // The accelerator must stay a full URL: it lives in `loras_accelerators`,
    // not the model's lora folder, so a bare filename does not resolve.
    expect(FACE_SWAP_SETTINGS.activated_loras).toEqual([
      "https://huggingface.co/DeepBeepMeep/Qwen_image/resolve/main/loras_accelerators/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
      "bfs_head_v5_2511_merged_version_rank_16_fp16.safetensors",
    ]);
    expect(FACE_SWAP_SETTINGS.loras_multipliers).toBe("0.8 0.5");
    expect(FACE_SWAP_LORAS.map((l) => l.strength)).toEqual([0.8, 0.5]);
  });

  it("runs the four-step Lightning schedule", () => {
    expect(FACE_SWAP_SETTINGS.num_inference_steps).toBe(4);
    expect(FACE_SWAP_SETTINGS.sample_solver).toBe("lightning");
    expect(FACE_SWAP_SETTINGS.guidance_scale).toBe(1);
  });

  /** "IV" is what activates the reference alongside the guide image. */
  it("sets the activating prompt-type letters and strips the reference background", () => {
    expect(FACE_SWAP_SETTINGS.video_prompt_type).toBe("IV");
    expect(FACE_SWAP_SETTINGS.image_prompt_type).toBe("");
    expect(FACE_SWAP_SETTINGS.remove_background_images_ref).toBe(1);
  });
});
