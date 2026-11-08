import { storyCharacters } from "@/lib/agents/cast";
import type { VisualBible } from "@/lib/schemas/agents";
import type { Character } from "@/lib/schemas/character";
import type { Scene } from "@/lib/schemas/storyboard";

/**
 * What a reviewer needs beside the scene card to judge a scene.
 *
 * The QC agent was asked to report subject drift and continuity with the
 * previous scene while being handed neither: only the scene card and its
 * prompts. A card names "Leroy" and says nothing of what he looks like, so a
 * render of the wrong man could pass, and "the previous scene" was a phrase in
 * the instructions with nothing behind it. Shared by QC and the scene check so
 * both judge against the same people.
 */

export type ReviewPerson = {
  name: string;
  /** Stable appearance: the library description, or a story character's identity. */
  description: string;
  source: "library" | "visual_bible";
  /** The frames the card puts them in; empty when the card does not say. */
  frames: ("start" | "end")[];
};

export type NeighbourScene = {
  sceneNumber: number;
  title: string;
  actionDescription: string;
  /** The frame that touches this scene: the previous scene's end, or the next one's start. */
  touchingFramePrompt: string;
};

function framesOf(scene: Scene, name: string): ("start" | "end")[] {
  const lower = name.toLocaleLowerCase();
  return (["start", "end"] as const).filter((frame) =>
    scene.frameVisibility?.[frame]?.some((person) => person.toLocaleLowerCase() === lower));
}

/** Everyone the scene shows, with the appearance they must keep. */
export function peopleInScene(
  scene: Scene,
  cast: readonly Character[],
  bible: Pick<VisualBible, "characters"> | undefined,
): ReviewPerson[] {
  const visible = new Set([
    ...(scene.charactersPresent ?? []),
    ...(scene.frameVisibility?.start ?? []),
    ...(scene.frameVisibility?.end ?? []),
  ].map((name) => name.toLocaleLowerCase()));
  const shown = (name: string) => visible.has(name.toLocaleLowerCase());

  const library = cast.filter((person) => shown(person.name)).map((person): ReviewPerson => ({
    name: person.name,
    description: [person.description, person.facialDescription].filter(Boolean).join(" ").trim(),
    source: "library",
    frames: framesOf(scene, person.name),
  }));
  const story = storyCharacters(bible, cast).filter((person) => shown(person.name))
    .map((person): ReviewPerson => ({
      name: person.name,
      description: person.identity,
      source: "visual_bible",
      frames: framesOf(scene, person.name),
    }));
  return [...library, ...story];
}

/** The scenes either side of this one, as far as they touch it. */
export function neighboursOf(
  scenes: readonly Scene[],
  sceneId: string,
): { previous?: NeighbourScene; next?: NeighbourScene } {
  const index = scenes.findIndex((scene) => scene.id === sceneId);
  if (index < 0) return {};
  const summary = (scene: Scene | undefined, frame: "start" | "end"): NeighbourScene | undefined =>
    scene && {
      sceneNumber: scene.sceneNumber,
      title: scene.title,
      actionDescription: scene.actionDescription,
      touchingFramePrompt: frame === "end" ? scene.prompts.endFramePrompt : scene.prompts.startFramePrompt,
    };
  return { previous: summary(scenes[index - 1], "end"), next: summary(scenes[index + 1], "start") };
}
