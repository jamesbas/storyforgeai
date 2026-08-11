import type { Character } from "@/lib/schemas/character";
import type { SceneDraft } from "@/lib/schemas/storyboard";

/**
 * Which pinned characters are actually in a shot.
 *
 * The cast sheet, the reference photographs and the face swap were all applied
 * per project rather than per scene, so a scene of four men at a poker table
 * received two hundred words describing a woman who is not in it, her
 * photograph as a reference image, and her face as a swap target. The agents
 * were already told to "name a cast character only in the prompts for shots
 * they actually appear in" — the appending code simply had no way to know.
 */

/** Text on a scene card that would mention someone who is in it. */
function sceneText(scene: SceneSubject): string {
  return [
    scene.title,
    scene.sceneObjective,
    scene.storyBeat,
    scene.visualDescription,
    scene.actionDescription,
    ...(scene.dialogue ?? []).map((line) => `${line.character} ${line.line}`),
    ...(scene.continuityNotes ?? []),
  ]
    .filter(Boolean)
    .join(" ");
}

type SceneSubject = Pick<
  SceneDraft,
  | "title"
  | "sceneObjective"
  | "storyBeat"
  | "visualDescription"
  | "actionDescription"
  | "dialogue"
  | "continuityNotes"
> & { charactersPresent?: string[] };

function mentions(text: string, name: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

/**
 * The subset of the cast this scene should carry.
 *
 * A list declared by the Storyboard Artist is authoritative. Without one — every
 * storyboard generated before the field existed — presence is read from the
 * scene card, which works because the agents are instructed to refer to
 * characters by name.
 *
 * An empty result is a real answer, not a failure to detect: a scene that names
 * nobody from the cast is a scene they are not in.
 */
export function charactersInScene(
  scene: SceneSubject,
  cast: readonly Character[],
): readonly Character[] {
  if (cast.length === 0) return [];

  const declared = scene.charactersPresent ?? [];
  if (declared.length) {
    const wanted = new Set(declared.map((n) => n.trim().toLocaleLowerCase()));
    const matched = cast.filter((c) => wanted.has(c.name.trim().toLocaleLowerCase()));
    // A declared list naming nobody we recognise is more likely a naming slip
    // than a genuinely empty cast, so fall through to reading the card.
    if (matched.length) return matched;
  }

  const text = sceneText(scene);
  return cast.filter((character) => mentions(text, character.name));
}

/** Names the storyboard should record for a scene, given who it mentions. */
export function presentCharacterNames(
  scene: SceneSubject,
  cast: readonly Character[],
): string[] {
  return charactersInScene(scene, cast).map((c) => c.name);
}

/**
 * The subset of a scene's cast that one frame prompt actually frames.
 *
 * Presence is read from the scene card, but the sheet is appended to a frame,
 * and the two disagree routinely: a card that seats a watcher in the corner
 * chair is still a card the cinematographer may frame out, and a card that
 * never mentions him is one a wider shot may put him back into.
 *
 * Describing someone the frame excludes is not a harmless extra: the sheet is
 * the last thing the image model reads and it ends on "wearing exactly", so a
 * character who is not in shot donates his clothes to whoever is.
 *
 * Falls back to the scene cast when the prompt names nobody — a prompt can
 * describe people without naming them ("one woman and one man"), and an empty
 * sheet would drop face continuity altogether.
 */
export function charactersInFrame(
  prompt: string,
  sceneCast: readonly Character[],
): readonly Character[] {
  const named = sceneCast.filter((character) => mentions(prompt, character.name));
  return named.length ? named : sceneCast;
}
