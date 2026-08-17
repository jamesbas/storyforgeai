import { describe, it, expect } from "vitest";
import { castPromptSuffix, castSheet, describedInline } from "@/lib/agents/cast";
import { referenceImagesOf, wantsFaceSwap } from "@/lib/schemas/character";
import { faceSwapSubjects } from "@/lib/services/face-swap-service";
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
    expect(suffix).toContain(", dressed in red coat");
  });
});

/**
 * A name is not a description. A text encoder has never heard of "Elena", so a
 * name in one sentence and an appearance in an appended sheet do not corefer —
 * a live scene that placed a sleeping woman in prose and described her in the
 * sheet rendered both, a generic woman in the bed and an on-model one sitting
 * in the foreground.
 */
describe("not describing a character twice in one prompt", () => {
  const subject = character({ wardrobe: "red coat" });

  it("appends the sheet when the body only names the character", () => {
    const body = "Elena stands at the window in the background.";
    expect(castPromptSuffix([subject], undefined, {}, body)).toContain("Elena:");
  });

  it("withholds it once the body carries the description itself", () => {
    const body =
      "Elena, a tall lean woman in her thirties with shoulder-length dark curly hair, " +
      "stands at the window.";
    expect(castPromptSuffix([subject], undefined, {}, body)).toBe("");
  });

  /** One inline description must not suppress the sheet for everybody else. */
  it("still describes a character the body left out", () => {
    const body = "Elena, a tall lean woman with dark curly hair, faces Marco.";
    const suffix = castPromptSuffix(
      [subject, character({ id: "c2", name: "Marco", description: "A stocky bearded man." })],
      undefined,
      {},
      body,
    );
    expect(suffix).toContain("Marco:");
    expect(suffix).not.toContain("Elena:");
  });

  /** Without a body there is nothing to read, so the sheet is the only channel. */
  it("appends the sheet when no body is supplied", () => {
    expect(castPromptSuffix([subject])).toContain("Elena:");
  });

  /**
   * The live scene 2 body, verbatim. It describes the character in a sentence of
   * its own rather than in the clause that places her — still two mentions, and
   * still wrong — but the appended sheet would make it three, so the suffix has
   * to recognise this shape as already describing her.
   */
  it("recognises a description the agent wrote as its own sentence", () => {
    const tracey = character({
      id: "tracey",
      name: "Tracey",
      description:
        "A beautiful 52-year-old Caucasian woman, 5'4\" tall, with honey-blonde " +
        "shoulder-length voluminous wavy hair featuring lighter golden highlights and " +
        "soft layers. She wears small gold hoop earrings.",
      wardrobe: "pajama shorts and top",
    });
    const body =
      "Medium wide shot, low angle. Tracey lies in deep sleep on a bed under thick " +
      "cream-colored blankets; her eyes are closed and her expression is peaceful. " +
      "Exactly three people are in frame: one woman and two men. Tracey is a beautiful " +
      "52-year-old Caucasian woman with honey-blonde shoulder-length voluminous wavy " +
      "hair, wearing cream-colored silk pajama shorts and top. Two heavy-set black men " +
      "in their 40s wearing black cotton t-shirts and dark navy trousers are captured " +
      "mid-stride as they approach the bed.";
    expect(describedInline(body, tracey)).toBe(true);
    expect(castPromptSuffix([tracey], undefined, {}, body)).toBe("");
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

  it("returns the opted-in character", () => {
    const subjects = faceSwapSubjects([
      character({ id: "a", faceSwap: true, referenceImages: ["a.jpg"] }),
      character({ id: "b", name: "Other" }),
    ]);
    expect(subjects.map((c) => c.id)).toEqual(["a"]);
  });

  /**
   * One pass runs per character, each with its own prompt, so two opted-in
   * characters are both corrected rather than neither. Ordered by id because
   * the passes chain — the order decides the result, and a re-run of the same
   * batch has to produce the same chain.
   */
  it("returns every opted-in character, in a stable order", () => {
    const subjects = faceSwapSubjects([
      character({ id: "b", name: "Other", faceSwap: true, referenceImages: ["b.jpg"] }),
      character({ id: "a", faceSwap: true, referenceImages: ["a.jpg"] }),
    ]);
    expect(subjects.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("excludes a character with the toggle but no photo", () => {
    const subjects = faceSwapSubjects([
      character({ id: "a", faceSwap: true }),
      character({ id: "b", name: "Other", faceSwap: true, referenceImages: ["b.jpg"] }),
    ]);
    expect(subjects.map((c) => c.id)).toEqual(["b"]);
  });

  it("returns nothing when nobody opts in", () => {
    expect(faceSwapSubjects([character({ referenceImages: ["a.jpg"] })])).toEqual([]);
    expect(faceSwapSubjects([])).toEqual([]);
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
