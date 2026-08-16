import { z } from "zod";
import {
  scenePromptsSchema,
  type Scene,
  type SceneDraft,
  type ScenePrompts,
} from "@/lib/schemas/storyboard";
import { buildImagePrompts, buildVideoPrompts } from "@/lib/agents/mock-agents";
import { buildMediaPromptSpec } from "@/lib/agents/media-prompt-builder";
import { COMPOSER_VERSION, lintRendered } from "@/lib/agents/media-prompt-spec";
import { logEvent } from "@/lib/telemetry";
import {
  missingDialogue,
  normaliseImagePrompt,
  normaliseVideoPrompt,
} from "@/lib/agents/media-prompt-normalise";
import {
  deterministicExecution,
  executeArtifact,
  providerCall,
  type ExecutionCollector,
} from "@/lib/agents/provenance";
import { BUILDER_VERSION, PROMPT_VERSIONS } from "@/lib/agents/prompt-version";
import type { ProgressReporter } from "@/lib/agents/types";
import {
  castContinuityClause,
  castNegativeSuffix,
  castPromptSuffix,
  castSystemDirective,
} from "@/lib/agents/cast";
import { seamDirective } from "@/lib/agents/continuity";
import { lookPromptSuffix } from "@/lib/agents/look";
import { normaliseNegative } from "@/lib/agents/negative-prompt";
import {
  hasNativeAudio,
  imagePromptDirective,
  inheritedOpeningDirective,
  videoPromptDirective,
} from "@/lib/agents/model-directives";
import { familyOf, type ModelFamily } from "@/lib/wangp/family";
import { charactersInFrame, charactersInScene } from "@/lib/agents/scene-cast";
import { explicitnessDirective, isExplicitProject, isExplicitScene } from "@/lib/agents/explicitness";
import {
  gateFramePair,
  gateImagePrompt,
  gateRepairDirective,
  inventedGarments,
  repairImagePrompt,
  type ImageGateContext,
  type PromptGateCode,
} from "@/lib/agents/prompt-gate";
import { isTightShot, seamBreak } from "@/lib/media/seam";
import { wardrobeChangeClause, othersInFrame, othersWardrobeSuffix, wardrobeTimeline } from "@/lib/agents/wardrobe";
import type { SceneWardrobe } from "@/lib/schemas/wardrobe";
import { config } from "@/lib/config";
import {
  continuityNegativeSuffix,
  precedenceDirective,
  sceneCreativeSlice,
  type CreativePlans,
} from "@/lib/agents/creative-context";
import { DEFAULT_SCENE_CONTINUITY, SEGMENT_SECONDS } from "@/lib/types";
import type { Character } from "@/lib/schemas/character";
import type { VisualBible } from "@/lib/schemas/agents";
import type { Project } from "@/lib/schemas/project";
import type { PlanningProvider, ProviderResult } from "@/lib/agents/llm/provider";

/** Planning artifacts the prompt agents read but do not modify. */
export type ScenePromptContext = {
  cast?: readonly Character[];
  visualBible?: VisualBible;
  plans?: CreativePlans;
  /**
   * Rewrite only these scenes, keeping every other scene's stored prompts.
   *
   * The whole run still walks every scene: wardrobe carries forward, and a
   * seam can only be matched against the prompt that precedes it, so a single
   * scene cannot be rebuilt in isolation from the ones before it.
   */
  only?: ReadonlySet<string>;
  existing?: Record<string, ScenePrompts>;
  /** Receives one record per scene per pass, so image and video stay separate. */
  onExecution?: ExecutionCollector;
  /** Reports which scene is being written, for the canvas status line. */
  onProgress?: ProgressReporter;
  correlationId?: string;
};

