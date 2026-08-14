import type { Project } from "@/lib/schemas/project";
import type { CreativeBrief, StoryPlan, VisualBible } from "@/lib/schemas/agents";
import type { ScenePrompts, SceneDraft } from "@/lib/schemas/storyboard";
import type { Character } from "@/lib/schemas/character";
import { castContinuityClause, castNegativeSuffix, castPromptSuffix } from "@/lib/agents/cast";
import { wardrobeChangeClause, othersWardrobeSuffix } from "@/lib/agents/wardrobe";
import { isTightShot } from "@/lib/media/seam";
import type { SheetOptions } from "@/lib/agents/cast";
import type { SceneWardrobe } from "@/lib/schemas/wardrobe";
import { isContinuousTake } from "@/lib/agents/continuity";
import { isExplicitProject, isExplicitScene } from "@/lib/agents/explicitness";
import { lookPromptSuffix } from "@/lib/agents/look";
import { normaliseNegative } from "@/lib/agents/negative-prompt";
import {
  continuityNegativeSuffix,
  globalStyleSuffix,
  sceneCreativeSlice,
  sceneDirectionSuffix,
  type CreativePlans,
} from "@/lib/agents/creative-context";
import { config } from "@/lib/config";
import type { ModelFamily } from "@/lib/wangp/family";
import { buildMediaPromptSpec } from "@/lib/agents/media-prompt-builder";
import { renderImagePrompt, renderVideoPrompt } from "@/lib/agents/media-prompt-renderers";
import { hasNativeAudio } from "@/lib/agents/model-directives";

/**
 * Deterministic mock builders backing each agent. They produce schema-valid
 * artifacts with no external dependencies so the app runs fully local (spec
 * Section 22, "stub the agents first with deterministic test responses"). The
 * LLM-backed path must produce the same artifact shapes (parity).
 */

