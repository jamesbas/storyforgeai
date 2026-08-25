import { describe, expect, it } from "vitest";

import { faceSwapImageSettings } from "@/lib/wangp/face-swap-preset";

/**
 * Wan2GP changed how a Qwen edit model is given its source image.
 *
 * The older definition takes the frame in `image_guide` and marks the pairing
 * with `video_prompt_type: "IV"`. The current one drops `image_guide` and reads
 * an ordered `image_refs`, where `"KI"` means the first entry is the subject.
 *
 * Choosing on what the model declares is what matters: WanGP only sets fields a
 * model's schema declares, so sending `image_guide` to a definition that has
 * dropped it is silently discarded — the swap then runs on the face reference
 * alone, which still returns a picture, just of the wrong shot.
 */
describe("giving a face-swap model its source frame", () => {
  const frame = "C:/frames/scene-3-start.png";
  const face = "C:/cast/mara.png";

  it("uses the guide field when the model declares it", () => {
    const settings = faceSwapImageSettings(frame, face, true);
    expect(settings.image_guide).toBe(frame);
    expect(settings.image_refs).toEqual([face]);
    expect(settings.video_prompt_type).toBe("IV");
  });

  it("puts the frame first in the ordered references when it does not", () => {
    const settings = faceSwapImageSettings(frame, face, false);
    expect(settings.image_refs).toEqual([frame, face]);
    expect(settings.video_prompt_type).toBe("KI");
  });

  it("does not send a guide field the model has dropped", () => {
    // Sending it is not harmless-but-ignored: it is dropped in silence, and the
    // frame it carried is then missing from the job entirely.
    expect(faceSwapImageSettings(frame, face, false)).not.toHaveProperty("image_guide");
  });

  it("keeps the frame ahead of the face in either contract", () => {
    // Order is the whole meaning of "KI" — first entry is the shot being
    // edited, the rest are people to place into it.
    const ordered = faceSwapImageSettings(frame, face, false).image_refs as string[];
    expect(ordered[0]).toBe(frame);
  });
});