export const IMAGE_PROMPT_SYSTEM =
  "You are the Image Prompt Agent. For each scene, create a start-frame image prompt and " +
  "end-frame image prompt following the Visual Bible and preserving continuity. Include a " +
  "negative prompt. Return only valid JSON." +
  // Spec 9.5 asked for this and it was dropped in implementation. Without it the
  // agent writes mood and subject but never states the shot, so the model picks
  // its own framing: a scene specified as an extreme close-up came back as a
  // three-quarter shot.
  " Each prompt must describe a single still frame with composition, subject, setting, " +
  "lighting, style, and camera framing. Open every prompt with the shot size and camera height " +
  "— for example 'Extreme close-up, eye level,' — because the opening words carry the most " +
  "weight in the render and framing buried mid-prompt is ignored. Honour the shot plan supplied " +
  "for the scene when there is one." +
  // The two frames are rendered as independent jobs, so anything left vague is
  // reinvented on each pass. A prompt reading "casual contemporary attire"
  // produced black trousers in one frame and blue jeans in the next.
  " The two frames are frozen instants from one continuous shot, a few seconds apart. Describe " +
  "only what is visibly true at that instant: turn an action into a pose, a point of contact, " +
  "where an object now sits, a visible consequence. Never write movement, duration, pace, a " +
  "camera move or a sequence of events — an image has no time in it, and those words are read as " +
  "description and drawn. Every character must wear identical clothing in both, and the " +
  "location, lighting and time of day must match. " +
  // A family of four, described as four separate "X wears ..." clauses, rendered
  // as five people. The count was stated once in prose at the top of the prompt,
  // far from the bodies it governed; restating it beside them fixed it.
  " When the people in shot are described individually, follow their descriptions " +
  "with an explicit headcount — for example 'Exactly four people are in frame: one " +
  "man, one woman, one boy and one girl.' Do not count background crowds, which " +
  "are not individually described. " +
  // A standing man behind a seated pair came back cropped at the neck in every
  // attempt. A lower camera did not fix it and nor did a wider shot size; seating
  // him did, first try. A cropped head is not cosmetic — the next scene inherits
  // the frame, and a person the model cannot see there is deleted from it.
  "Stage everyone in a frame at a compatible height: do not put one person on their feet " +
  "while the others are seated, kneeling or lying down, because the frame crops the odd one " +
  "out at the neck. If the action genuinely requires it, say so and choose a wide or full " +
  "shot that can hold them all head to foot. " +
  "For any character who is not in the supplied cast, state the wardrobe as specific named " +
  "garments with colours and materials — never a vague placeholder such as 'casual attire', " +
  "'contemporary clothing' or 'appropriate outfit' — and repeat that same wardrobe wording " +
  "verbatim in both prompts. Only framing, pose and action may differ between them. " +
  // Non-cast people had no persistent wardrobe at all, so an outfit established
  // in one scene was reinvented in the next.
  "When `otherWardrobe` names a subject and their outfit, that outfit is already established: " +
  "use it, do not invent a different one, and do not restate it in your prompt — it is appended " +
  "automatically, and a second copy makes the model render the person twice. " +
  // Same reasoning as the cast sheet: the look is appended verbatim, so a
  // second mention only doubles the term's weight in the render.
  "Do not restate the project's style or tone; both are appended to every prompt automatically.";

export const videoPromptSystem = (segmentSeconds: number) =>
  "You are the Video Prompt Agent. For each scene, create a WanGP-ready prompt for a " +
  `${segmentSeconds}-second video segment focused on motion, camera movement, action, and ` +
  "scene evolution. Describe only as much action as fits the segment length. " +
  // Spec 9.6, dropped in implementation. The clip is rendered from the start
  // frame, which the model already has as `image_start`, so re-describing the
  // subject spends budget that motion description needs.
  "The start frame is supplied to the video model as an image, so do not re-describe details " +
  "already visible in it — spend the prompt on movement, and mention a fixed detail only when " +
  "it is a continuity constraint that must not drift. State what must remain consistent from " +
  "the start frame. " +
  // The scene's dialogue is the only place spoken audio comes from. Left to the
  // agent's judgement it was summarised away, so a card carrying a real
  // exchange rendered as a clip with a two-word bark in it.
  "Carry the scene's dialogue into the prompt in full and word for word, in quotation marks, " +
  "attributed to whoever says it — it is what the video model speaks, so anything you shorten " +
  "or leave out is not heard. Do not paraphrase it, summarise it, or reduce an exchange to one " +
  "line. Where the scene has no dialogue, do not invent any. " +
  // Every published image-to-video guide says the same thing in different
  // words: a clip has a finite motion budget, and each additional independent
  // change is drawn from the same account as identity and anatomy.
  //
  // Described rather than named. Given the words "dominant action" a model will
  // write "the robot performs its dominant action:" and the video model renders
  // that phrase as description — the instruction arrives in the picture.
  "Give the clip one thing that happens, and at most one smaller movement alongside it, each " +
  "with its direction and pace. One camera move at a time; if the camera is locked, say so " +
  "explicitly rather than omitting it. " +
  "Write only the scene itself. Never restate these instructions, label the parts of your own " +
  "answer, or announce what a sentence is about to do — the video model renders those words " +
  "rather than obeying them. " +
  "Include a negative prompt and generation notes. Return only valid JSON.";

