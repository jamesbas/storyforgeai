import { z } from "zod";
import { sceneDraftSchema, type SceneDraft } from "@/lib/schemas/storyboard";
import { buildSceneDrafts } from "@/lib/agents/mock-agents";
import { castSystemDirective } from "@/lib/agents/cast";
import { seamDirective } from "@/lib/agents/continuity";
import { creativeModeDirective } from "@/lib/agents/look";
import { explicitnessDirective } from "@/lib/agents/explicitness";
import { planningPayloadForSegments, planningProject, precedenceDirective } from "@/lib/agents/creative-context";
import { castWardrobeAfter } from "@/lib/agents/wardrobe";
import { revealUnstated, VISIBLE_RESULT_DIRECTIVE } from "@/lib/agents/clothing-wording";
import { composeExecution, executeArtifact, providerCall } from "@/lib/agents/provenance";
import { inferDialogueMode } from "@/lib/agents/media-prompt-spec";
import { BUILDER_VERSION, PROMPT_VERSIONS } from "@/lib/agents/prompt-version";
import { SEGMENT_SECONDS } from "@/lib/types";
import type { FailureReason } from "@/lib/schemas/provenance";
import type { Project } from "@/lib/schemas/project";
import type { Character } from "@/lib/schemas/character";
import type { AgentContext } from "@/lib/agents/types";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import { logEvent } from "@/lib/telemetry";

/**
 * What the Storyboard Artist is told about speech.
 *
 * It decides how much each scene is spoken and drafts the lines; the Dialogue
 * Writer then develops any draft that does not fit its mode, one scene per
 * call. Word counts are left out on purpose: asked for them inside a four-card
 * batch, a 27B model compressed every scene to two short remarks and still
 * missed, and every card spoke because the prompt said nobody may be silent.
 */
function dialoguePolicy(dialogueRequired: boolean): string {
  if (!dialogueRequired) {
    return (
      "This project has no dialogue. Nobody speaks on screen: set dialogueMode to \"silent\" " +
      "and leave dialogue empty on every card. Use narrationText only for a voice-over from " +
      "outside the scene, and only where the project asks for narration."
    );
  }
  return (
    "Decide for each card how much of it is spoken, and set dialogueMode. Use \"full\" when " +
    "characters talk through most of the clip while the action continues — negotiating, " +
    "confronting, explaining, comforting, persuading, arguing, bantering, interrogating. Use " +
    "\"brief\" when only a short remark, command or reaction fits — an entrance, a quick " +
    "exchange during fast physical action, a tense quiet. Use \"silent\" when nobody is on " +
    "screen, or the beat is wordless, solitary or visually self-contained and talking would " +
    "feel forced. Choose from the beat and the scene's intent, not from habit: a film in which " +
    "every scene talks at the same length is as false as one in which nobody speaks. Set " +
    "dialogueIntent to one short sentence — what each speaker is trying to get from the other " +
    "for full or brief, or why silence serves the shot. " +
    "The dialogue is not an annotation: it is what the characters say out loud, and the video " +
    "model speaks it. For full and brief cards, draft whole lines that sound like people " +
    "talking, grounded in this scene's objective and action, each given to the character who " +
    "says it by their exact name; a dedicated dialogue writer develops the draft to its full " +
    "length, so do not pad it. Leave dialogue empty on silent cards. Keep delivery and action " +
    "directions outside the spoken words. Use narrationText only for a voice-over from outside " +
    "the scene, never as a substitute for people speaking."
  );
}

