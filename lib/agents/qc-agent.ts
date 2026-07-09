import { qcResultSchema, type QCResult, type SceneAttempt } from "@/lib/schemas/generation";
import type { Scene } from "@/lib/schemas/storyboard";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

export const QC_SYSTEM =
  "You are the QC Agent. Compare generated media against the scene card, visual bible, and " +
  "prompts. Identify continuity breaks, subject drift, visual artifacts, weak motion, incorrect " +
  "framing, bad text, missing actions, or audio mismatch. Return pass/fail, severity, and " +
  "specific regeneration instructions.";

/**
 * Deterministic QC. Fails when required media is missing; otherwise passes with
 * the scene's prompt quality checklist as matched requirements (spec Section 16).
 */
export function evaluateQc(scene: Scene, attempt: SceneAttempt): QCResult {
  const issues: string[] = [];
  if (!attempt.startImagePath) issues.push("Missing start-frame image.");
  if (!attempt.videoPath) issues.push("Missing video segment output.");

  const passed = issues.length === 0;
  return {
    passed,
    score: passed ? 0.9 : 0.2,
    severity: passed ? "none" : "major",
    issues,
    matchedRequirements: passed ? scene.prompts.promptQualityChecklist : [],
    regenerationInstructions: passed
      ? undefined
      : "Re-run generation; ensure start frame and video outputs are produced.",
  };
}

export async function qcAgent(
  scene: Scene,
  attempt: SceneAttempt,
  provider: PlanningProvider | null,
): Promise<QCResult> {
  if (provider) {
    const user = JSON.stringify({ scene, attempt });
    const result = await provider.generateJson(QC_SYSTEM, user, qcResultSchema);
    if (result) return result;
  }
  return evaluateQc(scene, attempt);
}
