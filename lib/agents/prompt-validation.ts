import { gateImagePrompt, wardrobeConflicts, type ImageGateContext } from "@/lib/agents/prompt-gate";
import { framePromptBody } from "@/lib/agents/scene-cast";
import { sceneFrameParticipants } from "@/lib/agents/frame-contract";
import { fiboPromptText } from "@/lib/agents/fibo-prompt";
import type { SceneDraft } from "@/lib/schemas/storyboard";
import type { Scene } from "@/lib/schemas/storyboard";
import type { Project } from "@/lib/schemas/project";
import type { Character } from "@/lib/schemas/character";
import type { VisualBible } from "@/lib/schemas/agents";
import { frameWardrobeByName, wardrobeTimeline } from "@/lib/agents/wardrobe";
import { visibilityFromPrompts } from "@/lib/agents/frame-contract";
import { gateVideoPrompt, type VideoGateContext } from "@/lib/agents/video-prompt-gate";
import { storyCharacters } from "@/lib/agents/cast";
import { identityAnchors, missingComplexion } from "@/lib/agents/identity";

/**
 * A frame prompt that names someone without the skin tone or ethnicity their
 * description states.
 *
 * Not checked on an edit prompt: an edit keeps the faces of the frame it is
 * given, so identity travels in the picture rather than the words.
 */
export function identityWarnings(
  text: string,
  frame: "start" | "end",
  context: ImageGateContext,
): string[] {
  if (!context.identities?.length) return [];
  const visible = context.frameParticipants?.[frame].names ?? context.scene.frameVisibility?.[frame];
  return missingComplexion(text, context.identities, visible)
    .map((name) => `${frame}: identity_missing (${name})`);
}

export function imagePromptWarnings(
  text: string,
  frame: "start" | "end",
  context: ImageGateContext,
  kind: "frame" | "edit" = "frame",
): string[] {
  const prose = fiboPromptText(text);
  // A structured prompt has nowhere the composer can state a skin tone, so
  // flagging it would ask for a fix nothing can apply.
  const structured = text.trimStart().startsWith("{");
  return [
    ...gateImagePrompt(prose, frame, context).map((code) => `${frame}: ${code}`),
    ...wardrobeConflicts(prose, context.wardrobeByPerson?.[frame] ?? {}, context.knownParticipants)
      .map((message) => `${frame}: ${message}`),
    ...(kind === "frame" && !structured ? identityWarnings(prose, frame, context) : []),
  ];
}

export function basicImageContext(
  scene: SceneDraft,
  known: readonly string[],
  wardrobe: { start: Record<string, string>; end: Record<string, string> },
): ImageGateContext {
  const bible = known.map((name) => ({ name, description: "" }));
  return {
    scene, participants: [], explicit: false,
    frameParticipants: sceneFrameParticipants(scene, [], bible),
    knownParticipants: known, wardrobeByPerson: wardrobe,
  };
}

export function storedSceneImageContext(
  project: Project,
  scene: Scene,
  cast: readonly Character[],
  bible?: VisualBible,
  scenes: readonly Scene[] = [scene],
): ImageGateContext {
  const wardrobe = wardrobeTimeline(project, scenes, cast, bible).get(scene.id);
  const known = [...new Set([
    ...cast.map((person) => person.name), ...(bible?.characters ?? []).map((person) => person.name),
    ...(scene.charactersPresent ?? []), ...Object.keys(wardrobe?.othersStart ?? {}),
    ...Object.values(scene.frameVisibility ?? {}).flat(),
  ])];
  const current = scene.frameVisibility ? scene : {
    ...scene, frameVisibility: visibilityFromPrompts(scene.prompts.startFramePrompt, scene.prompts.endFramePrompt, known),
  };
  const story = storyCharacters(bible, cast);
  return {
    ...basicImageContext(current, known, {
      start: frameWardrobeByName(wardrobe, "start", cast, current.frameVisibility?.start),
      end: frameWardrobeByName(wardrobe, "end", cast, current.frameVisibility?.end),
    }),
    identities: identityAnchors([
      ...cast,
      ...story.map((person) => ({ name: person.name, description: person.identity })),
    ]),
  };
}

export function videoContextFromImage(scene: SceneDraft, context: ImageGateContext): VideoGateContext {
  return {
    scene,
    participants: [...new Set([
      ...(context.frameParticipants?.start.names ?? []), ...(context.frameParticipants?.end.names ?? []),
    ])],
    wardrobe: context.wardrobeByPerson?.start,
    allowedWardrobeChanges: [...new Set([
      ...(scene.wardrobeChanges ?? []).map((change) => change.character),
      ...Object.keys(context.wardrobeByPerson?.end ?? {}).filter((name) =>
        context.wardrobeByPerson?.start[name] !== context.wardrobeByPerson?.end[name]),
    ])],
  };
}

export function storedPromptWarnings(scene: Scene, context: ImageGateContext): string[] {
  return [...new Set([
    ...imagePromptWarnings(scene.prompts.startFramePrompt, "start", context),
    ...imagePromptWarnings(scene.prompts.endFramePrompt, "end", context),
    ...(scene.prompts.endFrameEditPrompt
      ? imagePromptWarnings(scene.prompts.endFrameEditPrompt, "end", context, "edit").map((warning) => `edit: ${warning}`) : []),
    ...(scene.prompts.videoPromptFamily === "deferred" ? [] :
      gateVideoPrompt(scene.prompts.videoPromptSegment, {
        ...videoContextFromImage(scene, context),
        startFrame: scene.prompts.startFramePrompt, endFrame: scene.prompts.endFramePrompt,
      }).map((warning) => `video: ${warning}`)),
  ])];
}
