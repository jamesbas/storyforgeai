import type { Project } from "@/lib/schemas/project";
import { storyboardSnapshotSchema, type StoryboardSnapshot } from "@/lib/schemas/storyboard";
import { intakeAgent } from "@/lib/agents/intake-agent";
import { storyArchitectAgent } from "@/lib/agents/story-architect-agent";
import { visualBibleAgent } from "@/lib/agents/visual-bible-agent";
import { storyboardAgent } from "@/lib/agents/storyboard-agent";
import { attachScenePrompts } from "@/lib/agents/prompt-agents";
import { getPlanningProvider } from "@/lib/agents/llm/provider";
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
  });

  const ctx: AgentContext = { project, selectedVariant: deps.selectedVariant };
  ctx.brief = await intakeAgent(ctx, provider);
  if (ctx.selectedVariant) {
    ctx.brief = {
      ...ctx.brief,
      constraints: [...ctx.brief.constraints, `Selected direction: ${ctx.selectedVariant.name}`],
    };
  }
  ctx.storyPlan = await storyArchitectAgent(ctx, provider);
  ctx.visualBible = await visualBibleAgent(ctx, provider);
  ctx.sceneDrafts = await storyboardAgent(ctx, provider);
  const scenes = await attachScenePrompts(project, ctx.sceneDrafts, provider);

  const snapshot = storyboardSnapshotSchema.parse({
    brief: ctx.brief,
    visualBible: ctx.visualBible,
    scenes,
  });
  logEvent("storyboard.generated", { projectId: project.id, scenes: snapshot.scenes.length });
  return snapshot;
}
