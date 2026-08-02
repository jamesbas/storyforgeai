import { creativeBriefSchema, type CreativeBrief } from "@/lib/schemas/agents";
import { buildCreativeBrief } from "@/lib/agents/mock-agents";
import { conceptVisualsDirective, conceptVisualsPayload } from "@/lib/agents/concept-visuals";
import { executeArtifact, providerCall } from "@/lib/agents/provenance";
import { BUILDER_VERSION, PROMPT_VERSIONS } from "@/lib/agents/prompt-version";
import type { AgentContext } from "@/lib/agents/types";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

export const INTAKE_SYSTEM =
  "You are the Intake Agent for a video storyboard production system. Convert the " +
  "user's rough concept into a structured creative brief. Preserve the user's intent. " +
  "Fill reasonable defaults when information is missing. Do not generate scene prompts " +
  "yet. Return only valid JSON matching the CreativeBrief schema.";

export async function intakeAgent(
  ctx: AgentContext,
  provider: PlanningProvider | null,
): Promise<CreativeBrief> {
  const conceptVisuals = conceptVisualsPayload(ctx.conceptVisuals);
  const user = JSON.stringify({
    project: ctx.project,
    ...(conceptVisuals ? { conceptVisuals } : {}),
  });

  const { value } = await executeArtifact<CreativeBrief>({
    artifact: "brief",
    scope: "project",
    correlationId: ctx.correlationId,
    promptVersion: PROMPT_VERSIONS.intake,
    builderVersion: BUILDER_VERSION,
    provider,
    onExecution: ctx.onExecution,
    llm: provider
      ? providerCall(
          provider,
          INTAKE_SYSTEM + conceptVisualsDirective(ctx.conceptVisuals),
          user,
          creativeBriefSchema,
        )
      : undefined,
    fallback: () => buildCreativeBrief(ctx.project),
  });
  return { ...value, projectId: ctx.project.id };
}
