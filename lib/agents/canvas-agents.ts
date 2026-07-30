import { z } from "zod";
import type { Project } from "@/lib/schemas/project";
import {
  artDirectionPlanSchema,
  cinematographyPlanSchema,
  creativeVariantSchema,
  directorialPlanSchema,
  worldBibleSchema,
  type ArtDirectionPlan,
  type CinematographyPlan,
  type CreativeVariant,
  type DirectorialPlan,
  type WorldBible,
} from "@/lib/schemas/canvas";
import {
  buildArtDirectionPlan,
  buildCinematographyPlan,
  buildDirectorialPlan,
  buildVariants,
  buildWorldBible,
} from "@/lib/agents/mock-canvas";
import { castSystemDirective } from "@/lib/agents/cast";
import { planningPayload, precedenceDirective, type CreativePlans } from "@/lib/agents/creative-context";
import type { StoryPlan } from "@/lib/schemas/agents";
import type { Character } from "@/lib/schemas/character";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

export const VARIANT_EXPLORER_SYSTEM =
  "You are the Variant Explorer Agent. Create 3 distinct creative directions from the same " +
  "user concept. Each direction must include a title, hook, story angle, visual style, " +
  "strengths, risks, and best-fit platform. Do not create the final storyboard yet. Return " +
  "only valid JSON.";

/**
 * The four plan agents below carry craft vocabulary rather than a field list.
 *
 * Each opens with the sentence `video-storyboard-spec.md` §9.10–9.13 specifies —
 * dropped when they were first implemented — and then names the concepts a
 * practitioner would use. A model asked to "define the visual camera language"
 * returns mood adjectives; one asked for a shot size from a named taxonomy
 * returns something the Image Prompt Agent can convert into framing.
 */

export const WORLD_BUILDER_SYSTEM =
  "You are the World Builder Agent. Create a World Bible for the selected creative direction. " +
  "Define the universe, story rules, recurring locations, character relationships, motifs, " +
  "visual anchors, and contradictions to avoid. " +
  "A bible is a continuity reference, not an essay: every entry must be a fact a later agent " +
  "can check a scene against, so prefer short checkable statements to description. " +
  "Scenes are generated independently and out of order, exactly as a film is shot out of " +
  "sequence, so this document does the job a script supervisor does on set — it is the record " +
  "that makes unrelated shots match. Weight it towards what would visibly differ between two " +
  "separately generated images: recurring locations and their fixed features, time of day and " +
  "weather, what each character habitually wears and carries, and physical details that must " +
  "not drift. " +
  "Visual anchors must be concrete and repeatable: a specific object, colour, texture or light " +
  "source that can recur across scenes and bind them together. " +
  "Forbidden contradictions are used directly as negative prompts, so write each as a short " +
  "noun phrase naming what must never appear, not as a sentence about what should be true. " +
  "Return only valid JSON matching the WorldBible schema.";

export const DIRECTOR_SYSTEM =
  "You are the Director Agent. Convert the selected concept and story arc into a directorial " +
  "plan. Define creative thesis, pacing, emotional arc, performance guidance, and scene-level " +
  "intent. " +
  "The creative thesis is the argument the piece makes — one sentence, specific enough that " +
  "someone could disagree with it. Everything else serves it. " +
  "A beat marks a deliberate shift in tone, not a description of events, so each scene's intent " +
  "must state what changes: who wants what, what is in the way, and what is different by the " +
  "end. \"She plays pool in a bar\" is not an intent; \"she is being watched and pretends not to " +
  "notice\" is. Never restate a scene's visual description as its intent. " +
  "The emotional arc must move. Name the value at each step (for example curiosity, confidence, " +
  "exposure, resolve) and identify the turn — the point where the piece changes direction. Do " +
  "not repeat the same emotional register in consecutive scenes. " +
  "Performance direction must be physical and playable: posture, gesture, eyeline, tempo, and " +
  "where the character's attention is. This system renders images, so direction that cannot be " +
  "seen cannot be executed — \"conflicted\" is not directable, \"holds eye contact a beat too " +
  "long, then looks away first\" is. " +
  "When a story plan is supplied, write one sceneIntent per segment beat and key it by segment " +
  "number as a plain string — \"1\", \"2\", \"3\" — matching the order of the beats. " +
  "Return only valid JSON matching the DirectorialPlan schema.";

