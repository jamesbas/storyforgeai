# Auto LoRA scene assignment — feasibility and build plan

**Status:** assessment only. No code changed.
**Date:** 2026-07-29 (revised after decisions)
**Request:** have StoryForgeAI decide, per scene, which image and video LoRAs suit that
scene's prompts, attach them to the scene, and leave the result fully editable.

---

## 0. Decisions taken

| # | Question | Decision | Design impact |
|---|---|---|---|
| 1 | Apply or propose? | **Middle ground** — apply automatically, with visible provenance and one-click revert | Confirms the Phase 1 shape. No preview/accept queue to build. |
| 2 | LoRAs per scene | **2 per kind** | Well under `MAX_LORAS_PER_MODEL` (8). Matcher caps at 2 image + 2 video. |
| 3 | Merge with the storyboard-wide stack? | **No — replace** | **Scope reduction.** The existing `override` semantics already replace outright. No schema or resolution change needed; `resolveSceneLoras()` is untouched. |
| 4 | Trigger words | Append them. Auto-apply when there is none or one; ask the user when there are several; have the matcher pick if it can | Mostly **already implemented** — but the live metadata makes the "one → auto-apply" rule unsafe as stated. See §4. |

Decision 3 is the biggest simplification: it removes the merge concept entirely and leaves the
per-scene resolution rule exactly as it is.

Decision 4 changed the plan most, because investigating it exposed a live bug.

---

## 1. Verdict

**Feasible, and most of the hard parts already exist.** The output side — a per-scene LoRA
selection that overrides the storyboard-wide stack, is user-editable, survives a model change, and
is reconciled at generation time — is already built and in production use. Auto-assignment writes
into a structure that already works.

Two things must be fixed first, both **existing defects rather than new feature work**:

1. The catalog reads the wrong metadata field for a LoRA's human label (§3.1), so the matcher would
   have nothing meaningful to match against.
2. `trainedWords` is treated as a list of short activator tokens, when a third of the entries on
   this install are full prose sample prompts — and those are silently appended to scene prompts
   today (§4.2).

Both are prerequisites for a good matcher and worth fixing on their own merit.

---

## 2. What already exists (and does not need building)

| Capability | Where | Notes |
|---|---|---|
| Per-scene LoRA override, keyed by scene id | `lib/schemas/lora.ts` → `sceneLoraMapSchema` | `mode: "inherit" \| "override"`; override **replaces** — matches decision 3 |
| Resolution at generation time | `lib/lora/scene-selection.ts` → `resolveSceneLoras()` | Dependency-free so server and browser agree |
| Per-scene editing UI | `components/storyboard/scene-lora-panel.tsx` + `components/settings/lora-selector.tsx` | Add / remove / set strength / choose trigger words |
| Persistence | `PATCH /api/projects/[projectId]/models` → `updateProjectModels()` | `sceneLoras` is already an accepted patch field |
| Strict validation on save | `validateLoras()` | Unknown LoRA name is a hard error |
| Lenient reconciliation at render | `reconcileLoras()` | Incompatible entries dropped and logged rather than failing the scene |
| Stranded-selection cleanup | `pruneSelectionSet()`, `pruneSceneLoras()` | Runs when the pinned model changes |
| **Trigger-word rule from decision 4** | `lib/lora/trigger-words.ts` → `effectiveTriggerWords()` | **Already implements it**: none → nothing, one → auto-applied, several → nothing until chosen. `needsTriggerChoice()` flags the pending decision |
| Trigger words folded into the prompt | `appendTriggerWords()` in `lora-service.ts` | Appends only what the prompt does not already contain, on word boundaries |
| Stack ceiling | `MAX_LORAS_PER_MODEL = 8` | Auto-assignment caps at 2 per kind per decision 2 |

**Implication:** a matcher only has to emit `SceneLoraOverride` objects. Validation, editing,
reconciliation, pruning and prompt injection are all done.

---

## 3. What is missing

### 3.1 The catalog reads the wrong metadata field (existing bug, blocks matching)

`readSidecar()` in `lib/wangp/lora-catalog.ts` takes the human label from the sidecar's top-level
`name`. On this install that field is a **version string**.

Measured across the 77 sidecars for the two pinned families:

| Field | Coverage | Example values |
|---|---|---|
| `name` (currently used as the label) | 77/77, but **48 are version strings** | `"v1.0"`, `"V2"`, `"V1 4.2K Steps (Reccomend)"` |
| `model.name` (**not read today**) | 77/77, descriptive | `"Doggy Style - Side View LTX"`, `"NSFW Body Physics Fluid Motion Enhancer \| Lora \| LTX2.3"` |
| `trainedWords` | 42/77 | see §4 |
| `description` | 35/77 | free prose, HTML-tagged |
| `model.nsfw` | 77/77 | boolean |
| `model.tags` | 0/77 | absent here — do not design around it |

