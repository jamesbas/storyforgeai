import { worldBibleSchema, directorialPlanSchema, cinematographyPlanSchema, artDirectionPlanSchema } from "@/lib/schemas/canvas";
import { audioPlanSchema } from "@/lib/schemas/audio";
import { storyPlanSchema } from "@/lib/schemas/agents";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { ZodTypeAny } from "zod";

/**
 * What of each agent's output a person may change by hand.
 *
 * Declared rather than reflected off the schema, for two reasons. `projectId`
 * must never be editable, and `audioPlan.cues` holds generated audio with file
 * paths and approval state — hand-editing those would strand real media on
 * disk. Everything not listed here is shown read-only.
 *
 * `numbered` is an ordered list shown as "N: entry", one per segment. The arc's
 * beats need it: as a plain list, deleting one line would silently move every
 * later beat onto the segment before it. `numbers` is a list of segment numbers
 * and `number` a single one, blank for none.
 */
export type PlanFieldKind = "text" | "list" | "map" | "named" | "numbered" | "numbers" | "number";

export type PlanField = {
  key: string;
  label: string;
  kind: PlanFieldKind;
  /** Rows for a text area; ignored otherwise. */
  rows?: number;
  help?: string;
};

export type PlanSpec = {
  /** Where the plan lives on the record. */
  recordKey:
    | "storyPlan"
    | "worldBible"
    | "directorialPlan"
    | "cinematographyPlan"
    | "artDirectionPlan"
    | "audioPlan";
  /** Matches the Agentic Canvas card key. */
  agentKey: string;
  label: string;
  schema: ZodTypeAny;
  /** History action, so the storyboard's "not applied yet" badge still works. */
  historyAction: string;
  fields: PlanField[];
  /**
   * Rules the schema cannot express because they depend on the project, such as
   * how many segments it has. Returns the problem, or undefined.
   */
  check?: (plan: Record<string, unknown>, record: ProjectRecord) => string | undefined;
};

/**
 * The arc has to stay one entry per segment: every later agent slices it by
 * segment number, so a short or padded list moves beats onto the wrong scenes.
 */
function checkArc(plan: Record<string, unknown>, record: ProjectRecord): string | undefined {
  const count = record.project.segmentCount;
  const beats = plan.segmentBeats as string[];
  const emotions = plan.emotionalProgression as string[];
  if (beats.length !== count) return `Story beats needs ${count} entries, one per segment; got ${beats.length}`;
  const blank = beats.findIndex((b) => !b.trim());
  if (blank !== -1) return `Story beat ${blank + 1} is empty`;
  if (emotions.length !== count) {
    return `Emotional progression needs ${count} entries, one per segment; got ${emotions.length}`;
  }
  const continued = (plan.continuedSegments as number[] | undefined) ?? [];
  const outside = continued.find((n) => n < 2 || n > count);
  if (outside !== undefined) {
    return `Continued segment ${outside} is not between 2 and ${count} — segment 1 has nothing to continue`;
  }
  const climax = plan.climaxSegment as number | undefined;
  if (climax !== undefined && (climax < 1 || climax > count)) {
    return `Climax segment ${climax} is not between 1 and ${count}`;
  }
  return undefined;
}