export const storyboardSystem = (segmentSeconds: number, dialogueRequired = true) =>
  "You are the Storyboard Agent. You write a set of scene cards \u2014 one card for each " +
  `${segmentSeconds}-second segment you are asked to cover, always more than one, returned ` +
  "together as an array in the order they play. " +
  // A 26B model read "create exactly one scene card per segment" as a request
  // for one card, reasoned "create the first scene card for segment 1", and
  // stopped with finish_reason=stop after a single entry. The count has to be
  // stated in the instruction; leaving it implicit in the payload is not enough.
  "Never return a single card when several segments were requested, and never stop after the " +
  "first one. " +
  "Each scene must include scene objective, story beat, visual description, action, " +
  "camera movement, transition in/out, continuity notes, and any music or SFX notes. " +
  "Scope the action to what can actually happen in " +
  `${segmentSeconds} seconds. ` +
  dialoguePolicy(dialogueRequired) + " " +
  // This gates the face swap and nothing else. It once said "the main
  // character's face", which a model reasonably read as false for any scene
  // that character is absent from — and then wrote the shot to match its own
  // flag, reducing a wide shot of four men to a shot of their hands.
  "Set subjectFaceVisible according to the framing you have already chosen, and never let it " +
  "change what the shot contains. It is true whenever any person's face is in frame, even " +
  "partially, and whoever they are. Set it false only when the framing itself excludes every " +
  "face: a close-up of hands or an object, a shot from behind, a silhouette, or a crop above " +
  "the neck. A scene that none of the pinned cast appear in is not a reason to set it false — " +
  "other people are still people, and a wide or medium shot of a room with people in it shows " +
  "their faces. " +
  // A wide shot whose only human content is a pair of hands is not a shot.
  "Keep the people in the shot consistent with its size: do not describe a wide or medium shot " +
  "in terms of hands or fragments alone. If the shot is wide, say who is in the room and what " +
  "they look like. " +
  // Decides who gets a description, a reference photo and a face swap. Listing
  // someone absent puts them in the picture.
  "List in charactersPresent exactly which of the supplied cast are visible in that shot, by " +
  "their cast name. Leave it empty for a shot none of them are in. Do not list a character " +
  "who is merely mentioned, referred to, or elsewhere at the time. " +
  "Also supply frameVisibility with start and end arrays naming EVERY person or role visible " +
  "at each endpoint, including non-library characters. An empty array means no person is visible. " +
  "A person present in the scene may be cropped out of one endpoint; do not put them in that " +
  "frame's list. Use the same names as the scene and visual bible. " +
  // Costume is otherwise a constant repeated into every prompt, so a change the
  // story requires has to be declared here or it cannot happen at all.
  "Record a costume change in wardrobeChanges, in the scene where it happens. Name the " +
  "character exactly as the cast names them, or describe anyone not in the cast the way a " +
  "prompt should refer to them — 'the two men', 'the bartender' — give the complete resulting " +
  "outfit as specific garments with colours and materials, and set depictedOnScreen to true " +
  "only if the act of changing is what the scene shows. State what they are left wearing, not " +
  "what was removed: 'bare-chested, in dark jeans' rather than 'takes his shirt off'. Declare " +
  "it once — it carries forward on its own, and the scene where they dress again is its own " +
  "change. A character who is merely somewhere else wearing something different is not a " +
  "costume change, and a scene in which nobody's clothing changes has an empty wardrobeChanges. " +
  // Undressing is the change most often left undeclared, and the stated outfit
  // is appended last, so an undeclared one renders the clothes back on.
  "Undressing is a costume change, and it is the one that matters most. Each character's " +
  "stated wardrobe is appended to every render prompt as its final instruction, so a scene you " +
  "write as sex or nudity while wardrobeChanges is empty renders with the clothes still on. " +
  "Whenever a scene reaches the point where someone is no longer dressed, record it: \"nude\" " +
  "when they are wearing nothing, or the specific remaining garments when they are partly " +
  "dressed, with depictedOnScreen true if the undressing itself is what the scene shows. Never " +
  "describe an intimate act and leave the outfit standing." +
  // The wardrobe state is appended to every render prompt, so a state that
  // only says where the garment went renders the garment where it was.
  VISIBLE_RESULT_DIRECTIVE +
  " That applies to newWardrobe above all: write 'topless, black lace bra hanging from her " +
  "wrists, black lace panties' rather than 'bra hanging loose from her arms'. " +
  "Do not write image prompts or video prompts yet. " +
  "Return only valid JSON.";

/** Default-length wording, retained for callers that have no project in hand. */
export const STORYBOARD_SYSTEM = storyboardSystem(SEGMENT_SECONDS);

