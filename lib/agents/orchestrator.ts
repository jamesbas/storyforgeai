import type { Project } from "@/lib/schemas/project";
import { storyboardSnapshotSchema, type StoryboardSnapshot } from "@/lib/schemas/storyboard";
import { intakeAgent } from "@/lib/agents/intake-agent";
import { storyArchitectAgent } from "@/lib/agents/story-architect-agent";
import { visualBibleAgent } from "@/lib/agents/visual-bible-agent";
import { storyboardAgent } from "@/lib/agents/storyboard-agent";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import { getPlanningProvider } from "@/lib/agents/llm/provider";
import { hasCreativePlans } from "@/lib/agents/creative-context";
import { foldWardrobeChanges } from "@/lib/agents/wardrobe";
import type { AgentContext, OrchestratorDeps } from "@/lib/agents/types";
import { logEvent } from "@/lib/telemetry";
import { config } from "@/lib/config";

/**
 * Storyboard orchestrator. Decides and sequences specialist agents, then
 * validates the assembled snapshot against the schema before returning it.
 *
 * The same pipeline runs whether the deterministic mock builders or an LLM
 * provider back each agent — both emit the same StoryboardSnapshot shape
 * (deterministic/AI parity). A provider can be injected via `deps` for tests.
 */
export async function runStoryboardOrchestrator(
  project: Project,
  deps: OrchestratorDeps = {},
): Promise<StoryboardSnapshot> {
  const provider = deps.provider !== undefined ? deps.provider : getPlanningProvider();
  logEvent("agent.run", {
    projectId: project.id,
    mode: provider ? `ai:${provider.name}` : "mock",
    aiFlag: config.flags.aiPlanning,
    cast: (deps.cast ?? []).length,
    plans: hasCreativePlans(deps.plans),
  });

  const ctx: AgentContext = {
    project,
    selectedVariant: deps.selectedVariant,
    cast: deps.cast ?? [],
    plans: deps.plans,
    conceptVisuals: deps.conceptVisuals,
    onExecution: deps.onExecution,
    correlationId: deps.correlationId,
  };
  ctx.brief = await intakeAgent(ctx, provider);
  if (ctx.selectedVariant) {
    // Carry the substance of the chosen direction, not just its label. Passing
    // the name alone dropped the hook, angle and visual style the creator
    // actually selected, which made variant selection close to decorative.
    const v = ctx.selectedVariant;
    const direction = [
      `Selected direction: ${v.name} — ${v.summary}`,
      v.hook ? `Hook: ${v.hook}` : null,
      v.storyAngle ? `Story angle: ${v.storyAngle}` : null,
      v.visualStyle ? `Visual style: ${v.visualStyle}` : null,
      v.risks.length ? `Avoid: ${v.risks.join("; ")}` : null,
    ].filter((line): line is string => line !== null);
    ctx.brief = {
      ...ctx.brief,
      constraints: [...ctx.brief.constraints, ...direction],
    };
  }
  ctx.storyPlan = deps.storyPlan ?? (await storyArchitectAgent(ctx, provider));
  // Only a freshly generated arc is worth reporting; a reused one is already stored.
  if (!deps.storyPlan) deps.onStoryPlan?.(ctx.storyPlan);
  ctx.visualBible = await visualBibleAgent(ctx, provider);
  ctx.sceneDrafts = await storyboardAgent(ctx, provider);
  // A costume change the story called for has to reach the project before the
  // prompts are written, or the proposal would only take effect on the next
  // regeneration. Manual entries win: they are the ones a person chose.
  const withWardrobe = foldWardrobeChanges(project, ctx.sceneDrafts, ctx.cast ?? []);
  if (withWardrobe !== project) deps.onWardrobeChanges?.(withWardrobe.wardrobeChanges ?? {});
  const scenes = await attachScenePrompts(withWardrobe, ctx.sceneDrafts, provider, {
    cast: ctx.cast,
    visualBible: ctx.visualBible,
    plans: ctx.plans,
    onExecution: ctx.onExecution,
    correlationId: ctx.correlationId,
  });

  const snapshot = storyboardSnapshotSchema.parse({
    brief: ctx.brief,
    visualBible: ctx.visualBible,
    scenes,
    fallbacks: ctx.fallbacks?.length ? ctx.fallbacks : undefined,
  });
  logEvent("storyboard.generated", {
    projectId: project.id,
    scenes: snapshot.scenes.length,
    fallbacks: ctx.fallbacks?.map((f) => f.agent) ?? [],
  });
  return snapshot;
}
