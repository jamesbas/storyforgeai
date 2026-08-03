import type { Project } from "@/lib/schemas/project";
import type { ConceptVisuals, CreativeBrief, StoryPlan, VisualBible } from "@/lib/schemas/agents";
import type { SceneDraft } from "@/lib/schemas/storyboard";
import type { CreativeVariant } from "@/lib/schemas/canvas";
import type { Character } from "@/lib/schemas/character";
import type { WardrobeChange } from "@/lib/schemas/wardrobe";
import type { CreativePlans } from "@/lib/agents/creative-context";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { ExecutionCollector } from "@/lib/agents/provenance";

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
  /**
   * What the project's reference images showed, read once before the run.
   *
   * Read by the Intake Producer and the Visual Bible, and deliberately not by
   * the Storyboard Artist: the bible is the continuity guide the artist already
   * consumes, so the look reaches it there rather than as a ninth directive on
   * a prompt that is already the longest in the app.
   */
  conceptVisuals?: ConceptVisuals;
  sceneDrafts?: SceneDraft[];
  /** Agents that fell back to their deterministic builder during this run. */
  fallbacks?: { agent: string; reason: string; detail?: string }[];
  /** Receives one provenance record per artifact produced during this run. */
  onExecution?: ExecutionCollector;
  /** Groups every execution produced by one user action. */
  correlationId?: string;
};

/**
 * Where a long agent has got to, in the user's language.
 *
 * The Storyboard Artist is five sub-agents and most of a run's wall clock, so
 * without this the canvas shows one unchanging label for twenty minutes and
 * reads as wedged.
 */
export type AgentProgress = {
  phase: string;
  /** Position within a repeated step, when the phase has one. */
  done?: number;
  total?: number;
};

export type ProgressReporter = (progress: AgentProgress) => void;

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
  /** What the project's reference images showed, resolved by the caller. */
  conceptVisuals?: ConceptVisuals;
  /** Reports a freshly generated arc so the caller can persist it. */
  onStoryPlan?: (plan: StoryPlan) => void;
  /** Reports costume changes the storyboard called for, so they outlive the run. */
  onWardrobeChanges?: (changes: Record<string, WardrobeChange[]>) => void;
  /** Receives one provenance record per artifact produced during this run. */
  onExecution?: ExecutionCollector;
  /** Reports which sub-agent is working, for the canvas status line. */
  onProgress?: ProgressReporter;
  correlationId?: string;
};
