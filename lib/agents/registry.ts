/**
 * Agent registry — metadata for the creative team surfaced on the Agentic Canvas
 * (spec Section 2A.3). Execution wiring for each agent is added per phase; this
 * registry is the single source of truth for which agents exist and their phase.
 */
export type AgentPhase = "mvp" | "phase2" | "phase3";

export type AgentDescriptor = {
  key: string;
  name: string;
  role: string;
  artifact: string;
  phase: AgentPhase;
};

export const AGENT_REGISTRY: AgentDescriptor[] = [
  { key: "intake", name: "Intake Producer", role: "Normalize brief", artifact: "Creative brief", phase: "mvp" },
  { key: "story", name: "Story Architect", role: "Narrative structure", artifact: "Narrative arc", phase: "mvp" },
  { key: "visual_bible", name: "Visual Bible", role: "Continuity rules", artifact: "Visual bible", phase: "mvp" },
  { key: "storyboard", name: "Storyboard Artist", role: "Scene cards", artifact: "Scenes", phase: "mvp" },
  { key: "image_prompt", name: "Image Prompt Engineer", role: "Keyframe prompts", artifact: "Image prompts", phase: "mvp" },
  { key: "video_prompt", name: "Video Prompt Engineer", role: "Motion prompts", artifact: "Video prompts", phase: "mvp" },
  { key: "wangp_settings", name: "WanGP Producer", role: "Model settings", artifact: "Settings manifest", phase: "phase3" },
  { key: "qc", name: "Creative Critic", role: "Quality control", artifact: "QC notes", phase: "phase3" },
];