/** The family a project's prompts are being written for, from its model pin. */
function imageFamilyFor(project: Project) {
  return familyOf(project.imageModel || config.wangp.imageModel);
}

/**
 * Lift the identical-wardrobe rule for the one scene that depicts a change.
 *
 * The standing instruction is that both frames must show the same clothing,
 * which is right everywhere except here, where the whole point is that they do
 * not. Stated explicitly because an unaddressed contradiction is resolved by
 * the model rather than by us.
 */
function wardrobeChangeDirective(wardrobe: SceneWardrobe | undefined): string {
  if (!wardrobe?.within.length) return "";
  return (
    " This scene depicts a costume change, so it is the exception to the rule that both frames " +
    "show identical clothing: the start frame wears the outfit named for it and the end frame " +
    "wears the one named for it. Everything else — location, lighting, time of day and every " +
    "other character — still matches across the two."
  );
}

function videoFamilyFor(project: Project) {
  return familyOf(project.videoModel || config.wangp.videoModel);
}

/** Default-length wording, retained for callers that have no project in hand. */
export const VIDEO_PROMPT_SYSTEM = videoPromptSystem(SEGMENT_SECONDS);

const imagePartSchema = scenePromptsSchema.pick({
  startFramePrompt: true,
  endFramePrompt: true,
  imageNegativePrompt: true,
});
const videoPartSchema = scenePromptsSchema.pick({
  videoPromptSegment: true,
  videoNegativePrompt: true,
  // Optional in the schema, so a family that folds sound into the prose simply
  // omits them; without them here the H3 directive would ask for two fields the
  // response could not carry.
  videoSoundscape: true,
  videoScore: true,
  promptQualityChecklist: true,
});

/**
 * Image + Video prompt agents complete each scene draft into a full Scene by
 * attaching prompts (spec Sections 9.5–9.6). Both fall back to deterministic
 * builders when no provider is available.
 *
 * The Visual Bible is passed alongside the scene so the prompt agents can honour
 * the continuity rules they are told to follow, and the pinned cast is passed so
 * a character's locked description reaches the render itself rather than only
 * the plan.
 */