function titleCase(input: string): string {
  return input
    .split(/\s+/)
    .slice(0, 8)
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function deriveTitle(concept: string): string {
  const cleaned = concept.trim().replace(/[\r\n]+/g, " ");
  const title = titleCase(cleaned);
  return title.length > 0 ? title : "Untitled Project";
}

/**
 * The opening of a concept, for scene cards that need the setting without the
 * whole brief.
 *
 * Pasting the full concept into all fifteen scenes made every card read
 * identically, which is indistinguishable from a bug — and it drowned the one
 * line that actually described the shot.
 */
function conceptGist(concept: string, limit = 180): string {
  const cleaned = concept.trim().replace(/\s+/g, " ");
  const sentence = cleaned.split(/(?<=[.!?])\s/)[0] ?? cleaned;
  const gist = sentence.length <= limit ? sentence : `${cleaned.slice(0, limit).trimEnd()}…`;
  return /[.!?…]$/.test(gist) ? gist : `${gist}.`;
}

/** A scene title taken from its beat, so cards are distinguishable at a glance. */
function beatTitle(beat: string, sceneNumber: number): string {
  const clause = beat.trim().split(/[.;:—]/)[0]?.trim() ?? "";
  const title = titleCase(clause);
  return title.length > 0 ? title : `Scene ${sceneNumber}`;
}

export function buildCreativeBrief(project: Project): CreativeBrief {
  return {
    projectId: project.id,
    logline: `A ${project.tone} ${project.style} piece: ${project.concept.trim()}`.slice(0, 240),
    synopsis:
      `${project.title} explores "${project.concept.trim()}" across ${project.segmentCount} ` +
      `beats, delivered in a ${project.style} style with a ${project.tone} tone for a ` +
      `${project.audience ?? "general"} audience.`,
    narrativeArc: {
      beginning: "Establish the world, the subject, and the central question.",
      middle: "Escalate stakes and develop the core idea through rising action.",
      end: "Resolve the arc and land the intended emotional payoff.",
    },
    visualStyle: project.style,
    tone: project.tone,
    audience: project.audience ?? "general",
    constraints: [
      `Target runtime ~${project.requestedDurationSeconds}s`,
      `${project.segmentCount} fixed ${project.segmentSeconds}-second segments`,
      `Aspect ratio ${project.aspectRatio}`,
    ],
  };
}

export function buildStoryPlan(project: Project): StoryPlan {
  const segmentBeats: string[] = [];
  const emotionalProgression: string[] = [];
  for (let i = 0; i < project.segmentCount; i += 1) {
    const n = i + 1;
    const isFirst = n === 1;
    const isLast = n === project.segmentCount;
    segmentBeats.push(
      isFirst
        ? "Open the story and orient the viewer."
        : isLast
          ? "Deliver the resolution and payoff."
          : `Advance beat ${n} of the narrative and raise the stakes.`,
    );
    emotionalProgression.push(isFirst ? "curiosity" : isLast ? "resolution" : "rising tension");
  }
  return {
    projectId: project.id,
    title: project.title,
    logline: `A ${project.tone} ${project.style} piece: ${project.concept.trim()}`.slice(0, 240),
    emotionalProgression,
    segmentBeats,
  };
}

export function buildVisualBible(
  project: Project,
  cast: readonly Character[] = [],
  plans?: CreativePlans,
): VisualBible {
  // A pinned cast replaces the generic placeholder subject entirely — the point
  // of pinning is that the described person is the one on screen.
  const characters =
    cast.length > 0
      ? cast.map((c) => ({ name: c.name, description: c.description }))
      : [
          {
            name: "Primary Subject",
            description: "Consistent wardrobe and identity across all scenes.",
          },
        ];

  // Approved plans outrank the generic defaults, in the documented precedence
  // order: character library, then Visual Bible, then the canvas plans.
  const locations = plans?.worldBible?.locations.length
    ? plans.worldBible.locations
    : [{ name: "Primary Location", description: "Recurring establishing environment for continuity." }];

  return {
    projectId: project.id,
    artDirection:
      plans?.artDirectionPlan?.productionDesign ??
      `${project.style} art direction with cohesive framing and deliberate composition.`,
    colorPalette: ["#1b2430", "#e8e2d5", "#c9a227", "#3b6fb0"],
    lightingRules: plans?.cinematographyPlan?.lightingRules.length
      ? plans.cinematographyPlan.lightingRules
      : [
          "Motivated key light with soft fill",
          "Preserve consistent color temperature across scenes",
        ],
    cameraStyle:
      plans?.cinematographyPlan?.cameraLanguage ??
      "Cinematic lensing, stable moves, purposeful framing",
    characters,
    locations,
    props: [{ name: "Signature Prop", description: "Recurring motif reinforcing the concept." }],
    negativeRules: [
      "watermarks",
      "distorted anatomy",
      "text artifacts",
      "flicker or warping",
      ...(plans?.worldBible?.forbiddenContradictions ?? []),
    ],
  };
}

export function buildSceneDrafts(
  project: Project,
  storyPlan: StoryPlan,
  _brief: CreativeBrief,
  _visualBible: VisualBible,
  cast: readonly Character[] = [],
  plans?: CreativePlans,
): SceneDraft[] {
  // Scene cards name the pinned lead so downstream prompts and reviewers refer
  // to the same person rather than an anonymous "subject".
  const lead = cast[0]?.name ?? "The subject";
  const speaker = cast[0]?.name ?? "Lead";
  const drafts: SceneDraft[] = [];
  for (let i = 0; i < project.segmentCount; i += 1) {
    const sceneNumber = i + 1;
    const isLast = sceneNumber === project.segmentCount;
    const startTimeSeconds = i * project.segmentSeconds;
    const endTimeSeconds = startTimeSeconds + project.segmentSeconds;
    const trimAtEndSeconds =
      isLast && project.finalTrimSeconds > 0
        ? project.segmentSeconds - project.finalTrimSeconds
        : undefined;

    // The Director owns scene intent and the Cinematographer owns the shot, so
    // an approved plan overrides the generic defaults for both.
    const slice = sceneCreativeSlice(plans, { id: "", sceneNumber });

    // The beat is the one genuinely per-scene input this builder has, so every
    // descriptive field is written from it rather than from the shared concept.
    const rawBeat = storyPlan.segmentBeats[i]?.trim() ?? "";
    const beat = rawBeat || `Beat ${sceneNumber} of ${project.segmentCount}.`;
    const emotion = storyPlan.emotionalProgression[i] ?? "rising tension";
    const phase =
      sceneNumber === 1
        ? "Establishes the situation and the people in it"
        : isLast
          ? "Closes on the final beat and its aftermath"
          : "Carries the situation further than the scene before it";

    drafts.push({
      id: `${project.id}-scene-${String(sceneNumber).padStart(3, "0")}`,
      projectId: project.id,
      wardrobeChanges: [],
      charactersPresent: cast.map((c) => c.name),
      sceneNumber,
      startTimeSeconds,
      endTimeSeconds,
      targetDurationSeconds: project.segmentSeconds,
      trimAtEndSeconds,
      // The builder has only a beat to go on, so it assumes the face is in
      // frame; the planning model decides properly when one is available.
      subjectFaceVisible: true,
      title: rawBeat ? beatTitle(rawBeat, sceneNumber) : `Scene ${sceneNumber}`,
      sceneObjective:
        slice.intent ??
        (sceneNumber === 1
          ? "Open the story and orient the viewer."
          : isLast
            ? "Deliver the resolution and payoff."
            : `Advance beat ${sceneNumber} of the narrative.`),
      storyBeat: beat,
      visualDescription:
        `${sentence(beat)}${phase}, with ${emotion} in the performances. ` +
        `Set within: ${conceptGist(project.concept)}`,
      actionDescription:
        `${lead} plays this beat: ${sentence(beat).trim()} ` +
        (sceneNumber === 1
          ? "The central tension is revealed through what they do."
          : isLast
            ? "The tension releases as the story lands."
            : "The stakes visibly rise."),
      cameraMovement:
        slice.shotPlan ?? (sceneNumber % 2 === 0 ? "Slow push-in" : "Gentle lateral tracking"),
      // A segment boundary is a technical join, so it is only a cut when the
      // project says its scenes are separate shots.
      transitionIn: sceneNumber === 1 ? "Fade in" : isContinuousTake(project) ? "Continuous" : "Cut",
      transitionOut: isLast ? "Fade out" : isContinuousTake(project) ? "Continuous" : "Cut",
      continuityNotes: [
        cast.length > 0
          ? `Maintain ${cast.map((c) => c.name).join(" and ")} exactly as described in the character library`
          : "Maintain subject identity",
        "Match lighting and palette",
        ...(plans?.worldBible?.continuityConstraints ?? []).slice(0, 2),
      ],
      narrationText: project.narrationRequired ? `Narration cue for scene ${sceneNumber}.` : undefined,
      dialogue: project.dialogueRequired
        ? [
            {
              character: speaker,
              line:
                sceneNumber === 1
                  ? "We can't keep pretending everything is fine."
                  : isLast
                    ? "Then we decide now, together."
                    : `We need to talk about this.`,
            },
          ]
        : undefined,
      musicNotes: project.musicRequired ? "Underscore supporting the beat." : undefined,
      sfxNotes: project.sfxRequired ? "Ambient and accent SFX as needed." : undefined,
      status: "planned",
    });
  }
  return drafts;
}

/**
 * Render dialogue the way LTX-2 expects it: spoken lines quoted inline in the
 * prose of the shot description, not as a separate script block. This matches
 * the prompt format shipped in WanGP's own LTX-2 model defaults, and is how
 * spoken audio reaches the clip — nothing here is synthesized separately.
 */
function dialogueProse(scene: SceneDraft): string {
  if (!scene.dialogue?.length) return "";
  return (
    " " +
    scene.dialogue
      .map((d) => `${d.character} says, "${d.line.replace(/"/g, "'")}"`)
      .join(" ") +
    " Lip movement matches the spoken words."
  );
}

function sentence(text: string | undefined): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? `${trimmed} ` : `${trimmed}. `;
}