export const CINEMATOGRAPHER_SYSTEM =
  "You are the Cinematographer Agent. Define the visual camera language for the project. " +
  "Specify shot types, lens/framing rules, camera movements, lighting approach, and transition " +
  "language. " +
  "Use the standard shot-size vocabulary and name exactly one per scene: extreme wide (EWS), " +
  "wide (WS), full (FS), medium wide (MWS), cowboy, medium (MS), medium close-up (MCU), " +
  "close-up (CU), extreme close-up (ECU). Vary sizes deliberately across the storyboard — " +
  "contrast between shot sizes is what signals which moments matter, and a run of identical " +
  "framings has no emphasis. Establish a new location on a wider size before moving in. " +
  "Give lens choices in millimetres with the reason: wide lenses (18-35mm) exaggerate depth and " +
  "proximity, long lenses (85mm+) compress and isolate. State camera height per scene — eye " +
  "level, low, high or overhead. " +
  "Every camera move must be motivated by story, and you must state the motivation. Respect the " +
  "conventional meanings: static lets performance carry and suits dialogue; push-in for rising " +
  "intimacy or a decision forming; pull-out for isolation or revealing context; pan and tilt for " +
  "following action or revealing scale; tracking for travelling with a subject; arc for unease " +
  "or heightened energy; boom or crane for scale and establishing; handheld for raw immediacy; " +
  "roll or Dutch for disorientation; zoom is deliberately artificial and has no equivalent in " +
  "human vision. Where a scene needs no movement, say static and say why. " +
  "Lighting rules must state key direction, key-to-fill ratio, hard or soft quality, colour " +
  "temperature, and whether sources are practical (visible in frame) or motivated (implied by " +
  "the world). Name low-key explicitly when you want deep shadow and high contrast, and specify " +
  "the backlight or rim separately — it is what separates a subject from the background. " +
  "When a story plan is supplied, write one sceneShotPlan per segment beat and key it by segment " +
  "number as a plain string — \"1\", \"2\", \"3\" — matching the order of the beats. " +
  "Return only valid JSON matching the CinematographyPlan schema.";

export const ART_DIRECTOR_SYSTEM =
  "You are the Art Director Agent. Define production design, wardrobe, props, set dressing, " +
  "texture, colour, typography, and brand/product placement rules. " +
  "Production design carries narrative information as directly as dialogue does, so every " +
  "choice should say something about who these people are and where they are. Anchor the world " +
  "first: state the period, the geography and the economic register, because those three decide " +
  "most of the rest. " +
  "Wardrobe must convey social status, profession and self-image through specific named " +
  "garments, fabrics and colours — never a generic register such as \"casual clothing\". Choose " +
  "props for what they reveal: name the object and what it says about its owner. Set dressing " +
  "should show evidence of use — what is worn, repaired, cherished or neglected. Name surfaces " +
  "and materials, since texture carries as much as colour. " +
  "Give the project a colour script rather than a palette: name the relationship (complementary, " +
  "analogous, split-complementary, triadic, or monochrome with one accent), give the dominant " +
  "and accent hues, and say how colour shifts across the storyboard as the emotional arc moves. " +
  "Cool hues read as calm, distance or sadness; warm hues as intimacy, appetite or anger. State " +
  "colour temperature so the palette and the lighting plan do not fight each other. Put all of " +
  "that in colorScript, never in productionDesign. " +
  "Keep the production design summary to two or three sentences: it is appended to every image " +
  "and video prompt in the project, so length there costs attention on every render. " +
  "Return only valid JSON matching the ArtDirectionPlan schema.";

const variantsSchema = z.object({ variants: z.array(creativeVariantSchema) });

/**
 * What a canvas agent is allowed to see.
 *
 * All four used to receive `{ project }` alone — so the World Builder was asked
 * to work "for the selected creative direction" without being given it, and the
 * Director to convert "the selected concept and story arc" with no arc in sight.
 * Later agents also see the plans already approved, so the Cinematographer can
 * light the Director's intent rather than inventing a second mood from the same
 * one-line concept.
 */
