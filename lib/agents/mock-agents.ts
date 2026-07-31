import type { Project } from "@/lib/schemas/project";
import type { CreativeBrief, StoryPlan, VisualBible } from "@/lib/schemas/agents";
import type { ScenePrompts, SceneDraft } from "@/lib/schemas/storyboard";
import type { Character } from "@/lib/schemas/character";
import { castContinuityClause, castNegativeSuffix, castPromptSuffix } from "@/lib/agents/cast";
import { isContinuousTake } from "@/lib/agents/continuity";
import { lookPromptSuffix } from "@/lib/agents/look";
import { normaliseNegative } from "@/lib/agents/negative-prompt";
import {
  continuityNegativeSuffix,
  globalStyleSuffix,
  sceneCreativeSlice,
  sceneDirectionSuffix,
  type CreativePlans,
} from "@/lib/agents/creative-context";

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

export function buildImagePrompts(
  project: Project,
  scene: SceneDraft,
  cast: readonly Character[] = [],
  plans?: CreativePlans,
): Pick<ScenePrompts, "startFramePrompt" | "endFramePrompt" | "imageNegativePrompt"> {
  const isLast = scene.sceneNumber === project.segmentCount;
  const castText = castPromptSuffix(cast);
  const direction = sceneDirectionSuffix(sceneCreativeSlice(plans, scene));
  const art = globalStyleSuffix(plans);

  const startBody =
    `Cinematic still. ` +
    sentence(scene.visualDescription) +
    sentence(scene.storyBeat) +
    `Opening framing of the shot; ${scene.cameraMovement.toLowerCase()} begins from here. ` +
    `Consistent characters, wardrobe, and location per the visual bible.`;
  const endBody =
    `Cinematic still. ` +
    sentence(scene.visualDescription) +
    sentence(scene.actionDescription) +
    `Closing framing after ${scene.cameraMovement.toLowerCase()}, showing the result of the action` +
    `${isLast ? " on a resolving beat" : `, setting up scene ${scene.sceneNumber + 1}`}. ` +
    `Same characters, wardrobe, and location as the start frame.`;

  return {
    startFramePrompt:
      startBody + lookPromptSuffix(project, startBody) + direction + art + castText,
    endFramePrompt: endBody + lookPromptSuffix(project, endBody) + direction + art + castText,
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
): Pick<ScenePrompts, "videoPromptSegment" | "videoNegativePrompt" | "promptQualityChecklist"> {
  const spoken = dialogueProse(scene);
  const narration = scene.narrationText ? ` Voice-over: "${scene.narrationText}"` : "";
  const slice = sceneCreativeSlice(plans, scene);

  const body =
    sentence(scene.visualDescription) +
    sentence(scene.actionDescription) +
    sentence(scene.storyBeat) +
    `Camera: ${scene.cameraMovement.toLowerCase()}, evolving from the start frame to the end frame ` +
    `over ${scene.trimAtEndSeconds ?? scene.targetDurationSeconds} seconds.` +
    spoken +
    narration +
    ` Preserve subject identity, wardrobe, location, and lighting throughout.`;

  return {
    videoPromptSegment:
      body +
      lookPromptSuffix(project, body) +
      sceneDirectionSuffix(slice) +
      globalStyleSuffix(plans) +
      castContinuityClause(cast),
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
