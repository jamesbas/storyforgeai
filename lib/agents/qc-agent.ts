import { qcResultSchema, type QCResult, type SceneAttempt } from "@/lib/schemas/generation";
import type { Scene } from "@/lib/schemas/storyboard";
import type { PlanningProvider } from "@/lib/agents/llm/provider";

export const QC_SYSTEM =
  "You are the QC Agent. Compare generated media against the scene card, visual bible, and " +
  "prompts. Identify continuity breaks, subject drift, visual artifacts, weak motion, incorrect " +
  "framing, bad text, missing actions, or audio mismatch. Return pass/fail, severity, and " +
  "specific regeneration instructions. The `expectations` field states what this project's " +
  "generation mode asked for; do not report media as missing when it was never requested.";

/** What the project's generation mode asked for, so QC judges against that. */
export type QcExpectations = { expectVideo: boolean };

/**
 * Deterministic QC. Fails when required media is missing; otherwise passes with
 * the scene's prompt quality checklist as matched requirements (spec Section 16).
 */
export function evaluateQc(
  scene: Scene,
  attempt: SceneAttempt,
  expectations: QcExpectations = { expectVideo: true },
): QCResult {
  const issues: string[] = [];
  if (!attempt.startImagePath) issues.push("Missing start-frame image.");
  // A keyframes-only project has no clip by design, so demanding one would fail
  // every scene it ever generates.
  if (expectations.expectVideo && !attempt.videoPath) issues.push("Missing video segment output.");

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
  expectations: QcExpectations = { expectVideo: true },
): Promise<QCResult> {
  if (provider) {
    const user = JSON.stringify({ scene, attempt, expectations });
    const result = await provider.generateJson(QC_SYSTEM, user, qcResultSchema);
    if (result) return result;
  }
  return evaluateQc(scene, attempt, expectations);
}