export type CanvasContext = {
  selectedVariant?: CreativeVariant;
  cast?: readonly Character[];
  storyPlan?: StoryPlan;
  plans?: CreativePlans;
};

/** Only the direction's substance is useful; ids and timestamps are noise. */
function directionOf(variant: CreativeVariant | undefined) {
  if (!variant) return undefined;
  return {
    name: variant.name,
    summary: variant.summary,
    hook: variant.hook,
    storyAngle: variant.storyAngle,
    visualStyle: variant.visualStyle,
    avoid: variant.risks,
  };
}

export async function variantExplorerAgent(
  project: Project,
  provider: PlanningProvider | null,
): Promise<CreativeVariant[]> {
  if (provider) {
    const user = JSON.stringify({ project });
    const result = await provider.generateJson(VARIANT_EXPLORER_SYSTEM, user, variantsSchema);
    if (result && result.variants.length >= 3) {
      return result.variants.map((v) => ({ ...v, projectId: project.id }));
    }
  }
  return buildVariants(project);
}

export async function worldBuilderAgent(
  project: Project,
  provider: PlanningProvider | null,
  ctx: CanvasContext = {},
): Promise<WorldBible> {
  if (provider) {
    const user = JSON.stringify({
      project,
      selectedDirection: directionOf(ctx.selectedVariant),
      cast: ctx.cast ?? [],
      storyPlan: ctx.storyPlan,
    });
    const result = await provider.generateJson(
      WORLD_BUILDER_SYSTEM + castSystemDirective(ctx.cast ?? []),
      user,
      worldBibleSchema,
    );
    if (result) return { ...result, projectId: project.id };
  }
  return buildWorldBible(project);
}

export async function directorAgent(
  project: Project,
  provider: PlanningProvider | null,
  ctx: CanvasContext = {},
): Promise<DirectorialPlan> {
  if (provider) {
    const user = JSON.stringify({
      project,
      selectedDirection: directionOf(ctx.selectedVariant),
      cast: ctx.cast ?? [],
      storyPlan: ctx.storyPlan,
      plans: planningPayload(ctx.plans),
    });
    const result = await provider.generateJson(
      DIRECTOR_SYSTEM +
        castSystemDirective(ctx.cast ?? []) +
        precedenceDirective(ctx.cast ?? [], ctx.plans),
      user,
      directorialPlanSchema,
    );
    if (result) return { ...result, projectId: project.id };
  }
  return buildDirectorialPlan(project);
}

export async function cinematographerAgent(
  project: Project,
  provider: PlanningProvider | null,
  ctx: CanvasContext = {},
): Promise<CinematographyPlan> {
  if (provider) {
    const user = JSON.stringify({
      project,
      selectedDirection: directionOf(ctx.selectedVariant),
      storyPlan: ctx.storyPlan,
      plans: planningPayload(ctx.plans),
    });
    const result = await provider.generateJson(
      CINEMATOGRAPHER_SYSTEM + precedenceDirective(ctx.cast ?? [], ctx.plans),
      user,
      cinematographyPlanSchema,
    );
    if (result) return { ...result, projectId: project.id };
  }
  return buildCinematographyPlan(project);
}

export async function artDirectorAgent(
  project: Project,
  provider: PlanningProvider | null,
  ctx: CanvasContext = {},
): Promise<ArtDirectionPlan> {
  if (provider) {
    const user = JSON.stringify({
      project,
      selectedDirection: directionOf(ctx.selectedVariant),
      cast: ctx.cast ?? [],
      storyPlan: ctx.storyPlan,
      plans: planningPayload(ctx.plans),
    });
    const result = await provider.generateJson(
      ART_DIRECTOR_SYSTEM +
        castSystemDirective(ctx.cast ?? []) +
        precedenceDirective(ctx.cast ?? [], ctx.plans),
      user,
      artDirectionPlanSchema,
    );
    if (result) return { ...result, projectId: project.id };
  }
  return buildArtDirectionPlan(project);
}
