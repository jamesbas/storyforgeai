import { z } from "zod";
import {
  scenePromptsSchema,
  type Scene,
  type SceneDraft,
  type ScenePrompts,
} from "@/lib/schemas/storyboard";
import { buildImagePrompts, buildVideoPrompts } from "@/lib/agents/mock-agents";
import { buildMediaPromptSpec } from "@/lib/agents/media-prompt-builder";
import { COMPOSER_VERSION, countWords, lintRendered, splitSentences, wordBudget, type BudgetContext } from "@/lib/agents/media-prompt-spec";
import { trimToBudget } from "@/lib/agents/media-prompt-renderers";
import { logEvent } from "@/lib/telemetry";
import {
  missingDialogue,
  normaliseImagePrompt,
  normaliseVideoPrompt,
} from "@/lib/agents/media-prompt-normalise";
import {
  composeExecution,
  deterministicExecution,
  executeArtifact,
  providerCall,
  type ExecutionCollector,
} from "@/lib/agents/provenance";
import { BUILDER_VERSION, PROMPT_VERSIONS } from "@/lib/agents/prompt-version";
import { DEFERRED_VIDEO_PROMPT } from "@/lib/agents/prompt-family";
import { projectSetting, settingSuffix } from "@/lib/agents/setting-anchor";
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
import { familyOf, isFiboFamily, type ModelFamily } from "@/lib/wangp/family";
import { writeFiboPrompts } from "@/lib/agents/fibo-prompt";
import {
  concisePromptDirective,
  SHORTEN_PROMPT_DIRECTIVE,
  visualWordCount,
} from "@/lib/agents/prompt-concision";
import { charactersInFrame, charactersInScene } from "@/lib/agents/scene-cast";
import { explicitnessDirective, isExplicitProject, isExplicitScene } from "@/lib/agents/explicitness";
import {
  gateFramePair,
  gateImagePrompt,
  gateRepairDirective,
  inventedGarments,
  statedClothing,
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
import { DEFAULT_SCENE_CONTINUITY, generationStages, SEGMENT_SECONDS } from "@/lib/types";
import type { Character } from "@/lib/schemas/character";
import type { VisualBible } from "@/lib/schemas/agents";
import type { Project } from "@/lib/schemas/project";
import type { PlanningProvider, ProviderResult } from "@/lib/agents/llm/provider";
import type { PromptBudgetSettings } from "@/lib/schemas/prompt-budget-settings";
import { resolvePromptBudgetSettings } from "@/lib/services/prompt-budget-settings-service";
import { statedHeadcount } from "@/lib/media/seam";
/**
 * The two prompt passes, each its own model call.
 *
 * They are stale for different reasons: an image prompt is written for the
 * image family, a clip prompt for the video family, and the guidance each is
 * given changes on its own schedule. Naming them lets a rewrite spend calls
 * only on the side that actually moved.
 */
export type PromptPass = "image" | "video";

/** Planning artifacts the prompt agents read but do not modify. */
export type ScenePromptContext = {
  cast?: readonly Character[];
  visualBible?: VisualBible;
  plans?: CreativePlans;
  /** Saved prompt length limits. Read from settings when absent. */
  budgets?: PromptBudgetSettings;
  /**
   * Rewrite only these scenes, keeping every other scene's stored prompts.
   *
   * The whole run still walks every scene: wardrobe carries forward, and a
   * seam can only be matched against the prompt that precedes it, so a single
   * scene cannot be rebuilt in isolation from the ones before it.
   */
  only?: ReadonlySet<string>;
  existing?: Record<string, ScenePrompts>;
  /**
   * Write only these passes, keeping the other pass's stored prompts.
   *
   * Absent means both. Changing the video model pin does not touch how a still
   * frame should be described, so rewriting the image pass alongside it buys
   * nothing: it spends a second model call per scene to replace a prompt with
   * another copy of the same thing, and takes any hand edits on that side with
   * it. A pass can only be skipped where `existing` carries the prompts it
   * would otherwise write — there is nothing else to keep.
   */
  passes?: readonly PromptPass[];
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
  // Shot size, height, lens and movement all describe one axis of camera
  // placement. Where the camera stands *around* the subject was never named,
  // and that is the axis that decides whether the thing being described faces
  // the lens. Live: a frame whose entire content was a hand gripping a
  // backside opened "Medium close-up, eye level" with the pair staged facing
  // each other, so both bodies were side-on with her backside away from the
  // lens — and the model drew the hand on her hip, the only place it could see.
  " Before you write a frame, decide what the single most important thing in it is — the point " +
  "of contact, the part of the body, the object — and put the camera where that thing is " +
  "visible. Name the angle alongside the height: front, three-quarter, profile, three-quarter " +
  "rear, rear, or over-the-shoulder. Then turn the bodies to match and say so — 'she is turned " +
  "three-quarters away so her back is to the right of frame' — and say which side of the frame " +
  "the focal point occupies. A part on the far side of a body from the lens cannot be drawn, " +
  "and the model does not refuse: it moves the contact somewhere it can see, so a hand on a " +
  "backside becomes a hand on a hip and the frame quietly shows the wrong thing. Where two " +
  "people touch, state which of them is nearer the camera. " +
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
  // The count is what suppresses duplication, and it only works while it is
  // short. An agent told to describe each character in the sentence that places
  // them chose the headcount sentence for one of them, and sixty words of
  // appearance and pose landed between "Exactly three people" and the full stop.
  "The headcount is a sentence of its own and carries counts and role nouns only: " +
  "no appearance, clothing, pose or placement belongs in it. Describe and place " +
  "each person in their own separate sentence. " +
  // A three-hander written as a close-up rendered the first person described
  // and dropped the other two: the frame had nowhere to put them. The model
  // does not refuse an impossible framing, it just crops until the shot fits.
  "Choose a shot size that can hold everyone you put in the frame. A close-up or extreme " +
  "close-up is a frame around one person; two people need a medium close-up or wider, three " +
  "need a medium shot or wider, and four or more a medium wide shot or wider. If you want a " +
  "tight frame on one point of contact, put only the bodies that reach it in the shot and say " +
  "so in the headcount. " +
  // A standing man behind a seated pair came back cropped at the neck in every
  // attempt. A lower camera did not fix it and nor did a wider shot size; seating
  // him did, first try. A cropped head is not cosmetic — the next scene inherits
  // the frame, and a person the model cannot see there is deleted from it.
  "Stage everyone in a frame at a compatible height: do not put one person on their feet " +
  "while the others are seated, kneeling or lying down, because the frame crops the odd one " +
  "out at the neck. If the action genuinely requires it, say so and choose a wide or full " +
  "shot that can hold them all head to foot. " +
  "For any character who is not in the supplied cast, state the wardrobe as specific named " +
  "garments with colours — never a vague placeholder such as 'casual attire', " +
  "'contemporary clothing' or 'appropriate outfit' — and repeat that same wardrobe wording " +
  "verbatim in both prompts. Only framing, pose and action may differ between them. " +
  // Non-cast people had no persistent wardrobe at all, so an outfit established
  // in one scene was reinvented in the next.
  "When `otherWardrobe` names a subject and their outfit, that outfit is already established: " +
  "use it, do not invent a different one, and keep it bound to the person it belongs to. " +
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
  const wantsImage = !context.passes || context.passes.includes("image");
  const wantsVideo = !context.passes || context.passes.includes("video");
  const imageFamily = imageFamilyFor(project);
  const videoFamily = videoFamilyFor(project);
  const timeline = wardrobeTimeline(project, drafts, cast);
  const budgets = context.budgets ?? (await resolvePromptBudgetSettings());
  // The world bible's own statement of where the story happens, carried into
  // frames that do not already name it. Absent when the bible states none.
  const sceneSetting = projectSetting(plans);
  const videoBudget = { settings: budgets };
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
    // Every named person in the shot has to fit in the frame, so the image
    // ceiling grows with the count. Unnamed people the prompt adds are counted
    // from its own headcount when the frame is checked.
    const imageBudgetContext = { settings: budgets, people: sceneCast.length };

    // Kept scenes still advance the seam and the wardrobe walk; they just cost
    // nothing and keep whatever was written or hand-edited before.
    const kept = context.only && !context.only.has(draft.id) ? context.existing?.[draft.id] : undefined;
    if (kept) {
      scenes.push({ ...draft, prompts: kept });
      previousEndFramePrompt = kept.endFramePrompt;
      continue;
    }

    // A pass is only skippable while there is something to keep in its place.
    // Without stored prompts the alternative to writing it is the deterministic
    // builder, which would quietly downgrade a model-authored prompt.
    const carried = context.existing?.[draft.id];
    const skipImage = !wantsImage && carried !== undefined;
    // A project that never renders a clip has no use for the clip prompt, and it
    // is the slower half of this run: a model call per scene to write something
    // nothing reads. It is stamped "deferred" so that the day the project moves
    // to a mode that renders video, the storyboard says these were never
    // written instead of passing the builder's template off as the real thing.
    // Asking for the video pass by name still runs it.
    const deferVideo = wantsVideo && !context.passes && !generationStages(project.generationMode).video;
    const skipVideo = (!wantsVideo || deferVideo) && carried !== undefined;
    const noVideoCall = skipVideo || deferVideo;

    let imagePart: ImagePart = skipImage
      ? {
          startFramePrompt: carried.startFramePrompt,
          endFramePrompt: carried.endFramePrompt,
          imageNegativePrompt: carried.imageNegativePrompt,
        }
      : buildImagePrompts(project, draft, sceneCast, plans, wardrobe, imageFamily, imageBudgetContext);
    let videoPart: VideoPart = skipVideo
      ? {
          videoPromptSegment: carried.videoPromptSegment,
          videoNegativePrompt: carried.videoNegativePrompt,
          videoSoundscape: carried.videoSoundscape,
          videoScore: carried.videoScore,
          promptQualityChecklist: carried.promptQualityChecklist,
        }
      : buildVideoPrompts(project, draft, sceneCast, plans, wardrobe, videoFamily, videoBudget);

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
        // A pass that was not rewritten keeps the provenance of the run that
        // did write it; recording it again would date a prompt to a run that
        // never touched it.
        if (isImage ? skipImage : skipVideo) continue;
        const lint = composerLint(
          isImage ? imagePart.startFramePrompt : videoPart.videoPromptSegment,
          isImage ? imageFamily : videoFamily,
          isImage ? "image" : "video",
          draft,
          isImage ? imageBudgetContext : videoBudget,
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
      const userContext = {
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
      };
      const user = JSON.stringify(userContext);
      const cardClothing = statedClothing(draft);
      const gate: ImageGateContext = {
        scene: draft,
        participants: sceneCast.map((c) => c.name),
        explicit: isExplicitProject(project) || isExplicitScene(draft),
        establishedWardrobe: {
          start: `${establishedGarments(
            wardrobe?.start,
            wardrobe?.othersStart,
            sceneCast,
            context.visualBible?.characters,
          )} ${cardClothing}`,
          end: `${establishedGarments(
            wardrobe?.end,
            wardrobe?.othersEnd,
            sceneCast,
            context.visualBible?.characters,
          )} ${cardClothing}`,
        },
        wardrobeChange: Boolean(wardrobe?.within.length),
        inheritsOpening,
        clipCarriesArrivals: generationStages(project.generationMode).video,
      };
      const gated: { codes: PromptGateCode[]; repaired: PromptGateCode[]; unresolved: PromptGateCode[]; trimmed: boolean } = {
        codes: [], repaired: [], unresolved: [], trimmed: false,
      };
      const gatedVideo: ClipSalvage = { initial: [], salvaged: [] };
      const imageResult = skipImage
        ? null
        : await executeArtifact<ImagePart>({
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
                precedenceDirective(sceneCast, plans) +
                concisePromptDirective(imageFamily, "image", 0, imageBudgetContext),
              user,
              gate,
              gated,
              imageBudget(
                imageFamily,
                sceneCast.map((character) => character.name),
                (part) =>
                  withCastEnforced(
                    normaliseImageResult(part, project, draft, plans, wardrobe, imageFamily),
                    sceneCast, plans, project, wardrobe, draft, sceneSetting,
                  ),
                imageBudgetContext,
              ),
            ),
            // A prompt the model wrote and the gate had to patch is neither its
            // work nor the builder's, and a run that needed patching is a run
            // whose model is not doing the job.
            outcome: () => {
              const parts = [
                ...(gated.repaired.length ? [`repaired=${gated.repaired.join(",")}`] : []),
                ...(gated.unresolved.length ? [`unresolved=${gated.unresolved.join(",")}`] : []),
                ...(gated.trimmed ? ["trimmed=over_budget"] : []),
              ];
              if (!parts.length) return {};
              return {
                source: "hybrid" as const,
                detail: parts.join("; "),
                // Trimming alone is routine and says nothing against the model;
                // a gate finding is what marks the run degraded.
                ...(gated.codes.length ? { fallbackReason: "invalid_set" as const } : {}),
              };
            },
            fallback: () => imagePart,
          });
      if (gated.codes.length) {
        logEvent("prompt.gate", {
          scene: draft.id,
          kind: "image",
          codes: gated.codes,
          unresolved: gated.unresolved,
        });
      }
      // The deterministic builder is a template, not an author: it can keep the
      // card's own words but cannot turn an indirect description into a
      // concrete one. On explicit work that is a visible downgrade, so it is
      // reported rather than absorbed.
      if (imageResult?.execution.source === "deterministic" && gate.explicit) {
        logEvent("prompt.explicit_fallback", {
          scene: draft.id,
          reason: imageResult.execution.fallbackReason ?? "unknown",
        });
      }
      if (imageResult && imageResult.execution.source !== "deterministic") {
        imagePart = withCastEnforced(
          normaliseImageResult(imageResult.value, project, draft, plans, wardrobe, imageFamily),
          sceneCast,
          plans,
          project,
          wardrobe,
          draft,
          sceneSetting,
        );
      }

      const videoResult = noVideoCall
        ? null
        : await executeArtifact<VideoPart>({
            artifact: `${draft.id}.video_prompt`,
            scope: draft.id,
            correlationId: context.correlationId,
            promptVersion: PROMPT_VERSIONS.videoPrompt,
            builderVersion: BUILDER_VERSION,
            provider,
            onExecution: context.onExecution,
            llm: gatedVideoCall(
              provider,
              videoPromptSystem(project.segmentSeconds) +
                explicitnessDirective(project, "video", draft) +
                videoPromptDirective(videoFamily, {
                  segmentSeconds: project.segmentSeconds,
                  nativeAudio: hasNativeAudio(videoFamily),
                }) +
                (inheritsOpening ? inheritedOpeningDirective(previousEndFramePrompt) : "") +
                videoCastDirective(sceneCast, videoFamily) +
                precedenceDirective(sceneCast, plans) +
                concisePromptDirective(videoFamily, "video", project.segmentSeconds, videoBudget),
              JSON.stringify({
                ...userContext,
                keyframes: {
                  start: inheritsOpening ? previousEndFramePrompt : imagePart.startFramePrompt,
                  end: imagePart.endFramePrompt,
                  instruction:
                    "These are the established endpoints for this clip. Preserve their people, " +
                    "roles and spatial relationships. Describe only the changes connecting them; " +
                    "do not invent a different opening pose or silently swap participants.",
                },
              }),
              draft,
              clipBudget(
                videoFamily,
                draft.trimAtEndSeconds ?? draft.targetDurationSeconds,
                (part) => withCastEnforcedVideo(part, sceneCast, plans, wardrobe),
                videoBudget,
              ),
              gatedVideo,
            ),
            outcome: () => {
              const notes = [
                ...(gatedVideo.initial.length ? [`found=${gatedVideo.initial.join(",")}`] : []),
                ...(gatedVideo.salvaged.length ? [`salvaged=${gatedVideo.salvaged.join(",")}`] : []),
              ];
              return notes.length
                ? { source: "hybrid" as const, detail: notes.join("; ") }
                : {};
            },
            fallback: () => videoPart,
          });
      if (videoResult && videoResult.execution.source !== "deterministic") {
        videoPart = withCastEnforcedVideo(
          normaliseVideoResult(videoResult.value, draft, videoFamily),
          sceneCast,
          plans,
          wardrobe,
        );
      }
      if (deferVideo) {
        context.onExecution?.(
          composeExecution({
            artifact: `${draft.id}.video_prompt`,
            scope: draft.id,
            correlationId: context.correlationId,
            builderVersion: BUILDER_VERSION,
            source: "deterministic",
            detail: "deferred: this project does not render video",
            startedAt: new Date(),
          }),
        );
      }
    }

    if (!skipImage && isFiboFamily(imageFamily)) {
      const vgl = await writeFiboPrompts({
        start: imagePart.startFramePrompt,
        end: imagePart.endFramePrompt,
        sceneId: draft.id,
        provider,
        onExecution: context.onExecution,
        correlationId: context.correlationId,
        participants: sceneCast.map((character) => character.name),
      });
      imagePart = { ...imagePart, startFramePrompt: vgl.start, endFramePrompt: vgl.end };
    }

    scenes.push({
      ...draft,
      charactersPresent: sceneCast.map((c) => c.name),
      prompts: {
        ...imagePart,
        ...videoPart,
        // The stamp records which family the clip prompt was written for, so a
        // pass that did not run must keep the stamp it already had. Restamping
        // it here would clear the staleness warning without rewriting anything.
        videoPromptFamily: skipVideo
          ? carried?.videoPromptFamily
          : deferVideo
            ? DEFERRED_VIDEO_PROMPT
            : videoFamily,
      },
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
      ...gateFramePair(part.startFramePrompt, part.endFramePrompt, {
        clipCarriesArrivals: gate.clipCarriesArrivals ?? true,
      }),
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
  //
  // Read from what the model wrote, not from the repair: the repair takes the
  // garment back out of the positive prompt, and an exclusion derived from the
  // repaired text would therefore always be empty. It has to come from the
  // sentence that was wrong.
  const invented = [
    ...new Set([
      ...inventedGarments(part.startFramePrompt, gate.establishedWardrobe?.start),
      ...inventedGarments(part.endFramePrompt, gate.establishedWardrobe?.end),
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
 *
 * The visual bible counts, and leaving it out was the whole bug. Only pinned
 * cast have a wardrobe field, so everybody else — a husband, a waiter, anyone
 * the story invented rather than the library — had no authorised clothing at
 * all, and every garment written for them read as invented. Live, that rewrote
 * a fully dressed husband to "naked" in nine consecutive scenes and stripped a
 * waiter's uniform the moment he walked through the door. Clothes come off here
 * by wardrobe change, which is explicit and per scene; anything else is the
 * model's invention and still goes.
 */
export function establishedGarments(
  cast: Record<string, string> | undefined,
  others: Record<string, string> | undefined,
  sceneCast: readonly Character[],
  bible: readonly { description: string }[] | undefined,
): string {
  const inScene = new Set(sceneCast.map((c) => c.id));
  const worn = Object.entries(cast ?? {})
    .filter(([id]) => inScene.has(id))
    .map(([, outfit]) => outfit);
  return [...worn, ...Object.values(others ?? {}), ...(bible ?? []).map((c) => c.description)]
    .join(" ")
    .toLocaleLowerCase();
}

type ImageBudget = {
  exceeds: (part: ImagePart) => boolean;
  /** Shortens what the model wrote, never what is appended after it. */
  fit: (part: ImagePart) => ImagePart;
  /** Words each frame prompt may use once the automatic text is counted. */
  bodyWords: (part: ImagePart) => number;
};

/** Below this the model has too little room to describe anyone at all. */
const MIN_FRAME_WORDS = 45;

/**
 * The image word ceiling, applied to what the model can actually control.
 *
 * The ceiling counts the look, cast sheet and wardrobe text appended after the
 * model's answer, which the model never sees. Failing a scene for being over it
 * threw away a model-authored prompt and substituted the template — which is
 * three times longer, because it carries the whole scene card. So the overflow
 * is trimmed from the end of the model's own prompt instead, where the
 * directive already tells it the optional detail lives.
 */
function imageBudget(
  family: ModelFamily,
  participants: readonly string[],
  finalise: (part: ImagePart) => ImagePart,
  budget: BudgetContext,
): ImageBudget {
  const frames = ["startFramePrompt", "endFramePrompt"] as const;
  // A frame may state a larger headcount than the cast pinned for the scene.
  const ceilingFor = (text: string) =>
    wordBudget(family, "image", 0, {
      ...budget,
      people: Math.max(budget.people ?? 0, statedHeadcount(text) ?? 0),
    });
  const room = (part: ImagePart, frame: (typeof frames)[number]) => {
    const final = finalise(part)[frame];
    const appended = countWords(final) - countWords(part[frame]);
    return Math.max(MIN_FRAME_WORDS, ceilingFor(final) - Math.max(0, appended));
  };
  return {
    exceeds: (part) => {
      const final = finalise(part);
      return frames.some((frame) => countWords(final[frame]) > ceilingFor(final[frame]));
    },
    bodyWords: (part) => Math.min(...frames.map((frame) => room(part, frame))),
    fit: (part) => {
      const fitted = { ...part };
      for (const frame of frames) {
        const limit = room(part, frame);
        if (countWords(part[frame]) <= limit) continue;
        // The first sentence naming each person stays, or the cast sheet that
        // is appended for people the prompt names would go with it.
        const sentences = splitSentences(part[frame]);
        const named = participants
          .map((name) => sentences.find((s) => s.toLowerCase().includes(name.trim().toLowerCase())))
          .filter((s): s is string => Boolean(s));
        fitted[frame] = trimToBudget(part[frame], limit, 1, named);
      }
      return fitted;
    },
  };
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
  gated: {
    codes: PromptGateCode[];
    repaired: PromptGateCode[];
    unresolved: PromptGateCode[];
    trimmed: boolean;
  },
  budget: ImageBudget,
): () => Promise<ProviderResult<ImagePart>> {
  return async () => {
    const first = await providerCall(provider, system, user, imagePartSchema, {
      systemPromptScope: "render_prompts",
    })();
    if (!first.ok) return first;
    const codes = gateFindings(first.value, gate);
    if (!codes.length && !budget.exceeds(first.value)) return first;

    let best = first;
    const retry = await providerCall(
      provider,
      system +
        gateRepairDirective(codes, gate) +
        SHORTEN_PROMPT_DIRECTIVE +
        ` Each frame prompt must be at most ${budget.bodyWords(first.value)} words, because the ` +
        "project's look and the cast descriptions are appended automatically after it.",
      `${user}\nPrevious answer to rewrite:\n${JSON.stringify(first.value)}`,
      imagePartSchema,
      { systemPromptScope: "render_prompts" },
    )();
    if (retry.ok) {
      const retryCodes = gateFindings(retry.value, gate);
      if (!retryCodes.length && !budget.exceeds(retry.value)) return retry;
      if (retryCodes.length <= codes.length) best = retry;
    }

    gated.codes = gateFindings(best.value, gate);
    let repaired = repairPart(best.value, gate);
    if (budget.exceeds(repaired)) {
      repaired = budget.fit(repaired);
      gated.trimmed = true;
    }
    // What the repair fixed and what is still wrong are different facts: the
    // first says the model needed help, the second says the prompt still has a
    // defect a person should look at.
    gated.unresolved = gateFindings(repaired, gate);
    gated.repaired = gated.codes.filter((code) => !gated.unresolved.includes(code));
    return { ...best, value: repaired };
  };
}

function videoCastDirective(cast: readonly Character[], family: ModelFamily): string {
  const names = cast.map((c) => c.name).join(", ");
  return (
    (names ? ` The established cast is ${names}. Keep these names and roles unchanged.` : "") +
    (family === "minimax_ref2va"
      ? " Bind each referenced character by name and one short identifying phrase from the supplied cast."
      : " The start frame already establishes appearance: do not repeat full physical or wardrobe descriptions.") +
    " Describe a newly arriving person only as needed to distinguish them from people already in frame."
  );
}

/** What the clip call produced that the project cannot use as it stands. */
type ClipSalvage = {
  /** Faults found in the model's first answer. */
  initial: string[];
  /** What was done to the answer that was kept. */
  salvaged: string[];
};

type ClipBudget = {
  exceeds: (part: VideoPart) => boolean;
  /** Visual words the model's own prompt may use once appended text is counted. */
  bodyWords: (part: VideoPart) => number;
  fit: (part: VideoPart) => VideoPart;
};

/** Below this a clip prompt cannot hold a movement and a camera. */
const MIN_CLIP_WORDS = 30;

/**
 * The clip word ceiling, applied to what the model controls.
 *
 * Same reasoning as the image side: the ceiling counts text appended after the
 * model's answer, and the fallback for failing it was the scene card's raw
 * action, which ran 133–198 words against a 140-word ceiling — worse than the
 * overrun it replaced. Spoken lines are not counted, as in the ceiling itself.
 */
function clipBudget(
  family: ModelFamily,
  seconds: number,
  finalise: (part: VideoPart) => VideoPart,
  budget: BudgetContext,
): ClipBudget {
  const limit = wordBudget(family, "video", seconds, budget);
  const finalWords = (part: VideoPart) => visualWordCount(finalise(part).videoPromptSegment);
  const bodyWords = (part: VideoPart) =>
    Math.max(
      MIN_CLIP_WORDS,
      limit - Math.max(0, finalWords(part) - visualWordCount(part.videoPromptSegment)),
    );
  return {
    exceeds: (part) => finalWords(part) > limit,
    bodyWords,
    fit: (part) => {
      const text = part.videoPromptSegment;
      const room = bodyWords(part);
      if (visualWordCount(text) <= room) return part;
      // Speech is excluded from the ceiling but not from the trimmer's count.
      const speech = countWords(text) - visualWordCount(text);
      return { ...part, videoPromptSegment: trimToBudget(text, room + speech, 1) };
    },
  };
}

/** Spoken lines the prompt no longer carries, with who says them. */
function droppedLines(text: string, dialogue: SceneDraft["dialogue"]) {
  return (dialogue ?? []).filter((entry) => missingDialogue(text, [entry]).length > 0);
}

/**
 * The clip call, with the acceptance checks around it.
 *
 * A prompt that is over the ceiling or has lost a spoken line gets one retry
 * that says which. If it is still wrong it is repaired rather than replaced:
 * the overrun is trimmed from the end and any missing line is put back word for
 * word. Replacing it with the scene card's own action text lost the model's
 * work, ignored the ceiling it had just failed, and on a 9B model happened on
 * every scene of a 17-scene run.
 */
function gatedVideoCall(
  provider: PlanningProvider,
  system: string,
  user: string,
  draft: SceneDraft,
  budget: ClipBudget,
  salvage: ClipSalvage,
): () => Promise<ProviderResult<VideoPart>> {
  const faults = (part: VideoPart) => [
    ...(budget.exceeds(part) ? ["over_budget"] : []),
    ...(droppedLines(part.videoPromptSegment, draft.dialogue).length ? ["dialogue_dropped"] : []),
  ];
  return async () => {
    const first = await providerCall(provider, system, user, videoPartSchema, {
      systemPromptScope: "render_prompts",
    })();
    if (!first.ok) return first;
    salvage.initial = faults(first.value);
    if (!salvage.initial.length) return first;

    const missing = droppedLines(first.value.videoPromptSegment, draft.dialogue);
    const retry = await providerCall(
      provider,
      system +
        SHORTEN_PROMPT_DIRECTIVE +
        ` The visual prose must be at most ${budget.bodyWords(first.value)} words; spoken lines are additional.` +
        (missing.length
          ? " Carry these spoken lines word for word: " +
            missing.map((entry) => `${entry.character}: "${entry.line}"`).join(" ")
          : ""),
      `${user}\nPrevious answer to rewrite:\n${JSON.stringify(first.value)}`,
      videoPartSchema,
      { systemPromptScope: "render_prompts" },
    )();
    let best = first;
    if (retry.ok) {
      const retryFaults = faults(retry.value);
      if (!retryFaults.length) return retry;
      if (retryFaults.length <= salvage.initial.length) best = retry;
    }

    let value = best.value;
    if (budget.exceeds(value)) {
      value = budget.fit(value);
      salvage.salvaged.push("trimmed");
    }
    const lost = droppedLines(value.videoPromptSegment, draft.dialogue);
    if (lost.length) {
      const restored = lost.map((entry) => `${entry.character} says, "${entry.line.replace(/"/g, "'")}"`);
      value = { ...value, videoPromptSegment: `${value.videoPromptSegment.trimEnd()} ${restored.join(" ")}` };
      salvage.salvaged.push("dialogue_restored");
    }
    return { ...best, value };
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
  budget: BudgetContext,
): string[] {
  const seconds = draft.trimAtEndSeconds ?? draft.targetDurationSeconds;
  const findings = lintRendered(text, family, kind, kind === "image" ? 0 : seconds, budget);
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
  setting?: string,
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
    startFramePrompt: `${part.startFramePrompt}${settingSuffix(part.startFramePrompt, setting)}${lookPromptSuffix(project, part.startFramePrompt)}${castPromptSuffix(frameCast(part.startFramePrompt), wardrobe?.start, sheetFor(part.startFramePrompt), part.startFramePrompt)}${othersWardrobeSuffix(othersInFrame(part.startFramePrompt, wardrobe?.othersStart ?? {}), part.startFramePrompt)}`,
    endFramePrompt: `${part.endFramePrompt}${settingSuffix(part.endFramePrompt, setting)}${lookPromptSuffix(project, part.endFramePrompt)}${castPromptSuffix(frameCast(part.endFramePrompt), wardrobe?.end, sheetFor(part.endFramePrompt), part.endFramePrompt)}${othersWardrobeSuffix(othersInFrame(part.endFramePrompt, wardrobe?.othersEnd ?? {}), part.endFramePrompt)}`,
    imageNegativePrompt: normaliseNegative(`${part.imageNegativePrompt}${negative}`),
  };
}

function withCastEnforcedVideo(
  part: VideoPart,
  cast: readonly Character[],
  plans: CreativePlans | undefined,
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
    // The keyframe already carries the look; repeat only identity preservation.
    videoPromptSegment: `${part.videoPromptSegment}${castContinuityClause(cast, change) || change}`,
    videoNegativePrompt: normaliseNegative(`${part.videoNegativePrompt}${negative}`),
  };
}
