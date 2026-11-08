# StoryForge QC Enhancements — Scene Check (Quick / Deep)

**Date:** 2026-11-08 · **Codebase:** `main` at v2.96 · **Status:** implemented in v2.97 — see [Implementation status](#implementation-status)

## Implementation status

Every phase below shipped in **v2.97**, along with the straight fixes to the writers that the research turned up. Where the build departed from the plan, it says why.

| Phase | What shipped | Where |
|---|---|---|
| **0 — Identity** | Story characters get the library's appended fallback; a stated skin tone or ethnicity is required for everyone, placed beside the name or, where every mention is possessive, as a one-line sheet entry; `identity_missing` in stored-prompt warnings; the *Repair prompts* offer fixes older projects without a model call. | `lib/agents/identity.ts`, `cast.ts`, `cast-sheet.ts` (`composeFrameCast`), `prompt-validation.ts` |
| **Writer fixes** | The image writer's instruction now says skin tone is never optional and no longer claims "nothing is appended" for non-library people. The video writer names story characters in the cast line, and Ref2VA binds each person with a phrase that includes their skin tone. QC now receives the people in the scene and the previous scene, both of which it was already being asked to judge against. | `cast.ts` (`castSystemDirective`), `prompt-agents.ts` (`videoCastDirective`), `qc-agent.ts`, `review-context.ts` |
| **1 — Quick check** | Per scene and for picked scenes; results stored per scene and depth; status computed on the server against the current inputs. | `lib/agents/scene-check.ts`, `lib/services/scene-check-service.ts`, `/api/projects/:id/scene-checks` |
| **2 — Preview fix** | One field, smallest change, written part only (appended sheets go back unchanged); rewrites rejected; a candidate that adds a new warning is not offered; applied through the hand-edit services with a hash check. | `lib/agents/scene-check-fix.ts`, `/scene-checks/:sceneId/fix` |
| **3 — Deep check** | Story beat, intent, shot plan and neighbouring frames in the text pass, plus a separate vision pass over the frames (a waiting preview takes precedence over the attempt). | `runDeepCheck` |
| **4 — Check first** | A "Check first" control on the keyframe and clip reruns, with project defaults on the settings screen (off by default); held scenes are listed with their reason and a "render anyway" button. | `checkThenRender`, `components/storyboard/scene-check-tools.tsx` |

**Departures from the plan:**

- **Status is computed on the server, not in the browser.** The input hash depends on wardrobe, prompt validation and plan logic. Proving all of that safe to bundle for the browser would have meant running `next build` against the live server.
- **QC was not folded into the Deep check.** QC grades attempts and stores `qcResult` on them; merging the two would have changed what existing projects show. It now gets the same review context instead, which removes the blind spot this document identified.
- **"Check first" is a follow-up on the check queue, not a blocking request.** Checking ten scenes takes minutes. The checks run while the planning model is loaded, then the render queue evicts it as it always does.
- **Room 412 needed no repair.** Run against the real project, after the false-positive fix described next, the identity check found nothing left in the frame prompts: the hand edits had already fixed them. The remaining gaps are in clip and edit prompts, which are exempt by design. The first run reported 10 false positives — prompts like "Leroy's espresso-brown hands" do state his skin tone — and the check now accepts a colour on a body part.

---

This document answers three questions:

1. Does the existing QC agent already catch problems like the keyframe prompts that dropped Leroy's skin tone?
2. What should be kept, changed, or dropped from the ChatGPT *Storyboard Validator* proposal (`storyforge-storyboard-validator-plan.md`)?
3. What should be built, in what order, to give an **on-demand, per-scene, Quick or Deep** check that never runs across the whole storyboard unless you ask?

---

## 1. Short answer

**No. The current QC agent would not reliably catch the Leroy problem, and it could not run the way you want.**

- QC only runs **after rendering**, automatically, for every scene in a batch (when the project setting is on). It has **no manual or per-scene trigger** and no API route.
- QC is given only the scene card and the render attempt. It is **never given the character descriptions** (visual bible or library), so it has no way to know Leroy is Black unless the scene card itself says so. In *Room 412*, 13 of 50 cards don't.
- Its text-only instructions ask about "continuity conflicts with the previous scene", but **the previous scene is never sent to it**.
- It returns a single pass/fail with a list of strings. There is no evidence, no field it points at, and no fix you can apply.

There is also a more important finding: **the Leroy problem has a root cause that a validator would only detect, not prevent.** StoryForge automatically guarantees appearance text for *library* characters, but not for *story* characters that the planning agents invent (Leroy is one). Section 3 covers this. Fixing it deterministically is the cheapest and highest-value change in this document, so it is Phase 0 of the plan.

---

## 2. What exists today

| Capability | Where | Relevant behaviour |
|---|---|---|
| QC agent (Creative Critic) | [lib/agents/qc-agent.ts](lib/agents/qc-agent.ts) | Three modes: **visual** (keyframes attached, when `OPENAI_VISION_MODEL` is set), **text-only** (prompts vs card), **deterministic** (fails only if media is missing). The user payload is `{ scene, attempt, expectations }`: no cast descriptions, no visual bible, no neighbouring scenes, no story arc. |
| QC result | [lib/schemas/generation.ts](lib/schemas/generation.ts) `qcResultSchema` | `{ passed, score, severity, issues: string[], matchedRequirements, regenerationInstructions }`, stored on each `SceneAttempt.qcResult`. |
| QC trigger | [lib/services/media-service.ts](lib/services/media-service.ts) (batch QC phase about line 1469; single-scene `scoreAttempt` about line 1769) | Runs after media is saved, for every rendered scene, only when `project.qcEnabled`. No retry; a failure sets the scene to `needs_review`. |
| QC setting | [components/settings/project-settings.tsx](components/settings/project-settings.tsx) "Grade scenes with the QC agent" | All or nothing for the project. |
| QC display | [components/storyboard/scene-card.tsx](components/storyboard/scene-card.tsx) | "QC passed / QC flagged", the issues, and the regeneration text. Guidance only. |
| Concept fidelity | [lib/agents/concept-fidelity.ts](lib/agents/concept-fidelity.ts), `POST /api/projects/:id/concept-fidelity` | On-demand **vision** check of rendered frames against the project concept. A good precedent for an on-demand route. |
| Image prompt gate | [lib/agents/prompt-gate.ts](lib/agents/prompt-gate.ts) | Deterministic codes: `action_dropped`, `participant_missing/unexpected`, `wardrobe_state_conflict`, `pose_conflict`, `limb_conflict`, `headcount_*`, `framing_too_tight`, `over_budget`, … **None checks a character's identifying appearance.** |
| Video prompt gate | [lib/agents/video-prompt-gate.ts](lib/agents/video-prompt-gate.ts) | Lexical checks for action, dialogue and speaker attribution, wardrobe, and continuity. No appearance check. |
| Physical contradictions | [lib/agents/frame-contract.ts](lib/agents/frame-contract.ts) `physicalContradictions` | Only named-pose and limb-state contradictions. |
| Stored warnings | [lib/agents/prompt-validation.ts](lib/agents/prompt-validation.ts) `storedPromptWarnings`; `scenePromptsSchema.promptWarnings` | Advisory; recomputed after edits; shown in amber in the prompt panel. Never block generation. |
| Cast sheet | [lib/agents/cast.ts](lib/agents/cast.ts), [lib/agents/cast-sheet.ts](lib/agents/cast-sheet.ts) | Deterministically appends appearance text to start/end/video prompts, **for library characters only** (`cast.ts`: "Turns library characters into prompt fragments"). |
| Preview / apply pattern | [lib/services/prompt-tools-service.ts](lib/services/prompt-tools-service.ts) `previewSimplifiedPrompts` / `applySimplifiedPrompts` | Preview returns candidates plus a `sourceHash`; apply rejects the change if the prompt moved underneath. This is the pattern a "Preview fix" should reuse. |
| Prompt patching | [lib/schemas/storyboard.ts](lib/schemas/storyboard.ts) `applyScenePromptsPatch`; `PATCH /scenes/:sceneId/prompts` | Already carries an end-frame edit forward into the next scene's opening. |
| Scene selection | [components/storyboard/scene-picker.tsx](components/storyboard/scene-picker.tsx), [components/storyboard/storyboard-view.tsx](components/storyboard/storyboard-view.tsx) | Independent pick lists for video rerun, keyframe rerun, prompt rewrite, and seed reset, each with Select all / Clear all. |
| Rerun queue | [lib/services/scene-queue.ts](lib/services/scene-queue.ts) `enqueueKeyframeRerun`, `enqueueVideoRerun`; `POST /queue?keyframes=1 / ?video=1` | Sequential GPU queue, polled by the UI, can be cancelled. LLM planning work runs separately. |
| Keyframe preview | `POST/PATCH/DELETE /scenes/:sceneId/keyframe`; `adoptScenePreview` | Renders one still as a *preview*, and "keep" promotes it. A natural place to run a Deep check before adopting a frame. |

---

## 3. Evidence from *Room 412 (WIP)*

I read `projects/1f0fdc23-…/project.json` without changing it. Findings:

| Observation | Value |
|---|---|
| Library characters on the project | 1 (`TLBr3f`) |
| Story characters in the visual bible | 2: `TLBr3f`, **`Leroy`** ("Heavyset Black man in his mid-fifties … dark espresso-brown skin …") |
| `charactersPresent` on scene cards | `['TLBr3f']` on **all 50** scenes |
| Scenes where Leroy is in `frameVisibility` | 47 |
| Scene cards naming Leroy that state his skin tone | 37 of 50 |
| Prompts naming Leroy that *still* omit skin tone (after your hand edits) | 16: mostly `videoPromptSegment` (scenes 3, 11, 19, 23, 25, 29, 30, 36, 37, 43) and `endFrameEditPrompt` (19, 24, 25, 27, 28, 36) |
| Hand edits recorded in history | 21 × `scene.prompts_edited` (scenes 2–4, 7–12, 22, 33, 49; scene 12 edited seven times) |

**How the drift happens, step by step:**

1. Leroy is a **story character**, not a library character, so he is never added to `charactersPresent`. The cast sheet, `participant_missing` and the wardrobe checks all key off that list.
2. The image prompt writer *does* receive his visual-bible description as context ([prompt-agents.ts](lib/agents/prompt-agents.ts) about line 591). Nothing requires that description to reach the prompt, and nothing checks afterwards that it did.
3. A local model writing long, action-dense prompts drops the "trait" words first (skin tone, age, build) to make room for action and staging. The result passes every gate, because no gate looks for identity.
4. A text-to-image model with no reference image and no skin-tone word defaults to its prior. The man renders white.

**Severity depends on the prompt type, and the validator must understand that:**

- **`startFramePrompt` / `endFramePrompt` rendered from text alone:** a missing skin tone is an **error**. This is the case you saw.
- **`endFrameEditPrompt`** edits a supplied frame and says "preserving faces …", so identity carries over from the source image. A missing skin tone is **info**, unless the source frame is itself wrong.
- **`videoPromptSegment` for H3 Ref2VA** is anchored by the keyframes, so a missing skin tone is a **warning**. It becomes an error only if the clip introduces the character without a keyframe showing him.

---

## 4. Assessment of the ChatGPT validator plan

The plan is careful and mostly sound engineering. However, it is designed as an **automatic pipeline stage** wired into storyboard generation, full-auto, and every media submission path. That is the opposite of what you asked for, and it makes the plan much larger than it needs to be.

### Keep

- **Findings with evidence**: field path plus quoted excerpt, validated on the server so the model cannot invent quotations.
- **Review and repair as separate operations**, and repair as a **preview you accept**, never a silent rewrite.
- **Statuses computed by the app, not the model.** The model reports findings; the application decides passed, needs review, or out of date.
- **Distinguishing a still frame from a transition.** "Sits, then stands" in a video is not a pose conflict.
- **"Underspecified" versus "contradiction"**, and **"physically impossible" versus "hard for this model"**.
- **Never treating a timeout or malformed response as a pass.**
- **Staleness by input hash**, so a check result is labelled out of date once its inputs change.
- **Reusing the existing deterministic gates** as evidence rather than re-deriving them.

### Change

| ChatGPT plan | Recommendation | Why |
|---|---|---|
| Runs automatically on every new storyboard, inside `runStoryboardOrchestrator`, before full-auto | **On demand only**: per scene, or for the scenes you pick. Optionally "check before render" on the reruns you start. | Your requirement. It also removes most of the orchestrator, full-auto and dual-queue integration work. |
| A strict mode that holds rendering at every submission path (batch, single, preview, retry, video-only) | **One place:** an optional "Check first" step on the bulk keyframe and video rerun actions, which holds the scenes that fail. | Enforcing a hold across six submission paths is the largest and most fragile part of their plan, for a mode you don't want on by default. |
| A full semantic dependency hash spanning arc, plans, variant, policy version, and so on, with explicit invalidation hooks on every edit path | **A per-scene hash of what the check actually read** (card, prompts, cast descriptions, wardrobe, neighbour endpoints for Deep), compared **when the result is displayed**. | No invalidation plumbing is needed: a result is out of date whenever its recomputed hash differs. |
| A separate typed `staging-ledger.ts` extraction module | **A section of the Deep check's structured output**, not its own module or pass | Same reasoning, one call instead of two, and nothing to keep in sync. |
| A new `validation` model-routing stage plus settings migration | **Defer.** Use the planning model for text and `OPENAI_VISION_MODEL` for images, as QC already does. | Add a stage only if measurement shows the planning model is a poor reviewer. |
| Validator card on the agentic canvas | **Not needed.** The check lives on the storyboard: a scene badge, the prompt panel, and a bulk picker. | The canvas is for planning runs. You want this next to the rerun controls. |

### What the plan misses

1. **The root cause in Section 3.** No amount of review fixes "story characters have no identity anchor". Detection should come *after* prevention.
2. **The QC payload gap.** The existing visual QC could catch "Leroy rendered white" today if it were given the character descriptions. It isn't.
3. **A cheap deterministic identity check.** An `identity_missing` gate code needs no LLM at all, runs instantly, and would have flagged every one of your hand-fixed prompts.
4. **The keyframe *preview* flow.** This is the cheapest place for a visual check: one still, before you adopt it.

---

## 5. Recommendation: one "Scene Check" feature with two depths

Enhance QC rather than building a parallel validator. Introduce **Scene Check** as the single per-scene review feature, with one engine, two depths, and three entry points. The existing post-render QC becomes "Scene Check (Deep) on finished media" and keeps its project toggle (still off by default), so nothing that works today goes away.

### 5.1 What each depth checks

| Check | Quick | Deep |
|---|:---:|:---:|
| Deterministic gates, including the new `identity_missing` | ✓ | ✓ |
| Keyframe prompts vs scene card + cast: identity (skin tone, age, build, hair), wardrobe, action, framing, participants | ✓ | ✓ |
| Video prompt vs scene card + keyframe prompts: action covered, speaker attribution, nobody appears without an entrance, endpoints connected | ✓ | ✓ |
| Scene card vs story beat (`storyPlan.segmentBeats[n]`, scene intent, shot plan): required outcome present, roles not reversed, nothing invented | — | ✓ |
| Continuity with neighbours: previous end frame → this start; this end → next start; carried-opening agreement; wardrobe and prop state | — | ✓ |
| Staging and physics: occupied hands, support, reach, orientation, interpenetration, "impossible" vs "hard for this model" | — | ✓ |
| **Vision**: rendered start/end keyframes (or the current preview) vs card + character descriptions, e.g. *"Leroy appears light-skinned; card and visual bible describe dark espresso-brown skin"* | — | ✓ if frames exist and `OPENAI_VISION_MODEL` is set |

**Expected calls per scene:**

- **Quick:** one text call.
- **Deep:** one text call with a larger context, plus one vision call when frames exist.

Your local planning model serializes calls, so a check on 10 scenes runs one scene at a time. Measure the real time rather than estimating it. `WANGP_OUTPUT_DIR` points at `C:\pinokio\…` on this machine, so WanGP and LM Studio very likely share one GPU. A check started while a render batch is running will compete with it for VRAM and time, so the UI should say so, as the existing QC setting already does.

### 5.2 Where it runs (never automatically across the storyboard)

1. **Per scene.** A **Check ▾ (Quick | Deep)** button on the scene card and in the scene prompts panel, with the result badge next to the existing QC badge.
2. **Selected scenes.** A fifth bulk action in [storyboard-view.tsx](components/storyboard/storyboard-view.tsx): **"Check selected scenes"** using the same `ScenePicker`, with a Quick/Deep choice and Select all / Clear all, exactly like the keyframe, video, seed and prompt pickers.
3. **Check before render (optional).** A **"Check first: Off / Quick / Deep"** control beside **Regenerate selected keyframes** and **Regenerate selected videos**. Checked scenes with an **error** finding are held: they are not queued, and they are listed with their findings. Everything else is queued as today. There is a per-run **"Render anyway"**.
4. **Keyframe preview.** After **Render preview**, a **Deep check this preview** link runs the vision check on that single still before you adopt it.

A project-settings **Scene Check** section holds the defaults only: the default depth, and the default for "Check first". It never enables a storyboard-wide automatic run.

### 5.3 What a result looks like

Stored per scene as `sceneChecks[sceneId]`: the latest Quick result and the latest Deep result. Older results are not kept.

```ts
type SceneCheck = {
  depth: "quick" | "deep";
  checkedAt: string;
  inputHash: string;            // hash of exactly what the check read
  mode: "text" | "text+vision"; // so a text check never reads as "frames seen"
  coverage: "complete" | "partial" | "failed"; // timeout / malformed → never "passed"
  findings: SceneFinding[];
};

type SceneFinding = {
  id: string;
  code: string;                 // e.g. identity_missing, identity_rendered_wrong, outcome_missing,
                                //      role_reversed, continuity_break, limb_conflict, entrance_missing
  category: "identity" | "story" | "action" | "continuity" | "staging" | "model_contract";
  severity: "info" | "warning" | "error";
  certainty: "contradiction" | "likely" | "underspecified";
  origin: "rule" | "model" | "vision";
  field: "card" | "startFramePrompt" | "endFramePrompt" | "endFrameEditPrompt" | "videoPromptSegment" | "startImage" | "endImage";
  evidence: { source: string; excerpt: string }[]; // validated server-side against the real text
  explanation: string;
  suggestedFix?: string;
  accepted?: { at: string; inputHash: string }; // "intentional", cleared when inputs change
};
```

**The status is derived in code, never chosen by the model:**

| Status | Meaning |
|---|---|
| **Not checked** | No result stored. |
| **Passed** | No unaccepted warnings or errors, and coverage is complete. |
| **Issues** | At least one unaccepted warning or error. |
| **Incomplete** | Coverage was partial or the check failed. |
| **Out of date** | The stored `inputHash` differs from the hash of the scene's current inputs. |

### 5.4 Fixes: findings plus a fix preview you accept per scene

- Each finding with a prompt `field` offers **Preview fix**. A focused LLM call rewrites **only that field** with the minimal change: for example, insert "dark espresso-brown-skinned" before "Leroy", or add the missing hand-off. Model formats (H3 fields, Fibo structure), dialogue and wardrobe are preserved.
- The candidate is run through the existing gates **and** the identity check before it is shown. The preview displays before/after with the finding it resolves.
- **Apply** reuses the simplification pattern: compare the `sourceHash`, reject if the prompt changed, then write through `applyScenePromptsPatch` so the carried opening of the next scene follows, as manual edits already do. Warnings are recomputed, and the scene's check becomes "Out of date", prompting a re-check.
- **Card-level findings** (from "card vs story") are shown as **suggested card edits** with the same preview/apply flow, through the existing `PATCH /scenes/:sceneId/card` route. They are never applied to the prompt alone, so the card and prompt don't disagree.
- **Vision findings** ("Leroy rendered white") point at the prompt that produced the frame. The fix is a prompt fix followed by your normal keyframe rerun, which the "Check first" control can then guard.
- **Accept as intentional** records the acceptance against the current `inputHash`. It disappears if the inputs change.

---

## 6. Implementation plan

Effort: **S** about half a day · **M** 1–2 days · **L** 3–5 days. Every phase ends with `npx vitest run`, `npm run typecheck`, `npm run lint`, and a version bump plus README/CHANGELOG row, following the repository instructions.

### Phase 0: Prevent identity drift (deterministic, no LLM) · **M**

This is the direct fix for Leroy. Ship it first, even if nothing else is built.

1. **Story-character identity anchors.** In [lib/agents/cast.ts](lib/agents/cast.ts), add `storyIdentityTraits(person)`. It extracts a short, stable trait phrase from a visual-bible description: skin tone, ethnicity, age, build and hair, in the description's own words and not inferred (e.g. "heavyset Black man in his mid-fifties, dark espresso-brown skin"). It strips the time-dependent parts (states that change over the scenes) the same way [prompt-agents.ts](lib/agents/prompt-agents.ts) already splits on `initially|then|before|after`.
2. **Apply it where the library cast sheet is applied.** In [lib/agents/cast-sheet.ts](lib/agents/cast-sheet.ts) `rebuiltPrompts`, and in the prompt-writer repair path, insert the anchor at the character's first mention in `startFramePrompt` and `endFramePrompt` **when the prompt does not already state it** (reuse `describedInline`). Video prompts get it only when the character has no keyframe anchor. Edit prompts are left alone, because they preserve the source.
3. **New gate code `identity_missing`.** In [lib/agents/prompt-gate.ts](lib/agents/prompt-gate.ts), flag a frame prompt that names a visible character (library *or* story) without that character's identity anchor. Severity follows Section 3. It flows into `promptWarnings` automatically through `storedPromptWarnings`, and so appears in the prompt panel after any edit.
4. **Fix the `charactersPresent` blind spot carefully.** Leroy being absent from `charactersPresent` on all 50 cards should be addressed by having the gates read `frameVisibility` names plus visual-bible characters. Do **not** silently change `charactersPresent` semantics, because face swap and references key off it.
5. **Tests:** a *Room 412*-shaped fixture (a library woman plus a story man) proving that the anchor is inserted once, never duplicated after a hand edit, not added to edit prompts, and flagged when missing.

### Phase 1: Quick check, per scene and for selected scenes · **L**

1. `lib/schemas/scene-check.ts`: the schemas in Section 5.3, plus optional `sceneChecks` on the project record so old projects still parse.
2. `lib/agents/scene-check.ts`:
   - `buildSceneCheckInput(record, sceneId, depth)` collects the card, prompts, deterministic findings, library *and* story character descriptions, and resolved wardrobe.
   - `sceneCheckInputHash(input)` is a stable hash of that input.
   - `quickCheck(...)` makes one structured call through `executeArtifact` / `providerCall`, with provenance recorded as for QC, and a deterministic fallback that returns `coverage: "failed"`, never a pass.
   - The system prompt follows the ChatGPT plan's core instruction (findings only, cite exact fields, still frame vs transition, underspecified ≠ contradiction), plus the identity-severity rules from Section 3.
3. **Server-side evidence validation.** A finding whose excerpt is not found in the cited field is dropped and logged.
4. `lib/services/scene-check-service.ts`:
   - `checkScenes(projectId, sceneIds, depth)` runs sequentially through a small in-process check queue, with progress and cancellation modelled on `scene-queue.ts`.
   - It writes results with a re-read-then-merge, so it never overwrites concurrent edits or attempts.
5. **Routes:**
   - `POST /api/projects/:id/scene-checks` with `{ sceneIds, depth }` queues a run.
   - `GET` returns progress and results.
   - `DELETE` cancels.
   - `PATCH /scene-checks/:sceneId/findings/:findingId` records acceptance.
6. **UI:**
   - A Check ▾ button and status badge on the scene card.
   - A findings list in the scene prompts panel: field, excerpt, explanation, suggested fix, Accept as intentional.
   - The bulk "Check selected scenes" picker in `storyboard-view.tsx`.
7. **Tests:** fake-provider tests for wiring; malformed or timed-out output → `failed`; an invented excerpt is dropped; the hash changes on a prompt edit → "Out of date"; old projects without `sceneChecks` load.

### Phase 2: Preview fix · **M**

1. `previewSceneCheckFix(projectId, sceneId, findingId)` makes a focused single-field rewrite, then gates and identity-checks it. It returns `{ before, after, sourceHash, resolves }`.
2. `applySceneCheckFix` checks the `sourceHash`, then writes through `applyScenePromptsPatch`, with carry-forward to the next scene's opening, a history entry `scene.check_fix_applied`, and recomputed warnings.
3. Card suggestions use the same pair through the existing card route.
4. UI: a before/after diff with **Apply** and **Discard**, on each finding.
5. **Tests:** H3 fields, Fibo structure, dialogue and the carried opening are preserved; a stale `sourceHash` is rejected; a fix that introduces a new gate error is not offered.

### Phase 3: Deep check (story, neighbours, staging, vision) · **L**

1. Extend `buildSceneCheckInput` for `deep`: the assigned beat, scene intent, shot plan, the previous scene's end-frame prompt and card summary, and the next scene's start-frame prompt.
2. One Deep text call, with a structured `staging` section: actor → body state, support, each hand's task, contact. That section is used only to reason about conflicts; findings still have to cite text.
3. **Vision pass.** Reuse `loadQcImages` and the vision provider. Send the current attempt's start/end frames (or the current preview) plus the **character descriptions and card**. The vision system prompt must be explicit: *compare visible identity traits (skin tone, age, build, hair), headcount, wardrobe state and pose against the descriptions; report only what is visible.* Findings are `origin: "vision"`, attached to `startImage` / `endImage` and linked to the prompt that produced them.
4. **Fold the old QC into this.** When `qcEnabled` is on, post-render grading calls the Deep check's vision pass for that scene. The richer payload fixes the current blind spot. The existing `qcResult` remains for history and display compatibility.
5. **Keyframe preview hook:** a "Deep check this preview" link next to Keep.
6. **Tests:** neighbour continuity breaks are caught; an intentional cut is not flagged; sequential sit-then-stand is not a pose conflict; vision mode without frames reports `mode: "text"`, never claims to have seen frames.

### Phase 4: "Check first" on reruns · **M**

1. Add `check?: "quick" | "deep"` to `POST /queue?keyframes=1` and `?video=1`. When set, `checkScenes` runs first, scenes with unaccepted **error** findings are held, and the rest go to `enqueueKeyframeRerun` / `enqueueVideoRerun` as today.
2. The response and UI list the held scenes with their top finding, plus a **Render anyway** button for this run.
3. Project-settings defaults: the default depth, and the "Check first" default (**Off**).
4. **Tests:** held scenes are not queued; "Render anyway" queues them; with check Off, behaviour is byte-for-byte as today.

### Explicitly out of scope (for now)

- Any automatic check across the whole storyboard during storyboard or canvas runs.
- Auto-applying fixes.
- A dedicated reviewer-model routing stage.
- Video-motion QC from sampled clip frames. The endpoints alone cannot judge motion; revisit this after Phase 3.

---

## 7. Risks and open questions

- **Local-model reliability.** A 27B text model and a 9B vision model will produce false positives. Mitigations: findings must cite text the server can verify; `underspecified` findings are info, not errors; "Accept as intentional"; and holds apply only to `error` findings.
- **Vision on explicit content.** Your configured local vision model is uncensored, so this is fine locally. A hosted vision model may refuse explicit frames; that must surface as `coverage: "failed"`, never as a pass.
- **Identity extraction wording.** Phase 0 must quote the visual bible's own words, never infer a trait. If a description states no skin tone, nothing is inserted.
- **Prompt budget.** Inserting identity anchors costs about 10–20 tokens per character. They go through the existing budget trimming, which must treat identity as higher priority than ornamental detail.
- **Env var nit.** `.env.local` sets `Openai_vision_model` in lowercase. It works on Windows because Node environment variables are case-insensitive there, but it would silently disable vision on Linux or macOS. Renaming it to `OPENAI_VISION_MODEL` is worth doing.

## 8. Suggested order

| Order | Phase | Value |
|---|---|---|
| 1 | **Phase 0** — identity anchors + `identity_missing` | Directly removes the Leroy class of problem; no LLM cost |
| 2 | **Phase 1** — Quick check, per scene / selected | The on-demand check you asked for |
| 3 | **Phase 2** — Preview fix | Turns findings into one-click fixes |
| 4 | **Phase 3** — Deep check + vision | Catches story, continuity and rendered-identity problems |
| 5 | **Phase 4** — Check first on reruns | Guards GPU time only when you choose to |

Phase 0 is worth shipping on its own. It targets the specific drift you reported: frame prompts that name a story character without the traits that identify him. The project history records 21 hand edits but not what each changed, so I can't say how many of them it would have avoided. Phases 1–2 together give you the selectable Quick check with fix previews.