function sheetOptions(scene: SceneDraft, prompt: string): SheetOptions {
  return { faceVisible: scene.subjectFaceVisible !== false, tightShot: isTightShot(prompt) };
}

export function buildImagePrompts(
  project: Project,
  scene: SceneDraft,
  cast: readonly Character[] = [],
  plans?: CreativePlans,
  wardrobe?: SceneWardrobe,
  family: ModelFamily = "unknown",
): Pick<ScenePrompts, "startFramePrompt" | "endFramePrompt" | "imageNegativePrompt"> {
  const isLast = scene.sceneNumber === project.segmentCount;
  const direction = sceneDirectionSuffix(sceneCreativeSlice(plans, scene));
  const art = globalStyleSuffix(plans);

  // v2 opens with shot size and camera height and states each fact once; v1
  // opened with "Cinematic still" and repeated the scene description.
  const v2 = config.flags.mediaPromptComposerV2
    ? buildMediaPromptSpec(project, scene, plans, wardrobe)
    : undefined;

  // A template cannot convert an indirect description into a concrete one —
  // only the model can do that. What it can do is refuse to hide the act it was
  // handed, and say that the frame is the act rather than the mood around it.
  // Worth stating plainly, because this is what a provider failure falls back
  // to on explicit work.
  const explicit = isExplicitProject(project) || isExplicitScene(scene);
  const opening = explicit
    ? `Explicit cinematic still, the act itself in frame and fully visible. `
    : `Cinematic still. `;

  const startBody = v2
    ? renderImagePrompt(v2, { family, frame: "start" })
    : opening +
      sentence(scene.visualDescription) +
      sentence(scene.storyBeat) +
      // The start frame used to get the story beat and no action at all, so a
      // scene whose physical state lived in `actionDescription` opened generic
      // and only closed on the thing it was about.
      sentence(
        scene.actionDescription
          ? `At the first instant of the action: ${scene.actionDescription.trim().replace(/\.$/, "")}`
          : undefined,
      ) +
      `Opening framing of the shot; ${scene.cameraMovement.toLowerCase()} begins from here. ` +
      `Consistent characters, wardrobe, and location per the visual bible.`;
  const endBody = v2
    ? renderImagePrompt(v2, { family, frame: "end" })
    : opening +
      sentence(scene.visualDescription) +
      sentence(
        scene.actionDescription
          ? `At the last instant of the action: ${scene.actionDescription.trim().replace(/\.$/, "")}`
          : undefined,
      ) +
      `Closing framing after ${scene.cameraMovement.toLowerCase()}, showing the result of the action` +
      `${isLast ? " on a resolving beat" : `, setting up scene ${scene.sceneNumber + 1}`}. ` +
      // A scene that depicts a costume change is the one place the two frames are
      // meant to differ in wardrobe.
      (wardrobe?.within.length
        ? `Same characters and location as the start frame, in the changed outfit.`
        : `Same characters, wardrobe, and location as the start frame.`);

  return {
    startFramePrompt:
      startBody +
      lookPromptSuffix(project, startBody) +
      direction +
      art +
      castPromptSuffix(cast, wardrobe?.start, sheetOptions(scene, startBody)) +
      othersWardrobeSuffix(wardrobe?.othersStart ?? {}),
    endFramePrompt:
      endBody +
      lookPromptSuffix(project, endBody) +
      direction +
      art +
      castPromptSuffix(cast, wardrobe?.end, sheetOptions(scene, endBody)) +
      othersWardrobeSuffix(wardrobe?.othersEnd ?? {}),
    imageNegativePrompt: normaliseNegative(
      "watermark, distorted anatomy, text artifacts, low quality" +
        castNegativeSuffix(cast) +
        continuityNegativeSuffix(plans),
    ),
  };
}