The picker currently labels `beej.safetensors` as **"v1.0"** rather than **"BEEJ"**. Standalone UX
bug, and the richest matching signal is being discarded.

### 3.2 No provenance on a scene's LoRA selection

`SceneLoraOverride` has no field recording *who* chose. Without it, decision 1's "apply with easy
revert" cannot be built: the UI cannot show a badge, re-running would trample user edits, and there
is no "clear all suggestions".

### 3.3 No matcher, agent, route or trigger

New surface: matching strategy, agent module, service entry point, API route, UI affordance.

### 3.4 Scene ids are not stable across storyboard regeneration

`sceneLoras` is keyed by scene id. In the deterministic path ids are `${projectId}-scene-001`. In
the **LLM path the model supplies the ids** (`sceneDraftSchema` requires `id`), so regenerating a
storyboard orphans every per-scene assignment. This already affects manual overrides;
auto-assignment makes it far more visible.

---

## 4. Trigger words — decision 4 investigated

### 4.1 The rule you described already exists

`effectiveTriggerWords()` implements exactly what you asked for: none or one → applied
automatically; more than one → nothing until the user picks; an explicit choice honoured, including
a deliberate empty. `needsTriggerChoice()` already tells the UI a decision is outstanding. **No work
required for the baseline behaviour.**

### 4.2 But the data says "one → auto-apply" is currently unsafe

`trainedWords` is not a homogeneous list of activator tokens. Classifying all 88 entries across the
two active families:

| Class | Count | Example |
|---|---|---|
| **Token** (≤24 chars, ≤3 words) | 34 | `BEEJ`, `DREAM_CUNI`, `cha1rt1ed`, `upskirt` |
| **Phrase** (≤60 chars, ≤8 words) | 22 | `locked in a wooden pillory`, `breast_grabbing` |
| **Prose** (longer) | **32** | 257 chars: `"restore the image quality, remove any compression artefacts, remove any haze and soft edges, en…"` |

Roughly **a third of all "trigger words" are prose**, and some are not prompt text at all — one is
the author's commentary (`"you can probably add a bit of angles and stuff… Trainingsdata is only
from behind"`), another is usage instructions (`"POV from above. | Viewpoint from side | (Or use no
viewpoint, works too)"`).

**This is a live problem, not a hypothetical one.** Of the 29 LoRAs with exactly one trigger word,
**8 have a single entry of 180–257 characters**. Because there is only one, `effectiveTriggerWords()`
auto-applies it and `appendTriggerWords()` appends it verbatim. Selecting one of those LoRAs today
silently bolts a 250-character sample prompt onto the scene — which, if the scene is not that exact
composition, overrides the action the user actually wrote.

**Recommended refinement to decision 4:** auto-apply a single trigger word only when it classifies
as a *token* or *phrase*. Prose entries are surfaced in the UI as a **sample prompt** for reference
and never appended automatically. This preserves your intent — activators land without ceremony —
while removing the corruption case.

### 4.3 How often a choice is actually needed

| Trigger words | LoRAs | Needs a decision? |
|---|---|---|
| None | 35 | No |
| Exactly one | 29 | No (subject to §4.2) |
| More than one | 13 | **Yes** |

**64 of 77 (83%) need no trigger decision at all.** Only 13 LoRAs require the new capability, which
makes automated trigger selection a contained problem rather than a sweeping one.

### 4.4 The multi-word 13 are not all the same shape

Two distinct semantics hide behind "more than one":

- **Exclusive selectors** — `DR34ML4Y` offers `m15510n4ry | bl0wj0b | d0ubl3_bj | d0gg1e | c0wg1rl`.
  Mutually exclusive positions; pick exactly one. This is the case a matcher can genuinely solve.
- **Additive modifiers** — `FLUX_NSFW_Fix` offers `Breast Size Shape Descriptions | Vulva | Anus |
  Pubic Hair | Hair Around Anus`. These compose; picking one would be wrong.

The catalog cannot distinguish them, which is exactly why the current code refuses to guess. A
matcher must therefore be allowed to answer **"I don't know"** and leave the choice pending, rather
than being forced to emit a selection.

### 4.5 Leetspeak