/**
 * Scene cards are requested in batches rather than all at once.
 *
 * Asked for eighteen cards in one response, a 26B local model returned one and
 * stopped — and the old all-or-nothing check then threw that one away too. The
 * prompt agents never had this problem because they already run per scene, so
 * the fix is to make this agent look more like them. Small enough that the
 * model finishes the batch, large enough that consecutive scenes are written
 * with each other in view.
 */
const CARDS_PER_CALL = 4;

/** Names the slice this call owns, so the model does not try to cover the rest. */
function batchDirective(from: number, to: number, total: number): string {
  return (
    ` This request covers scenes ${from} to ${to} of ${total}. Return exactly ` +
    `${to - from + 1} scene cards, in order, one per supplied segment beat, and nothing for the ` +
    "other segments. When a previous scene is supplied, continue from where it left off rather " +
    "than reintroducing the setting." +
    // A card that swallows the next three beats leaves those scenes with
    // nothing to do and asks one 20-second shot to carry four beats of story.
    ` Each card covers its own segment's beat and stops there. Do not bring forward anything ` +
    `from a later segment, do not merge two beats into one card, and do not finish an action the ` +
    `beat only begins — the segments after ${to} exist to carry what happens next, and a card ` +
    "that races ahead leaves them with the story already over."
  );
}

/**
 * Tells the model that some of these cards are the middle of an action, not the
 * start of one.
 *
 * Without it every card is written as a self-contained event — setting
 * re-established, action begun and finished — so an action the Story Architect
 * deliberately spread over three segments came back as the same thing happening
 * three times.
 */
function continuationDirective(segments: readonly number[]): string {
  if (!segments.length) return "";
  const list = segments.join(", ");
  return (
    ` Scene${segments.length > 1 ? "s" : ""} ${list} continue${segments.length > 1 ? "" : "s"} the ` +
    "action of the scene immediately before, in the same place with the same people. Carry it " +
    "forward from exactly where that scene ended and let it develop — do not re-establish the " +
    "setting, do not start the action again, do not summarise what has already happened, and do " +
    "not skip to the end of it. Write the transition in as continuous rather than a cut."
  );
}

/**
 * Tells the model that a wardrobe it is being shown is already the result of an
 * earlier change, so it neither re-declares it nor writes anyone back into the
 * outfit they left behind.
 */
function carriedWardrobeDirective(
  original: readonly Character[],
  now: { cast: readonly Character[]; others: Record<string, string> },
): string {
  const changed = now.cast.filter((c, i) => c.wardrobe !== original[i]?.wardrobe);
  const others = Object.entries(now.others);
  if (changed.length === 0 && others.length === 0) return "";

  const sheet = [
    ...changed.map((c) => `${c.name}: ${c.wardrobe}`),
    ...others.map(([subject, outfit]) => `${subject}: ${outfit}`),
  ].join("; ");
  return (
    " Costume changes have already happened earlier in this storyboard. As these scenes open, " +
    `${sheet}. That is what they are wearing now — do not describe an earlier outfit, do not ` +
    "put anyone back into clothing they are no longer in, and do not re-declare a change that " +
    "has already been made."
  );
}

const sceneDraftsSchema = z.object({ scenes: z.array(sceneDraftSchema) });

/**
 * Give every card a dialogue mode, and honour a project with no dialogue.
 *
 * The flag used to be ignored on the model path: the prompt said "write the
 * dialogue" and every scene of a project created with Dialogue unchecked spoke
 * anyway. A silent card's lines are dropped, because silent is the decision.
 */
function withDialogueModes(cards: SceneDraft[], project: Project): SceneDraft[] {
  return cards.map((card) => {
    if (!project.dialogueRequired) return { ...card, dialogueMode: "silent", dialogue: [] };
    const dialogueMode = inferDialogueMode(card.dialogue, card.dialogueMode);
    return dialogueMode === "silent"
      ? { ...card, dialogueMode, dialogue: [] }
      : { ...card, dialogueMode };
  });
}

/**
 * Overwrite the timing fields on model-authored drafts.
 *
 * Timing is derived from the project's segmentation, but the schema exposes it,
 * and a model under structured output fills every field it is shown. One wrote
 * `trimAtEndSeconds: 2` on all three scenes of a 60-second project; that field
 * is the scene's *final* length, so each 20-second segment rendered as a
 * 2-second clip. The model owns the creative content, never the clock.
 */