export async function attachScenePrompts(
  project: Project,
  drafts: SceneDraft[],
  provider: PlanningProvider | null,
  context: ScenePromptContext = {},
): Promise<Scene[]> {
  const cast = context.cast ?? [];
  const plans = context.plans;
  const imageFamily = imageFamilyFor(project);
  const videoFamily = videoFamilyFor(project);
  const timeline = wardrobeTimeline(project, drafts, cast);
  const scenes: Scene[] = [];
  // The seam can only be matched by an agent that can see what it is matching.
  let previousEndFramePrompt: string | undefined;
  for (const [index, draft] of drafts.entries()) {
    context.onProgress?.({ phase: "Writing prompts", done: index + 1, total: drafts.length });
    // Only this scene's slice of the Director and Cinematographer plans travels
    // into the prompt. The full documents would crowd out the shot description.
    const slice = sceneCreativeSlice(plans, draft);
    const wardrobe = timeline.get(draft.id);
    // Only the people in this shot. The sheet is appended verbatim, so a
    // character carried into a scene they are absent from is a description of
    // someone the model will then try to put in the picture.
    const sceneCast = charactersInScene(draft, cast);

    // Kept scenes still advance the seam and the wardrobe walk; they just cost
    // nothing and keep whatever was written or hand-edited before.
    const kept = context.only && !context.only.has(draft.id) ? context.existing?.[draft.id] : undefined;
    if (kept) {
      scenes.push({ ...draft, prompts: kept });
      previousEndFramePrompt = kept.endFramePrompt;
      continue;
    }

    let imagePart = buildImagePrompts(project, draft, sceneCast, plans, wardrobe, imageFamily);
    let videoPart = buildVideoPrompts(project, draft, sceneCast, plans, wardrobe, videoFamily);

    // Whether this scene's clip will actually open on the previous scene's end
    // frame. Decided the same way `resolveContinuity` decides it at render
    // time, from the cards alone, so the agent is told before it writes rather
    // than contradicted afterwards.
    const inheritsOpening =
      (project.sceneContinuity ?? DEFAULT_SCENE_CONTINUITY) === "reuse_end_frame" &&
      index > 0 &&
      previousEndFramePrompt !== undefined &&
      !seamBreak(drafts[index - 1]!, draft);

    if (!provider) {
      // Demo mode still reports itself, or a scene written by a template would
      // be indistinguishable from one nobody has provenance for at all.
      for (const pass of ["image_prompt", "video_prompt"] as const) {
        const isImage = pass === "image_prompt";
        const lint = composerLint(
          isImage ? imagePart.startFramePrompt : videoPart.videoPromptSegment,
          isImage ? imageFamily : videoFamily,
          isImage ? "image" : "video",
          draft,
        );
        context.onExecution?.(
          deterministicExecution({
            artifact: `${draft.id}.${pass}`,
            scope: draft.id,
            correlationId: context.correlationId,
            builderVersion: BUILDER_VERSION,
            ...(config.flags.mediaPromptComposerV2
              ? { composerVersion: COMPOSER_VERSION, lint }
              : {}),
          }),
        );
      }
    }

    if (provider) {
      const user = JSON.stringify({
        project,
        scene: draft,
        previousEndFramePrompt,
        // Named in the payload rather than left to the system prompt, because
        // the scene card sitting beside it describes the opening the storyboard
        // intended and that is what the agent follows. A scene continuing from
        // the one before it does not open where its card says — it opens on the
        // picture already rendered, and has to move from there to the shot the
        // card describes.
        openingFrame: inheritsOpening
          ? {
              isThisClipsFirstFrame: true,
              shows: previousEndFramePrompt,
              instruction:
                "This clip begins on exactly this image, which is already rendered. Open the " +
                "prompt at what it shows — not at the shot this scene's card describes — and " +
                "write the move from there to that shot as the action of the clip.",
            }
          : undefined,
        visualBible: context.visualBible,
        cast: sceneCast,
        sceneIntent: slice.intent,
        shotPlan: slice.shotPlan,
        artDirection: plans?.artDirectionPlan,
        // Only the changing scene is told about a change; every other scene
        // sees a settled wardrobe and has no reason to write one.
        wardrobeChange: wardrobe?.within.length
          ? wardrobeChangeClause(
              wardrobe.within,
              cast,
              wardrobe.start,
              wardrobe.othersStart,
            ).trim()
          : undefined,
        // Established outfits for people who are not pinned cast. Without this
        // an unnamed man's shirt drifts colour from one scene to the next.
        otherWardrobe: Object.keys(wardrobe?.othersStart ?? {}).length
          ? wardrobe!.othersStart
          : undefined,
        cameraRules: plans?.cinematographyPlan
          ? {
              cameraLanguage: plans.cinematographyPlan.cameraLanguage,
              lensAndFramingRules: plans.cinematographyPlan.lensAndFramingRules,
              movementRules: plans.cinematographyPlan.movementRules,
              lightingRules: plans.cinematographyPlan.lightingRules,
            }
          : undefined,
        forbiddenContradictions: plans?.worldBible?.forbiddenContradictions,
      });
      const gate: ImageGateContext = {
        scene: draft,
        participants: sceneCast.map((c) => c.name),
        explicit: isExplicitProject(project) || isExplicitScene(draft),
        establishedWardrobe: {
          start: establishedGarments(wardrobe?.start, wardrobe?.othersStart, sceneCast),
          end: establishedGarments(wardrobe?.end, wardrobe?.othersEnd, sceneCast),
        },
        wardrobeChange: Boolean(wardrobe?.within.length),
        inheritsOpening,
      };
      const gated: { codes: PromptGateCode[] } = { codes: [] };
      const imageResult = await executeArtifact<ImagePart>({
        artifact: `${draft.id}.image_prompt`,
        scope: draft.id,
        correlationId: context.correlationId,
        promptVersion: PROMPT_VERSIONS.imagePrompt,
        builderVersion: BUILDER_VERSION,
        provider,
        onExecution: context.onExecution,
        llm: gatedImageCall(
          provider,
          IMAGE_PROMPT_SYSTEM +
            explicitnessDirective(project, "image", draft) +
            wardrobeChangeDirective(wardrobe) +
            imagePromptDirective(imageFamily) +
            seamDirective(project) +
            castSystemDirective(sceneCast, true) +
            precedenceDirective(sceneCast, plans),
          user,
          gate,
          gated,
        ),
        // A prompt the model wrote and the gate had to patch is neither its
        // work nor the builder's, and a run that needed patching is a run
        // whose model is not doing the job.
        outcome: () =>
          gated.codes.length
            ? {
                source: "hybrid" as const,
                fallbackReason: "invalid_set" as const,
                detail: gated.codes.join(","),
              }
            : {},
        fallback: () => imagePart,
      });
      if (gated.codes.length) {
        logEvent("prompt.gate", { scene: draft.id, kind: "image", codes: gated.codes });
      }
      // The deterministic builder is a template, not an author: it can keep the
      // card's own words but cannot turn an indirect description into a
      // concrete one. On explicit work that is a visible downgrade, so it is
      // reported rather than absorbed.
      if (imageResult.execution.source === "deterministic" && gate.explicit) {
        logEvent("prompt.explicit_fallback", {
          scene: draft.id,
          reason: imageResult.execution.fallbackReason ?? "unknown",
        });
      }
      if (imageResult.execution.source !== "deterministic") {
        imagePart = withCastEnforced(
          normaliseImageResult(imageResult.value, project, draft, plans, wardrobe, imageFamily),
          sceneCast,
          plans,
          project,
          wardrobe,
          draft,
        );
      }

      const videoResult = await executeArtifact<VideoPart>({
        artifact: `${draft.id}.video_prompt`,
        scope: draft.id,
        correlationId: context.correlationId,
        promptVersion: PROMPT_VERSIONS.videoPrompt,
        builderVersion: BUILDER_VERSION,
        provider,
        onExecution: context.onExecution,
        llm: providerCall(
          provider,
          videoPromptSystem(project.segmentSeconds) +
            explicitnessDirective(project, "video", draft) +
            videoPromptDirective(videoFamily, {
              segmentSeconds: project.segmentSeconds,
              nativeAudio: hasNativeAudio(videoFamily),
            }) +
            (inheritsOpening ? inheritedOpeningDirective(previousEndFramePrompt) : "") +
            castSystemDirective(sceneCast, true) +
            precedenceDirective(sceneCast, plans),
          user,
          videoPartSchema,
        ),
        fallback: () => videoPart,
      });
      if (videoResult.execution.source === "llm") {
        videoPart = withCastEnforcedVideo(
          normaliseVideoResult(videoResult.value, draft, videoFamily),
          sceneCast,
          plans,
          project,
          wardrobe,
        );
      }
    }

    scenes.push({
      ...draft,
      charactersPresent: sceneCast.map((c) => c.name),
      prompts: { ...imagePart, ...videoPart, videoPromptFamily: videoFamily },
    });
    previousEndFramePrompt = imagePart.endFramePrompt;
  }
  return scenes;
}