10 tokens substitute digits for letters (`m15510n4ry`, `cunn1l1ngu5`, `FU11N31S0N`, `g@n`). A
lexical matcher needs a de-leet normalisation pass (`1→i/l`, `0→o`, `5→s`, `3→e`, `4→a`, `@→a`)
before comparing against scene text, or it will match none of them. Cheap, and it makes the
deterministic path genuinely useful on the exclusive-selector case.

---

## 5. Matching strategy

### Option A — Lexical / keyword (no LLM)

Score catalog entries against scene prompts using `model.name`, token/phrase trigger words and
`description`, after de-leet normalisation.

- **Pros:** deterministic, instant, zero GPU, fixture-testable, works with AI planning disabled.
- **Cons:** no synonym handling — "she rides him facing away" will not match a LoRA named "Cowgirl".
  Weak on abstract names like "Body Physics Fluid Motion Enhancer".
- **Verdict:** the baseline and the fallback. Not sufficient alone.

### Option B — LLM via the existing planning provider

- **Pros:** handles synonym and intent. Can pick the right exclusive selector from §4.4. Produces a
  rationale, which is what makes decision 1's "apply with revert" reviewable.
- **Cons:** planning time; competes with generation for the GPU; large structured output is exposed
  to the same schema-rejection failure that produced the identical-scene storyboard bug.
- **Context budget:** ~95 entries × ~25 tokens ≈ 2.5k for the index. Comfortable. Use **one call for
  the whole storyboard** returning `sceneId → { image, video }`, since `enqueuePlanning` serializes.
- **Verdict:** the primary strategy.

### Option C — Embeddings

Disproportionate for ~100 items. Revisit only at thousands.

### Recommendation

**A as the deterministic floor, B as the default when a provider is available.** Use A to shortlist
(~20 per kind) before handing the index to B: smaller prompt, better attention, and a sane result
when the LLM call fails. Mirrors the existing agent pattern, where every agent has a deterministic
builder behind it.

---

## 6. Build plan

### Phase 0 — Catalog enrichment and trigger-word classification *(prerequisite)*

Nothing else works without this, and it fixes two live defects.

- `readSidecar()`: read `model.name` as the label, falling back to top-level `name`, then filename.
- Extend `LoraCatalogEntry`:
  - `description?: string` (HTML-stripped, truncated)
  - `nsfw?: boolean` (from `model.nsfw`)
  - `ecosystem?: string` (from `trainingDetails.params.ecosystem` — an independent compatibility
    signal, per `LORA Use.md` §4.3)
  - `triggerWords: { text: string; kind: "token" | "phrase" | "prose" }[]` — classified, per §4.2
- `effectiveTriggerWords()`: never auto-apply a `prose` entry, even when it is the only one.
- UI: show prose entries as a collapsible **sample prompt** rather than an appendable trigger.
- Keep every new field optional and degrade silently — a malformed sidecar must never hide an
  installed LoRA. That rule holds today and must not regress.
- **Touches:** `lib/wangp/lora-catalog.ts`, `lib/schemas/lora.ts`, `lib/lora/trigger-words.ts`,
  `lora-selector.tsx`.
- **Size:** small–medium. **Risk:** low, but `trigger-words.ts` is on the generation path — needs
  regression tests around `effectiveTriggerWords` / `appendTriggerWords`.
- **Test:** fixtures for version-string `name`, missing `model`, malformed JSON, absent sidecar, and
  a 250-char single trigger word that must **not** be appended.

### Phase 1 — Provenance and the deterministic matcher

- Extend `sceneLoraOverrideSchema` with `source: z.enum(["user","auto"]).default("user")` and an
  optional per-selection `rationale?: string`. Defaulted, so existing records parse unchanged.
- New `lib/lora/match.ts`: pure scoring of a catalog against scene text, with de-leet normalisation
  (§4.5). No I/O, no provider — unit-testable and usable in the browser for live preview.
- New service `assignSceneLoras(projectId, { kinds, overwrite })`:
  - writes **only** scenes whose override is absent or `source: "auto"` — a user edit is never
    trampled. `overwrite: true` is an explicit opt-in for re-running.
  - caps at **2 per kind** (decision 2);
  - runs results through `validateLoras()` before persisting;
  - leaves `triggerWords` **undefined** for multi-word LoRAs it cannot resolve, so
    `needsTriggerChoice()` surfaces the pending decision (§4.4).
- UI per decision 1: an "auto-assigned" badge in `SceneLoraPanel` showing the rationale, a one-click
  **Revert to inherit**, and a bulk **Clear all suggestions** on the storyboard screen.
