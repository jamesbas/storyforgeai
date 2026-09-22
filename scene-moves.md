# Moving and inserting scenes in a storyboard

Assessment date: 2026-09-21
Assessed against: StoryForgeAI `APP_VERSION` 2.52
Status: **Assessment and build plan. No code has been changed.**

---

## 1. Summary

Two capabilities are wanted on an existing storyboard:

- **Move** a scene up or down in the running order.
- **Insert** a new scene between two existing ones.

**Verdict: both are plausible, and moving is markedly cheaper than it looks.**

The reason is a design decision already made in this codebase: everything
expensive is keyed by **scene id**, and ordering comes from array position.
A move changes no ids, so every rendered frame, pinned seed, LoRA stack,
wardrobe change, audio cue and provenance record follows its scene for free.
What a move has to fix is a short, enumerable list — scene numbers, timings,
the end trim, two number-keyed plan maps — plus an honest account of the
continuity it disturbs.

| Capability | Verdict | Effort | Sequencing |
| --- | --- | --- | --- |
| **Move a scene** | Straightforward | **~1–1.5 weeks** | First release (D-1) |
| **Insert a scene** | Already fully specified, never built | **~1 week on the shared core** | Follow-up release |

Built in that order the two together come to roughly 2–2.5 weeks, against
appreciably more if each grew its own renumbering implementation.

### The finding that changes the plan

[docs/build-specs/add-scene-manual.md](./docs/build-specs/add-scene-manual.md)
(dated 2026-08-22) already specifies insertion in full — 24 functional
requirements, UX, technical design. **It was never implemented.** `insertScene`,
`addScene` and any renumbering helper do not exist anywhere in `lib/`, `app/`,
`components/` or `tests/`.

That spec's §4 Non-goals says:

> Deleting or reordering existing scenes. The renumbering helper this spec
> builds is the hard half of both, and both should be separate specs written
> against it.

So this document is the sequel that spec anticipated. The recommendation is to
**build the shared running-order core once and land both features on it**,
rather than implementing insertion to its existing spec and then retrofitting
moves. Doing them together is cheaper than doing them in sequence, and it stops
two different renumbering implementations existing.

---

## 2. Why this is feasible: what already works in our favour