type ImagePart = z.infer<typeof imagePartSchema>;
type VideoPart = z.infer<typeof videoPartSchema>;

/** Both frames' findings, deduplicated: a fault in either is a fault in the pair. */
function gateFindings(part: ImagePart, gate: ImageGateContext): PromptGateCode[] {
  return [
    ...new Set([
      ...gateImagePrompt(part.startFramePrompt, "start", gate),
      ...gateImagePrompt(part.endFramePrompt, "end", gate),
      ...gateFramePair(part.startFramePrompt, part.endFramePrompt),
    ]),
  ];
}

function repairPart(part: ImagePart, gate: ImageGateContext): ImagePart {
  const start = gateImagePrompt(part.startFramePrompt, "start", gate);
  const end = gateImagePrompt(part.endFramePrompt, "end", gate);
  const startFramePrompt = start.length
    ? repairImagePrompt(part.startFramePrompt, "start", start, gate)
    : part.startFramePrompt;
  const endFramePrompt = end.length
    ? repairImagePrompt(part.endFramePrompt, "end", end, gate)
    : part.endFramePrompt;
  // A garment the model invented for a participant cannot be argued away in
  // the positive prompt, where naming it at all embeds it. The negative is the
  // only place "not this" means anything.
  const invented = [
    ...new Set([
      ...inventedGarments(startFramePrompt, gate.establishedWardrobe?.start),
      ...inventedGarments(endFramePrompt, gate.establishedWardrobe?.end),
    ]),
  ];
  return {
    startFramePrompt,
    endFramePrompt,
    imageNegativePrompt: invented.length
      ? `${part.imageNegativePrompt}, ${invented.join(", ")}`
      : part.imageNegativePrompt,
  };
}

