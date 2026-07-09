import type { Project } from "@/lib/schemas/project";
import type { CreativeBrief, StoryPlan, VisualBible } from "@/lib/schemas/agents";
import type { SceneDraft } from "@/lib/schemas/storyboard";
import type { CreativeVariant } from "@/lib/schemas/canvas";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

/**
 * Shared context threaded through the planning pipeline. Later agents read the
 * artifacts produced by earlier ones (spec Section 8.1).
 */
export type AgentContext = {
  project: Project;
  selectedVariant?: CreativeVariant;
  brief?: CreativeBrief;
  storyPlan?: StoryPlan;
  visualBible?: VisualBible;
  sceneDrafts?: SceneDraft[];
};

/**
 * Dependencies injected into the orchestrator so tests can drive the pipeline
 * with a fake provider (or none) via DI.
 */
export type OrchestratorDeps = {
  provider?: PlanningProvider | null;
  selectedVariant?: CreativeVariant;
};
