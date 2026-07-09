import { config } from "@/lib/config";
import { logEvent } from "@/lib/telemetry";

/**
 * Deepy media assistant (spec Section 12). Optional helper layer; when
 * DEEPY_ASSIST_ENABLED is off it returns clearly-labeled simulated responses so
 * the UI stays functional. A real Deepy integration would replace the mock.
 */
export const DEEPY_ACTIONS = [
  "inspect_image",
  "inspect_video_frame",
  "extract_final_frame",
  "transcribe_audio",
  "merge_preview",
  "suggest_failure",
  "regen_prompt",
] as const;
export type DeepyAction = (typeof DEEPY_ACTIONS)[number];

export type DeepyResult = {
  action: DeepyAction;
  enabled: boolean;
  result: string;
};

const RESPONSES: Record<DeepyAction, (target: string) => string> = {
  inspect_image: (t) => `Image ${t} looks consistent with the visual bible; framing and subject match.`,
  inspect_video_frame: (t) => `Sampled frame from ${t}: motion is smooth, no obvious artifacts.`,
  extract_final_frame: (t) => `Extracted final frame from ${t} → ${t}.final.png (use as next start frame).`,
  transcribe_audio: (t) => `Transcript of ${t}: "[narration placeholder]".`,
  merge_preview: (t) => `Merged a rough preview from ${t}.`,
  suggest_failure: (t) => `Likely issue for ${t}: insufficient start-frame guidance; increase steps or add an end frame.`,
  regen_prompt: (t) => `Suggested regeneration prompt for ${t}: emphasize continuity and reduce motion blur.`,
};

export function runDeepy(action: DeepyAction, target: string): DeepyResult {
  const enabled = config.flags.deepyAssist;
  logEvent("agent.run", { agent: "deepy", action, enabled });
  const base = RESPONSES[action](target || "the selected media");
  return {
    action,
    enabled,
    result: enabled ? base : `(Deepy assist disabled — simulated) ${base}`,
  };
}