/**
 * The garments this scene genuinely establishes for the people in it.
 *
 * An outfit somebody chose is legitimate in any scene. An outfit the model
 * invented for a participant in a sex act is the failure — it is appended last,
 * outranks the act, and produced a man in black silk trousers performing oral
 * sex. This is what tells the two apart.
 */
function establishedGarments(
  cast: Record<string, string> | undefined,
  others: Record<string, string> | undefined,
  sceneCast: readonly Character[],
): string {
  const inScene = new Set(sceneCast.map((c) => c.id));
  const worn = Object.entries(cast ?? {})
    .filter(([id]) => inScene.has(id))
    .map(([, outfit]) => outfit);
  return [...worn, ...Object.values(others ?? {})].join(" ").toLocaleLowerCase();
}

/**
 * The image call with the acceptance gate around it.
 *
 * A schema-valid answer is not a usable one: three non-empty strings satisfy
 * the contract whether or not they describe the scene. When the gate rejects
 * the answer the model is told exactly what it left out and gets one retry —
 * cheaper than a wrong render and far cheaper than a wrong batch. If the retry
 * is no better, the card's own concrete wording is put back deterministically
 * and the execution says so, because silently shipping the coy version is the
 * one outcome with no evidence in it.
 */
function gatedImageCall(
  provider: PlanningProvider,
  system: string,
  user: string,
  gate: ImageGateContext,
  gated: { codes: PromptGateCode[] },
): () => Promise<ProviderResult<ImagePart>> {
  return async () => {
    const first = await providerCall(provider, system, user, imagePartSchema)();
    if (!first.ok) return first;
    const codes = gateFindings(first.value, gate);
    if (!codes.length) return first;

    let best = first;
    const retry = await providerCall(
      provider,
      system + gateRepairDirective(codes, gate),
      user,
      imagePartSchema,
    )();
    if (retry.ok) {
      const retryCodes = gateFindings(retry.value, gate);
      if (!retryCodes.length) return retry;
      if (retryCodes.length < codes.length) best = retry;
    }

    gated.codes = gateFindings(best.value, gate);
    return { ...best, value: repairPart(best.value, gate) };
  };
}

/**
 * Lint codes for the final prompt, recorded on the execution and in telemetry.
 *
 * Codes only, never prompt text: §13 forbids logging prompts, and a scene's
 * dialogue is exactly the sort of private content a log should not carry.
 */
function composerLint(
  text: string,
  family: ModelFamily,
  kind: "image" | "video",
  draft: SceneDraft,
): string[] {
  const seconds = draft.trimAtEndSeconds ?? draft.targetDurationSeconds;
  const findings = lintRendered(text, family, kind, kind === "image" ? 0 : seconds);
  const codes = findings.map((f) => f.code as string);
  if (kind === "video" && draft.dialogue?.length) {
    if (missingDialogue(text, draft.dialogue).length) codes.push("dialogue_dropped");
  }
  logEvent("prompt.composed", {
    scene: draft.id,
    family,
    kind,
    version: COMPOSER_VERSION,
    chars: text.length,
    lint: codes,
  });
  return codes;
}

/**
 * Hold a model-authored image prompt to the same contract as the deterministic
 * one, before enforcement appends the canonical suffixes.
 *
 * A no-op while the composer is off, so the LLM path changes only when the
 * deterministic path does — the two are meant to agree, and rolling one back
 * without the other would recreate the drift SPEC-003 exists to close.
 */