- **Touches:** `lib/schemas/lora.ts`, new `lib/lora/match.ts`, new service, `scene-lora-panel.tsx`,
  `storyboard-view.tsx`, new `POST /api/projects/[projectId]/assign-loras`.
- **Size:** medium. **Risk:** low–medium (schema change handled by zod defaults, no migration).

### Phase 2 — LLM matcher and trigger-word selection

- New `lib/agents/lora-agent.ts` in the established shape: system prompt + JSON schema +
  deterministic fallback to Phase 1's matcher.
- **One call per storyboard.**
- Input per scene: `title`, `storyBeat`, `visualDescription`, `startFramePrompt`,
  `videoPromptSegment`, plus the shortlisted index (name, description, classified trigger words).
- Output: `{ sceneId, image: [{ name, triggerWords?, rationale, confidence }], video: [...] }`.
- The schema must permit `triggerWords: null` meaning "cannot determine" — see §4.4. Forcing a
  choice on an additive-modifier LoRA is worse than leaving it pending.
- **Salvage per scene, not all-or-nothing.** Direct lesson from the storyboard agent discarding
  fifteen good scenes over three missing `continuityNotes`. Validate each scene independently, keep
  what parses, fall back to lexical for the rest.
- Drop any name absent from the catalog rather than failing the run.
- Emit `agent.fallback` when the LLM path is not used, consistent with the storyboard agent.
- **Size:** medium. **Risk:** medium — structured-output reliability on a local model is the known
  weak point.

### Phase 3 — Judgement and polish

- **Audience gating:** `model.nsfw` is present on every sidecar. A project whose audience is
  `children` or `families` should not have an NSFW LoRA auto-attached. Gate auto-assign only, never
  manual selection.
- **Strength:** default `1`; allow a lower proposed weight for stacked enhancer LoRAs, clamped.
- **Scene-id stability:** address §3.4 by canonicalising scene ids server-side after the storyboard
  agent returns. Benefits manual overrides too.
- **Prompt-impact preview:** show the scene prompt with auto-appended trigger words highlighted, so
  the effect of decision 4 is visible before generating.

---

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Prose trigger word appended to a prompt | Silently corrupts the scene; **live today** | Phase 0 classification; never auto-apply `prose` |
| Structured output rejected | Falls back to lexical for all scenes | Shortlist; per-scene salvage; lenient schema with defaults |
| Auto-assignment overwrites user edits | Loss of deliberate work | `source` provenance; only touch `absent \| auto`; explicit `overwrite` |
| Wrong trigger word on an exclusive-selector LoRA | Worse than no LoRA | Allow "cannot determine"; leave pending rather than guess |
| Additive modifiers treated as exclusive | One of five needed hints applied | Do not force a single choice; when unsure, leave undefined |
| Stacking too many LoRAs | VRAM pressure; LoRAs fight each other | Cap at 2 per kind (decision 2) |
| Planning call competes with generation | CUDA OOM mid-batch | Run assignment before enqueueing media, never during |
| Storyboard regeneration orphans assignments | Silent loss of all suggestions | Phase 3 id canonicalisation; until then warn on regenerate when `sceneLoras` is non-empty |
| Metadata absent for some LoRAs | 7 of 43 image LoRAs have no sidecar | Score low, never crash; name-only entries stay selectable |
| Model changed after assignment | Stranded selections | Already handled by `pruneSceneLoras()` / `pruneSelectionSet()` |

---

## 8. Recommended sequence

1. **Phase 0** on its own. It fixes the label bug and the prose-append bug whether or not the rest
   proceeds, and it is the prerequisite for any matching quality.
2. **Phase 1** — usable auto-assignment with no LLM dependency, establishing the provenance model
   and decision 1's apply-with-revert UX.
3. **Phase 2** once Phase 1's shape has survived a real storyboard.
4. **Phase 3** driven by what proves annoying in use.

Decision 3 (replace, no merge) removed a whole design branch. Decision 4 turned out to be mostly
implemented already — but investigating it uncovered the prose-append defect, which is the single
highest-value fix in this document and is worth doing immediately, independent of auto-assignment.

---

## 9. Scale evidence

Live counts from the configured LoRA root:

```
flux2_klein_9b   43 LoRAs   (pinned image model)
ltx2             52 LoRAs   (pinned video model)
qwen             44
wan             120
z_image          48
```

For a 15-scene storyboard, choosing image + video LoRAs by hand is **30 decisions against a 95-item
catalog**, most with opaque filenames like `2GQ3Z0DP0SC5B3SB6Q40MJG3V0.safetensors`. This is the
case for automating it.