export const PLAN_SPECS: readonly PlanSpec[] = [
  {
    recordKey: "storyPlan",
    agentKey: "story",
    label: "Story Arc",
    schema: storyPlanSchema,
    historyAction: "story_plan.edited",
    check: checkArc,
    fields: [
      { key: "title", label: "Title", kind: "text", rows: 1 },
      { key: "logline", label: "Logline", kind: "text", rows: 2 },
      {
        key: "segmentBeats",
        label: "Story beats",
        kind: "numbered",
        rows: 12,
        help: "One per segment, keyed by number. Keep every number: this is what each scene is about.",
      },
      {
        key: "emotionalProgression",
        label: "Emotional progression",
        kind: "numbered",
        help: "One value per segment, keyed the same way.",
      },
      {
        key: "continuedSegments",
        label: "Continued segments",
        kind: "numbers",
        help: "Segments that carry the previous one's action on, e.g. 9, 10, 11.",
      },
      {
        key: "climaxSegment",
        label: "Climax segment",
        kind: "number",
        help: "Where the climax lands. Blank for unknown.",
      },
    ],
  },
  {
    recordKey: "worldBible",
    agentKey: "world",
    label: "World Bible",
    schema: worldBibleSchema,
    historyAction: "world_bible.edited",
    fields: [
      { key: "premise", label: "Premise", kind: "text", rows: 4 },
      { key: "universeRules", label: "Universe rules", kind: "list" },
      { key: "timelineRules", label: "Timeline rules", kind: "list" },
      { key: "locations", label: "Locations", kind: "named" },
      { key: "factionsOrGroups", label: "Factions or groups", kind: "list" },
      { key: "characterRelationships", label: "Character relationships", kind: "list" },
      { key: "recurringMotifs", label: "Recurring motifs", kind: "list" },
      { key: "visualAnchors", label: "Visual anchors", kind: "list" },
      { key: "continuityConstraints", label: "Continuity constraints", kind: "list" },
      {
        key: "forbiddenContradictions",
        label: "Forbidden contradictions",
        kind: "list",
        help: "Appended to every negative prompt.",
      },
    ],
  },
  {
    recordKey: "directorialPlan",
    agentKey: "director",
    label: "Directorial Plan",
    schema: directorialPlanSchema,
    historyAction: "directorial_plan.edited",
    fields: [
      { key: "creativeThesis", label: "Creative thesis", kind: "text", rows: 3 },
      { key: "pacingStrategy", label: "Pacing strategy", kind: "text", rows: 3 },
      { key: "emotionalArc", label: "Emotional arc", kind: "list", help: "One value per segment." },
      { key: "performanceDirection", label: "Performance direction", kind: "list" },
      {
        key: "sceneIntent",
        label: "Scene intent",
        kind: "map",
        help: "Keyed by segment number. Only this scene's entry reaches its prompts.",
      },
      { key: "approvalNotes", label: "Approval notes", kind: "list" },
    ],
  },
  {
    recordKey: "cinematographyPlan",
    agentKey: "cinematographer",
    label: "Cinematography Plan",
    schema: cinematographyPlanSchema,
    historyAction: "cinematography_plan.edited",
    fields: [
      { key: "cameraLanguage", label: "Camera language", kind: "text", rows: 3 },
      { key: "lensAndFramingRules", label: "Lens and framing rules", kind: "list" },
      { key: "movementRules", label: "Movement rules", kind: "list" },
      { key: "lightingRules", label: "Lighting rules", kind: "list" },
      {
        key: "sceneShotPlans",
        label: "Scene shot plans",
        kind: "map",
        help: "Keyed by segment number. Drives the shot size in each scene's prompts.",
      },
      { key: "transitionLanguage", label: "Transition language", kind: "list" },
    ],
  },
  {
    recordKey: "artDirectionPlan",
    agentKey: "art",
    label: "Art Direction Plan",
    schema: artDirectionPlanSchema,
    historyAction: "art_direction_plan.edited",
    fields: [
      {
        key: "productionDesign",
        label: "Production design",
        kind: "text",
        rows: 3,
        help: "The first two sentences are appended to every image and video prompt. Keep it tight.",
      },
      {
        key: "colorScript",
        label: "Colour script",
        kind: "text",
        rows: 3,
        help: "Read by the prompt agents; never appended verbatim.",
      },
      { key: "textureRules", label: "Texture rules", kind: "list" },
      { key: "wardrobeRules", label: "Wardrobe rules", kind: "list" },
      { key: "propRules", label: "Prop rules", kind: "list" },
      { key: "setDressingRules", label: "Set dressing rules", kind: "list" },
      { key: "typographyRules", label: "Typography rules", kind: "list" },
      { key: "productPlacementRules", label: "Product placement rules", kind: "list" },
    ],
  },
  {
    recordKey: "audioPlan",
    agentKey: "audio",
    label: "Audio Plan",
    schema: audioPlanSchema,
    historyAction: "audio_plan.edited",
    fields: [
      { key: "musicDirection", label: "Music direction", kind: "text", rows: 3 },
      { key: "sfxLibraryNotes", label: "SFX library notes", kind: "text", rows: 3 },
    ],
  },
];

export function planSpecFor(agentKey: string): PlanSpec | undefined {
  return PLAN_SPECS.find((s) => s.agentKey === agentKey);
}

export function planSpecByRecordKey(recordKey: string): PlanSpec | undefined {
  return PLAN_SPECS.find((s) => s.recordKey === recordKey);
}

/** The stored plan for a spec, or undefined when the agent has not run. */
export function planOn(record: ProjectRecord, spec: PlanSpec): Record<string, unknown> | undefined {
  return record[spec.recordKey] as Record<string, unknown> | undefined;
}
