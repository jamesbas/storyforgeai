import type { Project } from "@/lib/schemas/project";
import type { CreativeBrief, StoryPlan, VisualBible } from "@/lib/schemas/agents";
import type { SceneDraft } from "@/lib/schemas/storyboard";
import type { CreativeVariant } from "@/lib/schemas/canvas";
import type { Character } from "@/lib/schemas/character";
import type { CreativePlans } from "@/lib/agents/creative-context";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

/**
 * Shared context threaded through the planning pipeline. Later agents read the
 * artifacts produced by earlier ones (spec Section 8.1).
 */
export type AgentContext = {
  project: Project;
  selectedVariant?: CreativeVariant;
  /**
   * Locked character descriptions from the global library. Empty when the
   * project did not opt in, so every agent can read it unconditionally.
   */
  cast?: Character[];
  /**
   * Approved Agentic Canvas plans (world, direction, camera, art). Optional:
   * the canvas agents are run on demand, so a project may have none of them.
   */
  plans?: CreativePlans;
  brief?: CreativeBrief;
  storyPlan?: StoryPlan;
  visualBible?: VisualBible;
  sceneDrafts?: SceneDraft[];
  /** Agents that fell back to their deterministic builder during this run. */
  fallbacks?: { agent: string; reason: string }[];
};

/**
 * Dependencies injected into the orchestrator so tests can drive the pipeline
 * with a fake provider (or none) via DI.
 */
export type OrchestratorDeps = {
  provider?: PlanningProvider | null;
  selectedVariant?: CreativeVariant;
  cast?: Character[];
  plans?: CreativePlans;
  /** A previously generated arc, reused rather than paid for again. */
  storyPlan?: StoryPlan;
  /** Reports a freshly generated arc so the caller can persist it. */
  onStoryPlan?: (plan: StoryPlan) => void;
};
