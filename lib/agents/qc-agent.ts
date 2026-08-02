import { qcResultSchema, type QCResult, type SceneAttempt } from "@/lib/schemas/generation";
import type { Scene } from "@/lib/schemas/storyboard";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import { loadImagesAsDataUrls } from "@/lib/media/data-url";
import { executeArtifact, providerCall, type ExecutionCollector } from "@/lib/agents/provenance";
import { BUILDER_VERSION, PROMPT_VERSIONS } from "@/lib/agents/prompt-version";
import { config } from "@/lib/config";
import { logEvent } from "@/lib/telemetry";

/**
 * Grading a finished scene.
 *
 * The agent used to be handed `{ scene, attempt }` — which carries file *paths*,
 * not pixels — under a prompt telling it to spot visual artifacts and weak
 * motion. Models did the only thing left to them: they noticed the images were
 * absent, quietly redefined the job as comparing one prompt string to another,
 * and returned a confident verdict about renders they had never seen. Scenes
 * were flagged `needs_review` on that basis.
 *
 * So there are two honest modes, and which one runs depends on whether a vision
 * model is configured. Neither claims to be the other.
 */

const VISUAL_SYSTEM =
  "You are the QC Agent. The attached images are the generated keyframes for this scene. " +
  "Judge what you can actually see in them against the scene card and prompts: continuity " +
  "breaks, subject drift, anatomical errors, visual artifacts, incorrect framing, garbled text, " +
  "missing actions. Report only defects visible in the images. The `expectations` field states " +
  "what this project's generation mode asked for; do not report media as missing when it was " +
  "never requested. Return pass/fail, severity, and specific regeneration instructions.";

const TEXT_SYSTEM =
  "You are the QC Agent. You are reviewing prompt text only — no images are attached and you " +
  "cannot see the generated media. Do not speculate about how the render looks. Judge only " +
  "whether the prompts are internally consistent and faithful to the scene card: contradictory " +
  "wardrobe or appearance between the start-frame, end-frame and video prompts, actions or " +
  "camera moves named in the scene card but missing from the prompts, continuity conflicts with " +
  "the previous scene. Return pass/fail, severity, and specific prompt corrections.";

/** Kept for callers that assert on the prompt; visual grading is the default. */
export const QC_SYSTEM = VISUAL_SYSTEM;

/** What the project's generation mode asked for, so QC judges against that. */
export type QcExpectations = { expectVideo: boolean };

/** Read keyframes as data URLs, skipping any that cannot be sent. */
export const loadQcImages = (paths: readonly (string | undefined)[]): Promise<string[]> =>
  loadImagesAsDataUrls(paths, "qc").then((images) => images.map((image) => image.url));

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
  options: { onExecution?: ExecutionCollector; correlationId?: string } = {},
): Promise<QCResult> {
  const images =
    provider && config.openai.visionModel
      ? await loadQcImages([attempt.startImagePath, attempt.endImagePath])
      : [];
  const visual = images.length > 0;

  if (provider) {
    logEvent("qc.mode", {
      sceneId: scene.id,
      mode: visual ? "visual" : "text_only",
      images: images.length,
    });
  }

  // Paths are noise to a model that can see the frames, and misleading to one
  // that cannot — it reads them as evidence the media was supplied.
  const { startImagePath, endImagePath, videoPath, ...rest } = attempt;
  const user = JSON.stringify({
    scene,
    attempt: visual ? rest : { ...rest, note: "Media not attached. Review prompts only." },
    expectations,
  });

  const { value } = await executeArtifact<QCResult>({
    artifact: `${scene.id}.qc`,
    scope: scene.id,
    correlationId: options.correlationId,
    promptVersion: PROMPT_VERSIONS.qc,
    builderVersion: BUILDER_VERSION,
    provider,
    onExecution: options.onExecution,
    // A text-only verdict must never read as though the frames were seen.
    evidence: {
      mode: provider ? (visual ? "visual" : "text_only") : "deterministic",
      attachments: images.length,
    },
    llm: provider
      ? providerCall(
          provider,
          visual ? VISUAL_SYSTEM : TEXT_SYSTEM,
          user,
          qcResultSchema,
          visual ? { images } : {},
        )
      : undefined,
    fallback: () => evaluateQc(scene, attempt, expectations),
  });
  return value;
}