function withDerivedTiming(scenes: SceneDraft[], project: Project): SceneDraft[] {
  return scenes.map((scene, index) => {
    const sceneNumber = index + 1;
    const startTimeSeconds = index * project.segmentSeconds;
    const isLast = sceneNumber === project.segmentCount;
    return {
      ...scene,
      // Identity is derived too: two scenes handed the same invented id would
      // collide in the attempts and seed maps, which are keyed by it.
      id: `${project.id}-scene-${String(sceneNumber).padStart(3, "0")}`,
      projectId: project.id,
      sceneNumber,
      startTimeSeconds,
      endTimeSeconds: startTimeSeconds + project.segmentSeconds,
      targetDurationSeconds: project.segmentSeconds,
      // Only the final scene is shortened, and only to hit the requested total.
      trimAtEndSeconds:
        isLast && project.finalTrimSeconds > 0
          ? project.segmentSeconds - project.finalTrimSeconds
          : undefined,
    };
  });
}

export async function storyboardAgent(
  ctx: AgentContext,
  provider: PlanningProvider | null,
): Promise<SceneDraft[]> {
  const brief = ctx.brief;
  const storyPlan = ctx.storyPlan;
  const visualBible = ctx.visualBible;
  if (!brief || !storyPlan || !visualBible) {
    throw new Error("storyboardAgent requires brief, storyPlan and visualBible in context");
  }

  const built = () =>
    buildSceneDrafts(ctx.project, storyPlan, brief, visualBible, ctx.cast ?? [], ctx.plans);

  const startedAt = new Date();
  if (!provider) {
    ctx.onExecution?.(
      composeExecution({
        artifact: "storyboard",
        scope: "project",
        correlationId: ctx.correlationId,
        builderVersion: BUILDER_VERSION,
        source: "deterministic",
        fallbackReason: "provider_disabled",
        startedAt,
      }),
    );
    return withDialogueModes(built(), ctx.project);
  }

  const cast = ctx.cast ?? [];
  const wanted = ctx.project.segmentCount;
  const system =
    storyboardSystem(ctx.project.segmentSeconds, ctx.project.dialogueRequired) +
    creativeModeDirective(ctx.project) +
    explicitnessDirective(ctx.project, "plan") +
    seamDirective(ctx.project) +
    castSystemDirective(cast) +
    precedenceDirective(cast, ctx.plans);

  const fallbackDrafts = built();
  const scenes: SceneDraft[] = [];
  const continued = new Set(storyPlan.continuedSegments ?? []);
  let builderFilled = 0;
  let batchReason: FailureReason | undefined;
  // Recorded on the execution so the badge can say which model wrote the cards.
  // It was blank, which left a per-stage model choice impossible to confirm
  // from the storyboard itself.
  const modelsUsed = new Set<string>();

  for (let start = 0; start < wanted; start += CARDS_PER_CALL) {
    const end = Math.min(start + CARDS_PER_CALL, wanted);
    const previous = scenes[start - 1];
    const segmentNumbers = Array.from({ length: end - start }, (_, i) => start + i + 1);
    // Segment 1 has nothing before it to continue, whatever the plan claims.
    const continuedHere = segmentNumbers.filter((n) => n > 1 && continued.has(n));
    // The cast is re-sent with every batch, so it has to show what everyone is
    // wearing now rather than what the project started them in.
    const now = castWardrobeAfter(cast, scenes);
    const user = JSON.stringify({
      project: planningProject(ctx.project),
      brief,
      visualBible,
      cast: now.cast,
      othersWardrobe: Object.keys(now.others).length ? now.others : undefined,
      // Scoped to this batch. Handed over whole, the per-scene maps gave a call
      // writing four scenes the Director's notes for the whole film, and it
      // wrote them: one card came back as three later intents merged.
      plans: planningPayloadForSegments(ctx.plans, segmentNumbers),
      // Only this batch's beats, so the model is not tempted to cover the rest.
      segmentNumbers,
      segmentBeats: storyPlan.segmentBeats.slice(start, end),
      emotionalProgression: storyPlan.emotionalProgression.slice(start, end),
      // The same beats keyed by segment, so a card cannot be written against
      // the wrong one by miscounting two parallel arrays.
      beatsBySegment: Object.fromEntries(
        segmentNumbers.map((n) => [String(n), storyPlan.segmentBeats[n - 1] ?? ""]),
      ),
      continuedSegments: continuedHere.length ? continuedHere : undefined,
      previousScene: previous
        ? {
            sceneNumber: start,
            title: previous.title,
            visualDescription: previous.visualDescription,
            actionDescription: previous.actionDescription,
            cameraMovement: previous.cameraMovement,
            dialogue: previous.dialogue,
            narrationText: previous.narrationText,
          }
        : undefined,
    });

    const result = await providerCall(
      provider,
      system +
        batchDirective(start + 1, end, wanted) +
        continuationDirective(continuedHere) +
        carriedWardrobeDirective(cast, now),
      user,
      sceneDraftsSchema,
      { systemPromptScope: "storyboard" },
    )();
    if (result.model) modelsUsed.add(result.model);
    const returned = result.ok ? result.value.scenes.slice(0, end - start) : [];
    // Missing cards still use the existing, explicitly reported builder fallback.
    if (returned.length !== end - start) {
      batchReason ??= returned.length ? "short_collection" : result.ok ? "unknown" : result.reason;
    }
    for (let i = 0; i < end - start; i += 1) {
      const card = returned[i];
      if (card) scenes.push(card);
      else {
        scenes.push(fallbackDrafts[start + i]!);
        builderFilled += 1;
      }
    }
    if (returned.length !== end - start) {
      logEvent("agent.fallback", {
        projectId: ctx.project.id,
        agent: "storyboard",
        reason: "batch_short",
        batch: `${start + 1}-${end}`,
        expectedScenes: end - start,
        returnedScenes: returned.length,
      });
    }
  }

  const fromLlm = wanted - builderFilled;
  // Reported, not rewritten: whether a lowered bra leaves her topless is the
  // story's call. Surfacing it is what lets someone fix the card before the
  // wardrobe is appended to every render prompt that follows it.
  const vagueWardrobe = scenes.flatMap((card, index) =>
    (card.wardrobeChanges ?? []).some((change) => revealUnstated(change.newWardrobe)) ? [index + 1] : [],
  );
  if (vagueWardrobe.length) {
    logEvent("storyboard.wardrobe_reveal_unstated", { projectId: ctx.project.id, scenes: vagueWardrobe });
  }
  ctx.onExecution?.(
    composeExecution({
      artifact: "storyboard",
      scope: "project",
      correlationId: ctx.correlationId,
      promptVersion: PROMPT_VERSIONS.storyboard,
      builderVersion: BUILDER_VERSION,
      provider: provider.name,
      ...(modelsUsed.size ? { model: [...modelsUsed].join(", ") } : {}),
      source: fromLlm === 0 ? "deterministic" : builderFilled || vagueWardrobe.length ? "hybrid" : "llm",
      fallbackReason: builderFilled
        ? batchReason ?? "unknown"
        : vagueWardrobe.length ? "invalid_set" : undefined,
      detail: [
        ...(builderFilled ? [`${fromLlm} of ${wanted} scene cards written by the model`] : []),
        ...(vagueWardrobe.length
          ? [`Wardrobe in scenes ${vagueWardrobe.join(", ")} moves clothing without saying what is bare; review the costume change.`]
          : []),
      ].join("; ") || undefined,
      attempted: { total: wanted, fromLlm },
      startedAt,
    }),
  );

  if (builderFilled === 0) return withDialogueModes(withDerivedTiming(scenes, ctx.project), ctx.project);

  // Carried on the context so it reaches the stored snapshot, not just the log.
  ctx.fallbacks = [
    ...(ctx.fallbacks ?? []),
    {
      agent: "Storyboard Agent",
      reason: builderFilled === wanted ? "no_valid_response" : "scene_count_short",
      detail: `${wanted - builderFilled} of ${wanted} scene cards written by the model`,
    },
  ];
  return withDialogueModes(withDerivedTiming(scenes, ctx.project), ctx.project);
}