**Scene id is the primary key, and nothing derives order from it.** `findScene`
matches on id; running order is array position. Ids happen to *contain* the
original scene number — `${project.id}-scene-003` from
[storyboard-agent.ts:180](./lib/agents/storyboard-agent.ts#L180) — but nothing
parses it back out, so an id reading `scene-003` while sitting seventh is
cosmetically odd and functionally harmless.

**Nine structures are keyed by scene id, and a move touches none of them:**

| Keyed by scene id | Where |
| --- | --- |
| `attempts` (rendered frames and clips) | [storyboard.ts:241](./lib/schemas/storyboard.ts#L241) |
| `previews` | [storyboard.ts:243](./lib/schemas/storyboard.ts#L243) |
| `project.sceneSeeds` | [project.ts:194](./lib/schemas/project.ts#L194) |
| `project.sceneLoras` | [project.ts:186](./lib/schemas/project.ts#L186) |
| `project.sceneEndFrameRefs` | [project.ts:204](./lib/schemas/project.ts#L204) |
| `project.wardrobeChanges` | [project.ts:168](./lib/schemas/project.ts#L168) |
| `assembly.plan.clips[].sceneId` | [assembly.ts:5](./lib/schemas/assembly.ts#L5) |
| `audioPlan` cues | [audio.ts:57](./lib/schemas/audio.ts#L57) |
| `executions[].artifact` (`${sceneId}.image_prompt`) | [provenance.ts](./lib/schemas/provenance.ts) |

**Audio cues are scene-relative and survive a move untouched.** `audioCueSchema`
carries `sceneId` plus `startSeconds`, documented as "Offset from the start of
the anchor scene" ([audio.ts:62](./lib/schemas/audio.ts#L62)). A cue two seconds
into scene 7 is still two seconds into that scene wherever it lands.

**A move changes no project totals.** `segmentCount`, `generatedDurationSeconds`,
`requestedDurationSeconds` and `finalTrimSeconds`
([project.ts:43–47](./lib/schemas/project.ts#L43)) are all invariant under a
permutation. This is the main respect in which moving is simpler than inserting.

**Retiming already exists in miniature.** `retimeScenes`
([project-service.ts:213](./lib/services/project-service.ts#L213)) holds every
scene to a clip length and clamps trims. It is a close cousin of what is needed.

---

## 3. What actually breaks, and what each break costs

### 3.1 Mechanical — must be fixed by the transform

**Scene numbers.** `sceneNumber` ([storyboard.ts:127](./lib/schemas/storyboard.ts#L127))
is stored, displayed everywhere, and used as a plan-map key. After any move or
insert it must be contiguous from 1, no gaps, no duplicates.

**Timings.** `startTimeSeconds` / `endTimeSeconds`
([storyboard.ts:128](./lib/schemas/storyboard.ts#L128)) are stored per scene and
must be recomputed for every scene from the lowest disturbed position onward.

**The end trim.** `trimAtEndSeconds` is written only onto the final scene
([storyboard-agent.ts:187](./lib/agents/storyboard-agent.ts#L187)). Move a scene
to or from last place and the trim must move with the position, not the scene —
otherwise a cut lands in the middle of the piece.

### 3.2 The genuinely hard one — number-keyed plan maps

`directorialPlan.sceneIntent` and `cinematographyPlan.sceneShotPlans` are
`z.record(z.string())`, resolved by `sceneEntry()`
([creative-context.ts:49](./lib/agents/creative-context.ts#L49)), which accepts
**four** key shapes for the same scene:

```ts
const candidates = [
  scene.id,
  String(scene.sceneNumber),
  `scene ${scene.sceneNumber}`,
  `Scene ${scene.sceneNumber}`,
];
```

plus a case-insensitive fallback. So renumbering silently re-points every
number-keyed entry at a different scene: the Cinematographer's shot plan written
for the old scene 7 becomes the plan for whatever is now scene 7.

**For a move this is a permutation, not a shift** — strictly harder than the
insertion case the earlier spec handled, and the single most error-prone part of
this work. Keys resolving to a scene **id** are already correct and must be left
alone; keys resolving to nothing are not ours to interpret and must also be left
alone.

### 3.3 Semantic — must be reported honestly, never silently repaired

**Continuity seams.** With `sceneContinuity` of `reuse_end_frame` or
`continue_video` ([types.ts:126](./lib/types.ts#L126) — `reuse_end_frame` is the
default), a scene opens on its predecessor's end frame. An attempt records this
as `startImageInherited: true` with `startImagePath` pointing at the neighbour's
rendered frame ([generation.ts:20–34](./lib/schemas/generation.ts#L20)).

A **move disturbs up to three seams at once**, which is what makes it messier
than an insert:

1. Where the scene left — its old neighbours now abut each other.
2. Where it landed — a pair that used to be adjacent is now split.
3. The moved scene itself now opens on a different picture entirely.

**Prompt seams.** `attachScenePrompts` seam-matches each scene's opening to the
previous scene's end-frame prompt — it carries `previousEndFramePrompt` through
the loop and sets `inheritsOpening` when continuity is `reuse_end_frame` and the
pair is not a `seamBreak`
([prompt-agents.ts:279](./lib/agents/prompt-agents.ts#L279),
[:328](./lib/agents/prompt-agents.ts#L328)). The *text* therefore goes stale in
exactly the same places as the frames.

**Wardrobe — the subtlest consequence.** `wardrobeTimeline`
([wardrobe.ts:20](./lib/agents/wardrobe.ts#L20)) walks scenes in running order
carrying each character's outfit forward, applying `wardrobeChanges` as it goes.
Moving a scene across a costume change therefore changes what that scene's
characters are wearing — **and changes it for every scene between the old and
new position too**, because a change that used to fire at position 4 now fires
at position 9. Nothing is lost (the changes are id-keyed), but the resolved
timeline genuinely differs. This is the one consequence a creator is least
likely to predict, and it deserves its own line in the warning.

**Assembly.** `finalCutClipSchema` stores **both** `sceneId` and `sceneNumber`
([assembly.ts:5](./lib/schemas/assembly.ts#L5)), and the clip array is ordered.
A stored assembly is wrong in both respects after a move and must be marked
stale.

### 3.4 Concurrency

`getQueue(projectId).active` ([scene-queue.ts:123](./lib/services/scene-queue.ts#L123))
reports whether scenes are pending or running. Reordering under a live drainer
would leave queue entries holding a `sceneNumber` that no longer names the scene
they were built for.

---

## 4. Goals

- A scene can be moved up or down, one position at a time, without losing a
  single rendered frame, seed, LoRA choice, wardrobe change, prompt edit or
  provenance record — for the moved scene or any other.
- A scene can be inserted at any position, to the contract already set out in
  [add-scene-manual.md](./docs/build-specs/add-scene-manual.md).
- After either operation the running order is internally consistent: numbering,
  timings, the end trim and the number-keyed plans all describe the scenes they
  are attached to.
- Every consequence the operation genuinely creates is stated plainly, before
  it happens and again afterwards on the affected cards.
- No frame is ever re-rendered, and no prompt ever rewritten, as a silent side
  effect.

## 5. Non-goals

- **Deleting scenes.** A third operation on the same core, and worth its own
  spec — deletion has to answer what happens to the deleted scene's rendered
  media, which neither of these does.
- **Move to an arbitrary position.** Up and down by one is the whole of the
  movement vocabulary. The permutation core supports a direct move, so this can
  be added later as a UI affordance without touching the transform.
- **Drag-and-drop reordering.** Up/down buttons are far easier to make
  accessible, and multi-position moves fall out of repeating the operation.
- **Re-planning the story.** Moving a scene does not re-run the Story Architect,
  and the beats are not rewritten to accommodate the new order.
- **Per-scene clip lengths.** Every scene stays `project.segmentSeconds` long.
- **Automatic repair of continuity.** The app reports what a move invalidated.
  Rewriting the affected prompts is offered as an opt-in, unticked checkbox in
  the same action (FR-21); nothing is ever rewritten or re-rendered without an
  explicit tick.
- **Migrating existing scene ids** so the embedded number matches the position.
  Ids are opaque and must stay that way.
- **The durable-task path** (`DURABLE_TASKS`). Both operations are record edits
  inside one request.

## 6. User stories

- As a creator who found the pacing wrong, I move scene 9 up to position 4 and
  keep every frame I have already rendered for all nine scenes.
- As a creator who needs a bridging beat, I insert a scene between 6 and 7
  without regenerating the storyboard.
- As a creator moving a scene past a costume change, I am told that its wardrobe
  now resolves differently, rather than discovering it in a render.
- As a creator who moved a scene under `reuse_end_frame`, I am told exactly which
  scenes now open on a picture that is no longer their predecessor's.
- As a creator who moved a scene to the end, the final trim comes with the
  position rather than staying on a scene now in the middle.
- As a creator with a batch running, I am refused the move and told why.

---

## 7. Functional requirements

### The shared core

- **FR-1:** A single pure module MUST own running-order normalisation, and both
  move and insert MUST call it. Two implementations of renumbering is the
  failure this requirement exists to prevent.
- **FR-2:** After any operation, `sceneNumber` MUST be contiguous from 1 with no
  gaps and no duplicates.
- **FR-3:** No scene's `id` may change, ever, under either operation.
  Renumbering MUST touch `sceneNumber` only.
- **FR-4:** `startTimeSeconds` and `endTimeSeconds` MUST be recomputed for every
  scene from the lowest disturbed position onward, leaving the timeline
  contiguous.
- **FR-5:** `trimAtEndSeconds` MUST end up on whichever scene is last **after**
  the operation, and MUST be cleared from any scene that is no longer last.
- **FR-6:** Number-keyed entries in `directorialPlan.sceneIntent` and
  `cinematographyPlan.sceneShotPlans` MUST be remapped through the full
  old-number → new-number permutation, so each entry keeps describing the scene
  it was written for. Keys that `sceneEntry()` would resolve to a scene **id**,
  and keys that resolve to nothing, MUST be left exactly as they are.
- **FR-7:** The remap MUST be computed once from the permutation and applied
  atomically. Applying it scene-by-scene would let one rewrite collide with
  another — the classic swap bug, where moving 4→5 and 5→4 leaves both holding
  the same entry.
- **FR-8:** Nothing keyed by scene id may be moved, dropped, rewritten or
  re-created: `attempts`, `previews`, `sceneSeeds`, `sceneLoras`,
  `sceneEndFrameRefs`, `wardrobeChanges`, assembly clips, audio cues and
  `executions`. An operation that touches any of them is a defect regardless of
  whether the result looks right.

### Moving

- **FR-9:** A scene MUST be movable one position up or down. Moving the first
  scene up, or the last scene down, MUST be refused as a no-op rather than
  silently doing nothing.
- **FR-10:** A move MUST NOT change `segmentCount`, `generatedDurationSeconds`,
  `requestedDurationSeconds` or `finalTrimSeconds`.
- **FR-11:** A move MUST be refused with a 409 while `getQueue(projectId).active`.
- **FR-12:** A move MUST be a single atomic record update. A half-applied
  reorder — renumbered but not retimed — is worse than a refused one.

### Inserting

- **FR-13:** Insertion MUST follow the requirements already set out in
  [add-scene-manual.md](./docs/build-specs/add-scene-manual.md) §6, which this
  spec adopts by reference rather than restating. The substantive change is that
  its renumbering and retiming MUST come from the FR-1 core.
- **FR-14:** The new scene's `id` MUST be minted independently of its number and
  MUST NOT collide with any existing id, nor with any id the storyboard
  generators could mint later. This is what makes FR-3 and FR-8 possible.

### Reporting consequences

- **FR-15:** Before the operation is committed, the app MUST present what it
  will invalidate, and the creator MUST confirm. The warning MUST name actual
  scenes, not categories.
- **FR-16:** The impact report MUST cover, and MUST be computed rather than
  assumed:
  - scenes whose latest attempt has `startImageInherited === true` and whose
    predecessor is about to change;
  - scenes whose start-frame prompt was seam-matched to a predecessor that is
    about to change;
  - scenes whose resolved wardrobe differs between the old and new running
    order, computed by running `wardrobeTimeline` over both;
  - whether a stored `assembly`, `audioPlan` or `animaticPlan` becomes stale.
- **FR-17:** Where continuity is `cut`, the frame and prompt seam entries MUST
  be omitted — nothing inherits, so there is nothing to invalidate, and a
  warning that does not apply trains people to dismiss warnings.
- **FR-18:** No attempt may be deleted, and no `startImagePath` rewritten, as a
  result of either operation. The stale inheritance is recorded and surfaced,
  not repaired.
- **FR-19:** Affected cards MUST carry a persistent notice afterwards, in the
  same amber register as the existing cascade and clip-stale notices, so the
  consequence survives the dialog being dismissed.
- **FR-20:** Both operations MUST append a history entry naming the scene and
  the movement, so `handEditedSinceGeneration` and the storyboard's staleness
  checks have something to read.
- **FR-21:** The confirmation MUST offer an **opt-in** checkbox to rewrite the
  prompts of the scenes the operation invalidated, **unticked by default**.
  - It MUST be offered only when FR-16 found a frame or prompt seam to
    invalidate. On a `cut` project, or a storyboard with nothing rendered, the
    checkbox MUST be absent rather than present and inert.
  - It MUST name the scenes it would rewrite, and MUST make clear that doing so
    replaces their current prompt text — including any hand edits.
  - It MUST reuse `regenerateScenesPrompts(id, sceneIds, { passes })`
    ([project-service.ts:1125](./lib/services/project-service.ts#L1125)) rather
    than a new path. That function already walks every scene in running order,
    so the wardrobe timeline and the seam match are computed against the
    **new** neighbours — which is the entire point, and the reason this must
    run after the reorder is persisted, not as part of the transform.
  - It MUST default to the `image` pass alone. The invalidation is a keyframe
    seam; rewriting the clip prompts costs a second model call per scene to
    replace text that was never at fault.
  - A failure to rewrite MUST NOT roll back the move. The reorder is the
    committed fact; a failed rewrite is reported and leaves the prompts as they
    were.
- **FR-22:** Nothing may be re-rendered by either operation, with or without
  FR-21. Rewriting a prompt does not produce a frame, and the creator reaches
  for *Generate all media* when they are ready.

---

## 8. UX requirements

### Where the controls go

Each scene card is an `<article>` opening with a header that is currently a
two-child flex row — title on the left, timing and status on the right
([scene-card.tsx:192](./components/storyboard/scene-card.tsx#L192)):

```jsx
<header className="flex items-baseline justify-between">
  <h3>Scene {scene.sceneNumber} — {scene.title}</h3>
  <span>{start}s–{end}s (trim Ns) · {status}</span>
</header>
```

The four controls belong **in a dedicated row directly beneath this header**,
above the existing panels — the top of the card, as requested, but on their own
line rather than squeezed into the header itself. Three reasons, all practical:

- The header is `items-baseline`, which is correct for text and wrong for
  buttons: they would sit visually misaligned against the title.
- A third element in a `justify-between` row has no natural position, and four
  buttons plus a title plus a timing string wraps badly on a narrow window.
- The row is a natural place for the disabled/notice states the operations need.

**Recommended layout** — one row, two logical groups, left-aligned so the eye
finds them in the same place on every card:

```
┌─ Scene 7 — The Ritual ─────────────────── 120s–140s · rendered ─┐
│  [ ↑ Move up ] [ ↓ Move down ]   [ + Insert before ] [ + Insert after ] │
│  ...scene card, prompts, media...                                        │
```

- **FR-U1:** Move and Insert MUST be visually separated into two groups. They
  are different kinds of action — one rearranges what exists, the other creates
  something — and a row of four identical buttons invites the wrong click.
- **FR-U2:** Every control MUST be a real `<button>` with an accessible name
  carrying the scene number: *"Move scene 7 up"*, *"Insert a scene before scene
  7"*. The visual position is the entire meaning of these controls, so a screen
  reader hearing four identically-named buttons per card learns nothing. This is
  also what the component tests will select on.
- **FR-U3:** **Move up** MUST be disabled on the first scene and **Move down**
  on the last, with a `title` explaining why rather than a silently dead button.
- **FR-U4:** The controls MUST be hidden entirely when `projectId` is absent, in
  line with how the card already gates its editing panels — the card stays
  renderable on its own.
- **FR-U5:** All four MUST be disabled while the card is `busy` and while the
  project's queue is active, so the FR-11 refusal is something a creator meets
  as a greyed-out button rather than an error dialog.

### On insert before / insert after

Offering both on every card means scene 3's *Insert after* and scene 4's
*Insert before* address the same gap. That duplication is **accepted
deliberately**: each card stays self-contained, a creator thinking "after this
one" and one thinking "before that one" both find it immediately, and the two
buttons are individually unambiguous.

- **FR-U6:** Both MUST resolve to the same insertion index, computed from the
  one permutation model in §9. They are two labels for one operation, not two
  code paths, and a test MUST assert they produce identical records.
- **FR-U7:** The earlier spec's separate "Insert scene here" affordance *between*
  cards MUST NOT also be built. Two competing affordances for one action is
  worse than either alone; this per-card pair replaces it.
- **FR-U8:** *Insert before* on scene 1 is how a creator prepends, and *Insert
  after* on the last scene is how they append. Neither may be disabled — these
  are the two positions the old spec needed extra controls to reach.

### The confirmation

- **FR-U9:** Activating any of the four opens a confirmation showing the
  computed impact from FR-16, written as consequences rather than mechanisms:
  *"Scene 8 opens on a frame carried over from scene 7. After this move that
  frame comes from a different scene, so scene 8's opening will not match until
  you re-render it."*
- **FR-U10:** Where nothing is invalidated — continuity `cut`, or nothing
  rendered yet — the dialog MUST say so plainly and offer a simple confirm. A
  warning that cries wolf on an untouched storyboard trains people to dismiss
  the one that matters.
- **FR-U11:** The wardrobe consequence MUST be called out as its own line when
  it applies. It is the one a creator will not predict.
- **FR-U12:** The FR-21 rewrite checkbox sits directly beneath the consequence
  list, unticked, reading as an offer rather than a recommendation — *"Rewrite
  the opening prompts for scenes 8 and 12 to match their new neighbours. This
  replaces their current prompt text."*
- **FR-U13:** For an insert, the dialog doubles as the card form already
  specified in [add-scene-manual.md](./docs/build-specs/add-scene-manual.md) §7,
  and MUST name the two scenes it is going between.

### After the operation

- **FR-U14:** The list MUST scroll to the moved or inserted card and announce
  the result through the existing `AsyncStatus` pattern, naming the scene and
  what happened — including which scenes, if any, had their prompts rewritten.
- **FR-U15:** Focus MUST land on the moved card's corresponding move control,
  so a creator moving a scene three positions presses the same key three times
  without re-hunting. This is the difference between the feature being usable
  and being technically present.
- **FR-U16:** Affected cards MUST carry a persistent amber notice afterwards
  (FR-19), so the consequence survives the dialog being dismissed. A card whose
  prompts were rewritten under FR-21 MUST NOT carry the prompt-seam notice,
  because that consequence has been dealt with.
- **FR-U17:** The scene-count and duration summary in the storyboard header MUST
  reflect an insertion immediately. A move leaves both unchanged.
- **FR-U18:** The Help page's storyboard section MUST cover both operations and
  state the two things that cannot be guessed: that moving never re-renders
  anything, and that a scene moved across a costume change may resolve to a
  different outfit.

---

## 9. Technical design

### Probable files

**New:**

- `lib/storyboard/running-order.ts` — the pure core. No I/O, no service imports.
  - `renumber(scenes)` → contiguous numbering
  - `retime(scenes, segmentSeconds)` → start/end times
  - `placeTrim(scenes)` → trim on the last scene only
  - `remapNumberKeys(map, permutation)` → FR-6/FR-7, id keys and unresolved keys
    passed through untouched
  - `normaliseRunningOrder(record, permutation)` → the one entry point
- `lib/storyboard/move-scene.ts` — the move transform over the core.
- `lib/storyboard/insert-scene.ts` — the insert transform over the core (the
  file the existing spec already proposed).
- `lib/storyboard/order-impact.ts` — FR-16. Pure: takes before and after
  running orders and returns a structured report. Being pure is what makes the
  dialog and the tests agree.
- `app/api/projects/[projectId]/scenes/[sceneId]/move/route.ts` — `POST { direction }`.
- `app/api/projects/[projectId]/scenes/insert/route.ts` — `POST { anchorSceneId, side, card }`,
  where `side` is `before | after`. One endpoint serves both card buttons.
- `components/storyboard/scene-order-controls.tsx` — the four-button row of §8.
- `components/storyboard/order-impact-dialog.tsx` — the confirmation, shared by
  both operations, with the insert card form mounted inside it.

**Modified:**

- `lib/services/project-service.ts` — `moveScene()` and `insertScene()`
  orchestration: load, guard on the queue, apply the transform, persist, append
  history. The transforms stay pure and out of this file.
- `lib/schemas/storyboard.ts` — `moveSceneSchema`, `insertSceneSchema` (the
  latter carrying `anchorSceneId` and `side`, so *insert before 4* and *insert
  after 3* arrive as the same resolved index).
- `components/storyboard/scene-card.tsx` — mounts the order controls row beneath
  the existing header; `storyboard-view.tsx` wires the handlers and notices.
- `app/help/page.tsx`, `README.md`, `CHANGELOG.md`, `lib/version.ts`.

### The permutation, stated once

Every operation reduces to *"here is the new array of scene ids, in order"*.
From that one value the core derives:

- the new `sceneNumber` for each id;
- the old-number → new-number map for FR-6;
- the retimed start/end seconds;
- which position now holds the trim;
- which adjacency pairs changed, which is exactly the seam impact.

Expressing both features as "produce a permutation, then normalise" is what
keeps the second feature nearly free once the first is built, and it is why
FR-1 insists on one core.

### What deliberately stays untouched

`attempts`, `previews`, `sceneSeeds`, `sceneLoras`, `sceneEndFrameRefs`,
`wardrobeChanges`, audio cues and `executions` are never read or written by the
transform. If an implementation finds itself needing to touch them, the
permutation model has been abandoned and the design should be revisited rather
than patched.

---

## 10. Risks

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| RISK-1 | Plan-map remap collides during a swap, leaving two scenes with one entry | **High** | FR-7: compute the whole permutation first, apply atomically. Direct test for the 4↔5 swap. |
| RISK-2 | Wardrobe silently resolves differently after a move | **High** | FR-16 computes both timelines and diffs them; FR-19 puts it on the card. |
| RISK-3 | Stale inherited frames read as "the app broke my scene" | Medium | FR-15/FR-19 name the affected scenes before and after; never repair silently. |
| RISK-4 | A move during an active batch corrupts queue entries | Medium | FR-11 refuses with a 409. |
| RISK-5 | Partial write leaves numbering and timings disagreeing | Medium | FR-12: one atomic record update, pure transform, no I/O mid-way. |
| RISK-6 | Scene ids keep an embedded number that no longer matches position | Low | Accepted and documented. Ids are opaque; nothing parses them. |
| RISK-7 | Warning fatigue from a dialog on every move | Low | FR-17: suppress inapplicable entries; plain confirm when nothing is invalidated. |

---

## 11. Test plan

The suite is currently 155 files / 1861 tests and is the safety net for this
work. The transforms being pure is what makes most of this cheap to cover.

**Core (pure, no fixtures):**

- Renumbering is contiguous after a move up, a move down, an insert at the
  front, between, and at the end.
- No id changes under any operation — asserted as a set comparison before/after.
- Timings stay contiguous and total to `generatedDurationSeconds`.
- The trim follows the last *position*, not the scene.
- Plan remap: number keys shift correctly; **a 4↔5 swap does not collapse**;
  id keys untouched; unresolved keys untouched; `"Scene 3"` and `"scene 3"`
  forms both handled.

**Service:**

- Every id-keyed structure is byte-identical before and after a move — one test
  asserting all nine at once, which is the FR-8 guarantee.
- A move is refused with 409 while the queue is active.
- Moving the first scene up and the last down is refused.
- Project totals are unchanged by a move.
- Insertion satisfies the existing spec's requirements.

**Impact report:**

- Under `cut`, no frame or prompt seam entries are produced.
- Under `reuse_end_frame`, exactly the scenes whose predecessor changed are
  named.
- A move across a costume change reports the wardrobe difference; a move that
  crosses none does not.

**Opt-in rewrite (FR-21):**

- The checkbox is absent when the impact report found no seam to invalidate.
- Unticked, a move rewrites no prompts — asserted by comparing every scene's
  `prompts` object before and after.
- Ticked, only the scenes named in the report are rewritten, only the `image`
  pass runs, and the rewrite happens **after** the reorder is persisted, so the
  seam is matched against the new neighbours.
- A failing rewrite leaves the reorder committed and reports the failure.

**Component:**

- All four controls render on a card, grouped as two pairs, and each carries an
  accessible name naming its scene.
- **Move up** is disabled on the first scene, **Move down** on the last; both
  *Insert* buttons stay enabled on every scene including the ends.
- All four are disabled while the card is busy or the queue is active.
- The controls do not render when `projectId` is absent.
- **Insert after scene 3 and insert before scene 4 produce an identical record** —
  the FR-U6 guarantee, and the test that stops the two buttons drifting apart.
- The dialog lists the computed consequences, and confirms plainly when there
  are none.
- Focus lands on the moved card's move control after a successful move (FR-U14).

**Regression:** the full suite must pass unchanged — no existing test should
need editing, because no existing behaviour is meant to change.

---

## 12. Suggested phasing

| Phase | Scope | Effort | Status |
| --- | --- | --- | --- |
| **1** | `running-order.ts` + `order-impact.ts` with their unit tests. No UI, no routes. | ~3 days | **Delivered (v2.53)** |
| **2** | `moveScene` service, route, queue guard, history, opt-in rewrite (FR-21). | ~2–3 days | **Delivered (v2.53)** |
| **3** | The four-button control row (move pair live, insert pair disabled), impact dialog, card notices, Help. | ~2–3 days | **Delivered (v2.53)** |
| **4** | *Follow-up release:* `insertScene` on the same core, to the existing spec; the insert pair goes live. | ~1 week | Not started |

Per **D-1**, phases 1–3 are the first release and deliver moving on its own.
Building the full control row in phase 3 with the insert pair present but
disabled — labelled *"coming in the next release"* — is deliberate: it settles
the layout once, so phase 4 is a service change rather than another pass over
the card.

Phase 4 then costs materially less than the original insertion spec estimated,
because the hard half — renumbering, retiming, plan remapping, impact reporting
— is already built and tested.

---

## 13. Decisions taken

Settled with the operator on 2026-09-21; the requirements above reflect them.

| # | Decision |
| --- | --- |
| D-1 | **Moving ships first**, as a self-contained increment (phases 1–3). Inserting follows on the same core as a second release. |
| D-2 | **A move warns, and offers an opt-in prompt rewrite** for the scenes it invalidated — unticked by default, image pass only, never automatic (FR-21). |
| D-3 | **Up/down by one position only.** No "move to position N" and no drag-and-drop for now; the core supports the former whenever it is wanted. |
| D-4 | **Deleting scenes is out of scope**, and stays a separate spec — it is the only one of the three that has to answer what becomes of the deleted scene's rendered media. |

## 14. Remaining open questions

1. Should the FR-21 rewrite ever offer the `video` pass as well? The default is
   image-only because the invalidation is a keyframe seam, but a scene that
   moved across a costume change may have a clip prompt describing the wrong
   outfit.
2. Should a move be blocked, rather than warned, when the moved scene has an
   **approved** attempt feeding a stored assembly? The approval gate already
   stops a re-cut, so a warning is probably sufficient — but it is the one case
   where the consequence reaches a finished deliverable.
