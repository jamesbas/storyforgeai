import type { Project } from "@/lib/schemas/project";
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

export function buildVariants(project: Project): CreativeVariant[] {
  const now = new Date().toISOString();
  const directions: Array<{ name: string; hook: string; angle: string; style: string; platform: string }> = [
    {
      name: "Grounded & Cinematic",
      hook: "Open on a striking, quiet image that poses the central question.",
      angle: "Character-first, realistic tone.",
      style: `${project.style}, naturalistic lighting`,
      platform: "youtube_16x9",
    },
    {
      name: "High-Energy Hook",
      hook: "Start mid-action with an immediate pattern interrupt.",
      angle: "Fast, punchy, momentum-driven.",
      style: `${project.style}, high-contrast, kinetic`,
      platform: "shorts_reels_tiktok",
    },
    {
      name: "Stylized & Bold",
      hook: "Lead with a surreal, memorable visual motif.",
      angle: "Concept-forward and distinctive.",
      style: `${project.style}, stylized palette`,
      platform: "social_campaign",
    },
  ];

  return directions.map((d, i) => ({
    id: `${project.id}-variant-${i + 1}`,
    projectId: project.id,
    name: d.name,
    variantType: "concept" as const,
    summary: `${d.angle} ${d.hook}`,
    hook: d.hook,
    storyAngle: d.angle,
    visualStyle: d.style,
    bestFitPlatform: d.platform,
    strengths: ["clear point of view", "distinct tone"],
    risks: ["needs strong execution to land"],
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
