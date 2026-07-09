import type { Project } from "@/lib/schemas/project";
import type { CreativeBrief, StoryPlan, VisualBible } from "@/lib/schemas/agents";
import type { ScenePrompts, SceneDraft } from "@/lib/schemas/storyboard";

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
      `${project.segmentCount} fixed 20-second segments`,
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

export function buildVisualBible(project: Project): VisualBible {
  return {
    projectId: project.id,
    artDirection: `${project.style} art direction with cohesive framing and deliberate composition.`,
    colorPalette: ["#1b2430", "#e8e2d5", "#c9a227", "#3b6fb0"],
    lightingRules: [
      "Motivated key light with soft fill",
      "Preserve consistent color temperature across scenes",
    ],
    cameraStyle: "Cinematic lensing, stable moves, purposeful framing",
    characters: [{ name: "Primary Subject", description: "Consistent wardrobe and identity across all scenes." }],
    locations: [{ name: "Primary Location", description: "Recurring establishing environment for continuity." }],
    props: [{ name: "Signature Prop", description: "Recurring motif reinforcing the concept." }],
    negativeRules: [
      "no watermarks",
      "no distorted anatomy",
      "no text artifacts",
      "no flicker or warping",
    ],
  };
}

export function buildSceneDrafts(
  project: Project,
  storyPlan: StoryPlan,
  _brief: CreativeBrief,
  _visualBible: VisualBible,
): SceneDraft[] {
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

    drafts.push({
      id: `${project.id}-scene-${String(sceneNumber).padStart(3, "0")}`,
      projectId: project.id,
      sceneNumber,
      startTimeSeconds,
      endTimeSeconds,
      targetDurationSeconds: 20,
      trimAtEndSeconds,
      title: `Scene ${sceneNumber}`,
      sceneObjective:
        sceneNumber === 1
          ? "Open the story and orient the viewer."
          : isLast
            ? "Deliver the resolution and payoff."
            : `Advance beat ${sceneNumber} of the narrative.`,
      storyBeat: storyPlan.segmentBeats[i] ?? `Beat ${sceneNumber} of ${project.segmentCount}.`,
      visualDescription: `${project.style} visualization of "${project.concept.trim()}" for beat ${sceneNumber}.`,
      actionDescription: `Primary subject action develops over the 20-second segment for beat ${sceneNumber}.`,
      cameraMovement: sceneNumber % 2 === 0 ? "Slow push-in" : "Gentle lateral tracking",
      transitionIn: sceneNumber === 1 ? "Fade in" : "Cut",
      transitionOut: isLast ? "Fade out" : "Cut",
      continuityNotes: ["Maintain subject identity", "Match lighting and palette"],
      narrationText: project.narrationRequired ? `Narration cue for scene ${sceneNumber}.` : undefined,
      musicNotes: project.musicRequired ? "Underscore supporting the beat." : undefined,
      sfxNotes: project.sfxRequired ? "Ambient and accent SFX as needed." : undefined,
      status: "planned",
    });
  }
  return drafts;
}

export function buildImagePrompts(
  project: Project,
  scene: SceneDraft,
): Pick<ScenePrompts, "startFramePrompt" | "endFramePrompt" | "imageNegativePrompt"> {
  const isLast = scene.sceneNumber === project.segmentCount;
  return {
    startFramePrompt:
      `Cinematic still, first frame of scene ${scene.sceneNumber}. ${project.style} style, ` +
      `${project.tone} mood. Subject: ${project.concept.trim()}. Consistent characters, wardrobe, ` +
      `and lighting per the visual bible.`,
    endFramePrompt:
      `Cinematic still, final frame of scene ${scene.sceneNumber}. Logical continuation of the ` +
      `start frame${isLast ? " and a resolving beat" : `, setting up scene ${scene.sceneNumber + 1}`}. ` +
      `${project.style} style.`,
    imageNegativePrompt: "no watermarks, no distorted anatomy, no text artifacts, low quality",
  };
}

export function buildVideoPrompts(
  project: Project,
  scene: SceneDraft,
): Pick<ScenePrompts, "videoPrompt20s" | "videoNegativePrompt" | "promptQualityChecklist"> {
  return {
    videoPrompt20s:
      `20-second video scene ${scene.sceneNumber}. Start from the provided start frame and preserve ` +
      `subject identity, wardrobe, location, and lighting. Motion and camera evolve toward the end ` +
      `frame. Style: ${project.style}. Tone/pacing: ${project.tone}.`,
    videoNegativePrompt: "no flicker, no warping, no duplicated subjects, no abrupt cuts",
    promptQualityChecklist: [
      "continuity with visual bible",
      "clear subject and action",
      "start-to-end evolution described",
      "negative prompt present",
    ],
  };
}