function normaliseImageResult(
  part: ImagePart,
  project: Project,
  draft: SceneDraft,
  plans: CreativePlans | undefined,
  wardrobe: SceneWardrobe | undefined,
  family: ModelFamily,
): ImagePart {
  if (!config.flags.mediaPromptComposerV2) return part;
  const spec = buildMediaPromptSpec(project, draft, plans, wardrobe);
  return {
    ...part,
    startFramePrompt: normaliseImagePrompt(part.startFramePrompt, spec, family).text,
    endFramePrompt: normaliseImagePrompt(part.endFramePrompt, spec, family).text,
  };
}

function normaliseVideoResult(
  part: VideoPart,
  draft: SceneDraft,
  family: ModelFamily,
): VideoPart {
  if (!config.flags.mediaPromptComposerV2) return part;
  const seconds = draft.trimAtEndSeconds ?? draft.targetDurationSeconds;
  return {
    ...part,
    videoPromptSegment: normaliseVideoPrompt(part.videoPromptSegment, family, seconds).text,
  };
}

/**
 * Re-append the look, the cast sheet and world-continuity constraints to
 * model-authored prompts.
 *
 * Each scene is rendered as an independent job, so a description the model
 * summarised away in scene 3 is a face that changes on screen. The same holds
 * for the project's style and tone: left to the model, they landed in some
 * scenes' prompts and not others, and the look drifted across the cut.
 * Appending the canonical text costs a few tokens and removes both failures.
 */
function withCastEnforced(
  part: ImagePart,
  cast: readonly Character[],
  plans: CreativePlans | undefined,
  project: Project,
  wardrobe: SceneWardrobe | undefined,
  draft: SceneDraft,
): ImagePart {
  const negative = `${castNegativeSuffix(cast, part.imageNegativePrompt)}${continuityNegativeSuffix(plans)}`;
  // Each frame is read for its own shot size: a scene can push from a medium
  // into a close-up, and only the tighter end needs the sheet trimming.
  const sheetFor = (prompt: string) => ({
    faceVisible: draft.subjectFaceVisible !== false,
    tightShot: isTightShot(prompt),
  });
  const frameCast = (prompt: string) => charactersInFrame(prompt, cast);
  return {
    startFramePrompt: `${part.startFramePrompt}${lookPromptSuffix(project, part.startFramePrompt)}${castPromptSuffix(frameCast(part.startFramePrompt), wardrobe?.start, sheetFor(part.startFramePrompt))}${othersWardrobeSuffix(othersInFrame(part.startFramePrompt, wardrobe?.othersStart ?? {}))}`,
    endFramePrompt: `${part.endFramePrompt}${lookPromptSuffix(project, part.endFramePrompt)}${castPromptSuffix(frameCast(part.endFramePrompt), wardrobe?.end, sheetFor(part.endFramePrompt))}${othersWardrobeSuffix(othersInFrame(part.endFramePrompt, wardrobe?.othersEnd ?? {}))}`,
    imageNegativePrompt: normaliseNegative(`${part.imageNegativePrompt}${negative}`),
  };
}

function withCastEnforcedVideo(
  part: VideoPart,
  cast: readonly Character[],
  plans: CreativePlans | undefined,
  project: Project,
  wardrobe: SceneWardrobe | undefined,
): VideoPart {
  const negative = `${castNegativeSuffix(cast, part.videoNegativePrompt)}${continuityNegativeSuffix(plans)}`;
  const change = wardrobeChangeClause(
    wardrobe?.within ?? [],
    cast,
    wardrobe?.start ?? {},
    wardrobe?.othersStart ?? {},
  );
  return {
    ...part,
    // The look is still appended — a cut drifts in grade over twenty segments
    // otherwise — but the cast arrives as names, since the start frame already
    // carries the appearance the sheet would spell out.
    videoPromptSegment: `${part.videoPromptSegment}${lookPromptSuffix(project, part.videoPromptSegment)}${castContinuityClause(cast, change)}`,
    videoNegativePrompt: normaliseNegative(`${part.videoNegativePrompt}${negative}`),
  };
}