export function buildVideoPrompts(
  project: Project,
  scene: SceneDraft,
  cast: readonly Character[] = [],
  plans?: CreativePlans,
  wardrobe?: SceneWardrobe,
  family: ModelFamily = "unknown",
): Pick<ScenePrompts, "videoPromptSegment" | "videoNegativePrompt" | "promptQualityChecklist"> {
  const spoken = dialogueProse(scene);
  const narration = scene.narrationText ? ` Voice-over: "${scene.narrationText}"` : "";
  const slice = sceneCreativeSlice(plans, scene);
  const change = wardrobeChangeClause(
    wardrobe?.within ?? [],
    cast,
    wardrobe?.start ?? {},
    wardrobe?.othersStart ?? {},
  );

  const seconds = scene.trimAtEndSeconds ?? scene.targetDurationSeconds;

  // v2 leads with the dominant action; v1 restated the static scene three times
  // and reached the camera in the fourth sentence.
  const body = config.flags.mediaPromptComposerV2
    ? renderVideoPrompt(buildMediaPromptSpec(project, scene, plans, wardrobe), {
        family,
        segmentSeconds: seconds,
        nativeAudio: hasNativeAudio(family),
      }) +
      (change
        ? ` Preserve subject identity, location, and lighting throughout.`
        : ` Preserve subject identity, wardrobe, location, and lighting throughout.`)
    : sentence(scene.visualDescription) +
      sentence(scene.actionDescription) +
      sentence(scene.storyBeat) +
      `Camera: ${scene.cameraMovement.toLowerCase()}, evolving from the start frame to the end frame ` +
      `over ${seconds} seconds.` +
      spoken +
      narration +
      (change
        ? ` Preserve subject identity, location, and lighting throughout.`
        : ` Preserve subject identity, wardrobe, location, and lighting throughout.`);

  return {
    videoPromptSegment:
      body +
      lookPromptSuffix(project, body) +
      sceneDirectionSuffix(slice) +
      globalStyleSuffix(plans) +
      castContinuityClause(cast, change),
    videoNegativePrompt: normaliseNegative(
      // Image-to-video has failure modes a still cannot have: the subject drifts
      // from the frame it started in, and the background reorganises itself
      // behind a moving camera.
      "flicker, jitter, warping, duplicated subjects, abrupt cuts, identity drift, " +
        "background deformation, unintended camera movement" +
        castNegativeSuffix(cast) +
        continuityNegativeSuffix(plans),
    ),
    promptQualityChecklist: [
      "continuity with visual bible",
      "clear subject and action",
      "start-to-end evolution described",
      ...(scene.dialogue?.length ? ["dialogue quoted inline for lip sync"] : []),
      ...(cast.length ? ["pinned character descriptions carried into the prompt"] : []),
      ...(slice.intent ? ["directorial intent applied"] : []),
      ...(slice.shotPlan ? ["cinematography shot plan applied"] : []),
      "negative prompt present",
    ],
  };
}
