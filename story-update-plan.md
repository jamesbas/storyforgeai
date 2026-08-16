# StoryForgeAI — remediation plan from the external assessment

Assessment reviewed against `68dbbc4` (main). Every P0 and P1 claim was checked
against the code rather than accepted. This file records what is true, where I
disagree with the assessment's priorities, and the order I would fix things in.

---

## 1. Verification results

### P0 claims

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| P0-1a | Legacy deterministic builder writes camera language into still prompts | **Confirmed** | `mock-agents.ts` `buildImagePrompts` emits `Opening framing of the shot; <cameraMovement> begins from here.` and `Closing framing after <cameraMovement>, …` |
| P0-1b | `motion_in_still` never runs on non-explicit projects | **Confirmed** | `prompt-gate.ts` `gateImagePrompt` returns at `if (!ctx.explicit) return codes;` and again at `if (!depictsSexAct(ctx.scene)) return codes;` — both before the motion check |
| P0-1c | Motion vocabulary is narrow | **Confirmed** | `MOTION_IN_STILL` covers rhythm/tempo/repeatedly/continuous/back-and-forth/in-and-out/each thrust. It does not cover camera travel, duration, or sequenced verbs |
| P0-1d | `MEDIA_PROMPT_COMPOSER_V2` off by default, so the better path is dormant | **Confirmed** | `config.ts` → `bool(process.env.MEDIA_PROMPT_COMPOSER_V2, false)` |
| P0-2 | No durable requirement/intent contract | **Confirmed as fact** | `createProjectSchema` + `creativeBriefSchema` carry prose and a `constraints: string[]`. Nothing distinguishes user fact, AI assumption, hard requirement, prohibition, or exact copy |
| P0-3a | Director-path Story Plan ignores the selected variant | **Confirmed** | `project-service.ts` `withStoryPlan()` sets `ctx.selectedVariant` but never merges it into `ctx.brief`; `storyArchitectAgent` sends only `{ project, brief }`. The orchestrator's merge at `orchestrator.ts` L47–63 is not reused |
| P0-3b | Variant selection does not invalidate dependents | **Confirmed** | `selectVariant()` rewrites flags, `selectedVariantId` and history only. `withStoryPlan()` then early-returns on any existing `storyPlan` |
| P0-3c | Variant tradeoffs become `Avoid:` constraints | **Confirmed** | Variant Explorer prompt: *"Risks must name what this direction **gives up**"*. `orchestrator.ts` L57: `` `Avoid: ${v.risks.join("; ")}` `` |

### P1 claims

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| P1-1 | Visual Bible does not receive the Story Plan | **Confirmed** | `visual-bible-agent.ts` payload is `{ project, brief, cast, plans, conceptVisuals }`; the orchestrator has `ctx.storyPlan` populated by then |
| P1-2 | Storyboard batches have backward but no forward context | **Confirmed** | `storyboard-agent.ts` sends `previousScene` and `segmentBeats.slice(start, end)` only |
| P1-3a | `emotionalProgression` length unchecked | **Confirmed** | `storyPlanSchema` has two independent `z.array(z.string())`; `validate` checks only `segmentBeats.length` |
| P1-3b | `sceneIntent` / `sceneShotPlans` are unvalidated records | **Confirmed** | `canvas.ts` → `z.record(z.string())` for both. Missing, extra or unresolvable keys all parse |
| P1-3c | Headcount check needs both frames to state a count | **Confirmed** | `gateFramePair` returns `[]` when either side is `null` |
| P1-4 | One global temperature for every call | **Confirmed** | `provider.ts` L288 hardcodes `temperature: config.openai.temperature` (default `0.7`); `GenerateOptions` carries no sampling |
| P1-5 | QC has no view of the original intent | **Confirmed** | `qc-agent.ts` payload is `{ scene, attempt, expectations }` — no concept, no requirement identity |

**All P0 and P1 claims are accurate.** No claim was found to be wrong.

---

## 2. Where I differ from the assessment

The findings are right; the ordering is not what I would choose.

1. **The assessment leads with the Story Contract and Shot Blueprint. Neither
   fixes the symptom that prompted the review.** The keyframe inconsistency being
   reported is explained almost entirely by P0-1a/1b/1c — camera language written
   into stills by the builder, and a stillness check that is switched off for
   every non-explicit project. Those are hours of work, not weeks.

2. **The variant bugs (P0-3a/3b/3c) are the highest ROI in the document and are
   not framed that way.** They are three small, concrete defects with large silent
   consequences: a Story Plan written as though no direction was chosen, reused
   forever; and a tradeoff description inverted into a prohibition. Each is a
   contained fix.

3. **The Story Contract is worth building, but it is a large change with the
   least certain payoff for the reported symptom.** Its real value is for
   advertising and corporate work — exact claims, CTA, disclaimers, terminology —
   which is a different problem from inconsistent keyframes. It goes last.

4. **One correction the assessment is right about, and it is mine.** The v2
   composer's `startState` derives from motion prose (`"…, at the first instant of
   <dominant motion>"`, added in v1.74 to stop the start frame reading generic).
   That is an improvement on the legacy path and still not a frozen state. Any
   Shot Blueprint work should replace it, not build on it.

5. **One caution on the assessment's Phase 1 item "apply motion-in-still checking
   to every project".** Done naively this will produce false positives — a still
   can legitimately say "mid-stride" or "his hand on the door". Camera travel and
   duration phrases are unambiguous and should hard-fail; sequenced subject verbs
   should warn, not block. The v1.77 lesson applies: a gate that fires on good
   prose is worse than no gate, because its repair then damages a correct prompt.

---

## 3. Plan

