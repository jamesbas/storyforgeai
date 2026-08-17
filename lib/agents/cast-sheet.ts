import { castContinuityClause, castPromptSuffix } from "@/lib/agents/cast";
import { charactersInFrame, charactersInScene } from "@/lib/agents/scene-cast";
import { othersInFrame, othersWardrobeSuffix, wardrobeChangeClause } from "@/lib/agents/wardrobe";
import { isTightShot } from "@/lib/media/seam";
import type { Character } from "@/lib/schemas/character";
import type { Scene } from "@/lib/schemas/storyboard";
import type { SceneWardrobe } from "@/lib/schemas/wardrobe";

/**
 * Rebuild the parts of a stored prompt that were appended rather than written.
 *
 * The cast sheet, the wardrobe line and the clip's continuity clause are all
 * derived from the cast and the wardrobe timeline, so they can be recomputed
 * from scratch and swapped in without touching a word the agent wrote — no
 * model, no regeneration. That is what makes a costume change applied after the
 * prompts were written a mechanical repair rather than a rewrite.
 *
 * Shared so the screen that offers the repair decides it is needed by the same
 * comparison the repair itself performs.
 */
export function rebuiltPrompts(
  scene: Scene,
  cast: readonly Character[],
  wardrobe: SceneWardrobe | undefined,
): { startFramePrompt: string; endFramePrompt: string; videoPromptSegment: string } {
  const sceneCast = charactersInScene(scene, cast);
  return {
    startFramePrompt: withCastSheet(
      scene.prompts.startFramePrompt,
      sceneCast,
      wardrobe?.start,
      wardrobe?.othersStart,
      scene,
    ),
    endFramePrompt: withCastSheet(
      scene.prompts.endFramePrompt,
      sceneCast,
      wardrobe?.end,
      wardrobe?.othersEnd,
      scene,
    ),
    videoPromptSegment: withVideoCastClause(
      scene.prompts.videoPromptSegment,
      sceneCast,
      wardrobeChangeClause(
        wardrobe?.within ?? [],
        sceneCast,
        wardrobe?.start ?? {},
        wardrobe?.othersStart ?? {},
      ),
    ),
  };
}

/** Whether any appended text on this scene no longer matches the cast or wardrobe. */
export function sheetIsStale(
  scene: Scene,
  cast: readonly Character[],
  wardrobe: SceneWardrobe | undefined,
): boolean {
  const next = rebuiltPrompts(scene, cast, wardrobe);
  return (
    next.startFramePrompt !== scene.prompts.startFramePrompt ||
    next.endFramePrompt !== scene.prompts.endFramePrompt ||
    next.videoPromptSegment !== scene.prompts.videoPromptSegment
  );
}

function withCastSheet(
  prompt: string,
  sceneCast: readonly Character[],
  wardrobeAt: Record<string, string> | undefined,
  others: Record<string, string> | undefined,
  scene: Scene,
): string {
  const marker = " Character continuity — ";
  const cut = prompt.indexOf(marker);
  const body = cut >= 0 ? prompt.slice(0, cut) : stripOthers(prompt);
  const options = {
    faceVisible: scene.subjectFaceVisible !== false,
    tightShot: isTightShot(body),
  };
  const frameCast = charactersInFrame(body, sceneCast);
  return `${body}${castPromptSuffix(frameCast, wardrobeAt, options, body)}${othersWardrobeSuffix(othersInFrame(body, others ?? {}))}`;
}

function stripOthers(prompt: string): string {
  const marker = " Wardrobe continuity — ";
  const cut = prompt.indexOf(marker);
  return cut >= 0 ? prompt.slice(0, cut) : prompt;
}

/**
 * Two markers because the format changed: prompts written before the clip
 * stopped re-describing the cast end with the full sheet, later ones with the
 * short preservation clause.
 */
function withVideoCastClause(
  prompt: string,
  sceneCast: readonly Character[],
  change: string,
): string {
  const markers = [" Character continuity — ", " The start frame fixes how "];
  let body = prompt;
  for (const marker of markers) {
    const cut = body.indexOf(marker);
    if (cut >= 0) body = body.slice(0, cut);
  }
  return `${body}${castContinuityClause(sceneCast, change)}`;
}
