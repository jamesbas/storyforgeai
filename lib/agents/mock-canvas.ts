import type { Project } from "@/lib/schemas/project";
import type { VariantType } from "@/lib/types";
import type {
  ArtDirectionPlan,
  CinematographyPlan,
  CreativeVariant,
  DirectorialPlan,
  WorldBible,
} from "@/lib/schemas/canvas";

/**
 * Deterministic mock builders for the Agentic Canvas artifacts (spec Section 2A).
 * Each has an LLM-backed counterpart that must emit the same shape (parity).
 */

/**
 * The axes the deterministic set offers, and the order it offers them in.
 *
 * They are complementary on purpose: `story` changes what happens, `hook`
 * changes only the way in, `visual_style` changes only the look. Three
 * directions that all changed the premise would be one idea in three moods,
 * which is not a choice — and that is exactly what this builder used to return,
 * labelling all three `concept`.
 */
export const DETERMINISTIC_AXES = ["story", "hook", "visual_style"] as const satisfies readonly VariantType[];

/** First sentence of the concept, so a direction reads as being about this project. */
function conceptGist(concept: string, limit = 120): string {
  const cleaned = concept.trim().replace(/\s+/g, " ");
  const sentence = cleaned.split(/(?<=[.!?])\s/)[0] ?? cleaned;
  const gist = sentence.length <= limit ? sentence : `${cleaned.slice(0, limit).trimEnd()}…`;
  return gist.replace(/[.!?…]+$/, "");
}

export function buildVariants(project: Project): CreativeVariant[] {
  const now = new Date().toISOString();
  const gist = conceptGist(project.concept);

  // The two things a direction can hold still. Whichever axis a variant owns is
  // the only one of these it is allowed to depart from.
  const straightAngle = `Tell ${gist} straight: the person it happens to, in the order it happens.`;
  const plainOpening = "Open on the situation and let it establish itself before anything moves.";
  const baseLook = `${project.style}, naturalistic lighting, ${project.tone} palette`;

  const directions: Array<{
    axis: VariantType;
    name: string;
    summary: string;
    hook: string;
    storyAngle: string;
    visualStyle: string;
    platform: string;
    strengths: string[];
    risks: string[];
  }> = [
    {
      axis: "story",
      name: "Whose Story It Is",
      summary:
        "Changes what happens and who it happens to. Same subject, a different piece of it.",
      // Only this direction departs from the straight telling.
      storyAngle: `Follow someone on the edge of ${gist} rather than at the centre of it, and end on the consequence rather than the event.`,
      hook: plainOpening,
      visualStyle: baseLook,
      platform: "youtube_16x9",
      strengths: ["a point of view the obvious version does not have", "an ending that lands"],
      risks: [
        "Gives up the literal reading of your concept — a viewer expecting the obvious version has to be won over in the first ten seconds.",
      ],
    },
    {
      axis: "hook",
      name: "Cold Open",
      summary: "Same story, entered somewhere else. Changes the way in, not the events.",
      storyAngle: straightAngle,
      // Only this direction departs from the plain opening.
      hook: `Start mid-action inside ${gist}, then double back and explain nothing for the first beat.`,
      visualStyle: baseLook,
      platform: "shorts_reels_tiktok",
      strengths: ["holds a scrolling audience", "no setup to sit through"],
      risks: [
        "Gives up the establishing beat, so anyone who needs context to care may leave before they get it.",
      ],
    },
    {
      axis: "visual_style",
      name: "Stylised Treatment",
      summary: "Same story, same opening, rendered as a different visual system.",
      storyAngle: straightAngle,
      hook: plainOpening,
      // Only this direction departs from the base look.
      visualStyle: `${project.style}, high-contrast stylised palette, graphic shapes and hard shadows over naturalism`,
      platform: "social_campaign",
      strengths: ["memorable at a glance", "a look that survives a thumbnail"],
      risks: [
        "Gives up realism, so anything the style flattens — faces, small gestures, fine detail — stops carrying the story.",
      ],
    },
  ];

  return directions.map((d, i) => ({
    id: `${project.id}-variant-${i + 1}`,
    projectId: project.id,
    name: d.name,
    variantType: d.axis,
    summary: d.summary,
    hook: d.hook,
    storyAngle: d.storyAngle,
    visualStyle: d.visualStyle,
    bestFitPlatform: d.platform,
    strengths: d.strengths,
    risks: d.risks,
    selected: false,
    createdByAgent: "Variant Explorer",
    createdAt: now,
  }));
}

export function buildWorldBible(project: Project): WorldBible {
  return {
    projectId: project.id,
    premise: `The world of "${project.concept.trim()}" rendered in a ${project.style} style.`,
    universeRules: ["Internal logic stays consistent across all scenes."],
    timelineRules: ["Events proceed in a clear chronological order."],
    locations: [{ name: "Primary Location", description: "Recurring anchor environment." }],
    factionsOrGroups: [],
    characterRelationships: ["Primary subject drives the through-line."],
    recurringMotifs: ["A signature visual motif recurs across scenes."],
    visualAnchors: [`${project.style} palette and framing`],
    continuityConstraints: ["Wardrobe, identity, and lighting remain consistent."],
    forbiddenContradictions: ["No unexplained changes to the subject or world."],
  };
}

function perSceneRecord(project: Project, value: (n: number) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let n = 1; n <= project.segmentCount; n += 1) out[String(n)] = value(n);
  return out;
}

export function buildDirectorialPlan(project: Project): DirectorialPlan {
  return {
    projectId: project.id,
    creativeThesis: `Deliver "${project.concept.trim()}" with a ${project.tone} emotional core.`,
    pacingStrategy: "Steady build across segments with a clear payoff.",
    emotionalArc: ["setup", "development", "payoff"],
    performanceDirection: ["Keep performances grounded and legible."],
    sceneIntent: perSceneRecord(project, (n) => `Intent for scene ${n}: advance the beat clearly.`),
    approvalNotes: ["Confirm pacing before generation."],
  };
}

export function buildCinematographyPlan(project: Project): CinematographyPlan {
  return {
    projectId: project.id,
    cameraLanguage: "Motivated moves; stable, purposeful framing.",
    lensAndFramingRules: ["Favor mid and wide shots for clarity."],
    movementRules: ["Slow push-ins for emphasis; lateral tracking for motion."],
    lightingRules: ["Consistent key direction and color temperature."],
    sceneShotPlans: perSceneRecord(project, (n) =>
      n % 2 === 0 ? "Slow push-in on the subject." : "Gentle lateral tracking shot.",
    ),
    transitionLanguage: ["Cut on action; fade at the open and close."],
  };
}

export function buildArtDirectionPlan(project: Project): ArtDirectionPlan {
  return {
    projectId: project.id,
    productionDesign: `${project.style} production design supporting the concept.`,
    wardrobeRules: ["Consistent wardrobe per character across scenes."],
    propRules: ["Signature prop recurs to reinforce the motif."],
    setDressingRules: ["Keep set dressing coherent with the palette."],
    typographyRules: [],
    productPlacementRules: [],
  };
}
