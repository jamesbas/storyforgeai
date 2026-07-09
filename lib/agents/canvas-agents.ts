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
import type { PlanningProvider } from "@/lib/agents/llm/provider";

export const VARIANT_EXPLORER_SYSTEM =
  "You are the Variant Explorer Agent. Create 3 distinct creative directions from the same " +
  "user concept. Each direction must include a title, hook, story angle, visual style, " +
  "strengths, risks, and best-fit platform. Do not create the final storyboard yet. Return " +
  "only valid JSON.";

export const WORLD_BUILDER_SYSTEM =
  "You are the World Builder Agent. Create a World Bible for the selected creative direction. " +
  "Return only valid JSON matching the WorldBible schema.";

export const DIRECTOR_SYSTEM =
  "You are the Director Agent. Convert the selected concept and story arc into a directorial " +
  "plan. Return only valid JSON matching the DirectorialPlan schema.";

export const CINEMATOGRAPHER_SYSTEM =
  "You are the Cinematographer Agent. Define the visual camera language for the project. " +
  "Return only valid JSON matching the CinematographyPlan schema.";

export const ART_DIRECTOR_SYSTEM =
  "You are the Art Director Agent. Define production design, wardrobe, props, set dressing, " +
  "typography, and product placement rules. Return only valid JSON matching the " +
  "ArtDirectionPlan schema.";

const variantsSchema = z.object({ variants: z.array(creativeVariantSchema) });

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
): Promise<WorldBible> {
  if (provider) {
    const result = await provider.generateJson(WORLD_BUILDER_SYSTEM, JSON.stringify({ project }), worldBibleSchema);
    if (result) return { ...result, projectId: project.id };
  }
  return buildWorldBible(project);
}

export async function directorAgent(
  project: Project,
  provider: PlanningProvider | null,
): Promise<DirectorialPlan> {
  if (provider) {
    const result = await provider.generateJson(DIRECTOR_SYSTEM, JSON.stringify({ project }), directorialPlanSchema);
    if (result) return { ...result, projectId: project.id };
  }
  return buildDirectorialPlan(project);
}

export async function cinematographerAgent(
  project: Project,
  provider: PlanningProvider | null,
): Promise<CinematographyPlan> {
  if (provider) {
    const result = await provider.generateJson(
      CINEMATOGRAPHER_SYSTEM,
      JSON.stringify({ project }),
      cinematographyPlanSchema,
    );
    if (result) return { ...result, projectId: project.id };
  }
  return buildCinematographyPlan(project);
}

export async function artDirectorAgent(
  project: Project,
  provider: PlanningProvider | null,
): Promise<ArtDirectionPlan> {
  if (provider) {
    const result = await provider.generateJson(
      ART_DIRECTOR_SYSTEM,
      JSON.stringify({ project }),
      artDirectionPlanSchema,
    );
    if (result) return { ...result, projectId: project.id };
  }
  return buildArtDirectionPlan(project);
}