### Stage 1 — Stop the leaks (targets the reported symptom) — **done, v1.81**

- [x] **1.1 Make the stillness check universal.** The motion test now runs before
      the `!ctx.explicit` and `depictsSexAct` returns in `gateImagePrompt`.

- [x] **1.2 Split the motion vocabulary by confidence.** Three hard-fail groups in
      `prompt-gate.ts`: `CAMERA_TRAVEL_IN_STILL`, `DURATION_IN_STILL` (digits and
      number words) and the original `RHYTHM_IN_STILL`. Bare action verbs are
      deliberately excluded so "her hand rests on the door" and "caught
      mid-stride" still pass.
      *Deferred:* the warn tier for three or more ordered verbs. The gate has no
      severity concept — everything it returns triggers a retry — so a warning
      belongs in `lintRendered`, which is already advisory and already surfaced
      in the prompts panel. Tracked for Stage 2.

- [x] **1.3 Remove camera language from the legacy builder.** `<camera> begins
      from here` and `Closing framing after <camera>` are gone from
      `mock-agents.ts`.

- [x] **1.4 Fix the contradictory instruction.** "The same moment seconds apart"
      replaced with two frozen instants, plus the rule to convert an action into a
      pose, a point of contact, or a visible consequence.

- [x] **1.5 Apply the selected variant on every path.** `applyVariantToBrief` in
      `variant-set.ts`, called by both `orchestrator.ts` and `withStoryPlan()`.

- [x] **1.6 Stop inverting tradeoffs.** `risks` now read as "Tradeoffs this
      direction accepts (context, not instructions)". No `Avoid:` is synthesised.

- [x] **1.7 Enforce per-segment counts.** `emotionalProgression` is fitted to
      `segmentCount` (extras dropped, shortfall filled from the deterministic arc)
      and the execution is recorded `hybrid` when it had to be. `sceneIntent` and
      `sceneShotPlans` gaps are counted by `segmentsMissingFrom` and reported on
      the execution.
      *Decision:* the two canvas plans are **reported, not rejected**. Sending a
      plan that covers thirteen of fifteen segments to the deterministic builder
      would discard all thirteen. Retry-on-canvas needs `executeArtifact` to grow
      a retry, which is Stage 2 work.

### Stage 2 — Close the context handoffs

- [ ] **2.0 Advisory lint for sequenced action verbs** (deferred from 1.2) — the
      warn tier, in `lintRendered` rather than the gate.
- [ ] **2.1 Give the Visual Bible the Story Plan**, and require it to enumerate
      every recurring subject, location and prop the beats imply.
- [ ] **2.2 Give storyboard batches a forward window** — the next one or two beats,
      read-only, so a batch cannot end in a state the next beat cannot start from.
- [ ] **2.3 Trim stage payloads.** Stop sending the whole `project` object to prompt
      agents; send only the fields that stage uses. Measure prompt token count
      before and after.

### Stage 3 — Sampling per job

- [ ] **3.1 Add `temperature` to `GenerateOptions`** and thread it through
      `providerCall`.
- [ ] **3.2 Set profiles**: extraction/repair 0.0–0.2, prompt realisation 0.1–0.3,
      craft plans 0.3–0.5, story 0.4–0.6, variants 0.7–0.9.
- [ ] **3.3 Record model, temperature and prompt version in provenance** so an
      inconsistent artifact is reproducible.

### Stage 4 — Dependency fingerprints

- [ ] **4.1 Stamp each artifact** with a fingerprint of its inputs (concept hash,
      variant id, story-plan version, cast version, plan versions, prompt version).
- [ ] **4.2 Mark stale, never auto-delete.** Extend the existing plan-staleness UI
      to cover variant changes, and offer the targeted regeneration action.

### Stage 5 — Frozen frame states

- [ ] **5.1 Add `FrameState` / `ShotBlueprint`** with explicit start and end state
      authored during storyboard planning, and motion held separately.
- [ ] **5.2 Rewrite the v2 composer to consume them** rather than deriving
      endpoints from action prose.
- [ ] **5.3 Run the fixed-seed A/B per image family** that SPEC-003 §17 requires,
      then enable `MEDIA_PROMPT_COMPOSER_V2` by default.

### Stage 6 — Story Contract and requirement-aware QC

- [ ] **6.1 Add `StoryContract`** with typed requirements, source, strength, scope
      and exact-copy flags, plus assumptions and open questions.
- [ ] **6.2 Tri-state dialogue/narration/music/text policies** replacing the
      current booleans, which cannot express "forbidden".
- [ ] **6.3 Requirement coverage validation** at each stage.
- [ ] **6.4 Give QC the contract** so a finding names the failed requirement, the
      first faulty artifact, and the least destructive repair.

---

## 4. Sequencing rationale

Stage 1 is the only stage that changes what the next render looks like, and every
item in it is a contained fix to an identified defect. Stages 2–4 raise the floor
on plan quality and make failures diagnosable. Stage 5 is the structural fix the
assessment is really arguing for, and it should be built on frozen states authored
by the planner rather than on the current derived ones. Stage 6 is the largest
change and matters most for commercial work, which is not what is failing today.

Nothing in Stages 1–4 blocks Stage 5, and Stage 5 does not require Stage 6.

## 5. Risks to manage

- **Gate false positives.** v1.77 is the precedent: a check that fires on correct
  prose triggers a repair that damages it. Every new check needs a passing case
  built from a real prompt, not only a failing one.
- **Enabling the v2 composer is a rollout gate, not a code change.** It requires
  fixed-seed renders per family. Do not flip the flag to close a plan item.
- **Payload trimming can remove something load-bearing.** Change one stage at a
  time and keep the prompt-preview output for comparison.
