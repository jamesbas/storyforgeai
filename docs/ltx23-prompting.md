# LTX 2.3 prompt alignment — findings and build spec

> **Partly superseded, 2026-08-14.** LTX has since folded its prompting guidance
> into one document covering 2.5
> ([docs.ltx.io](https://docs.ltx.io/open-source-model/usage-guides/prompting-guide)),
> and the blog's "LTX-2.5 Prompt Guide" is that same page. Two consequences:
> **R8 (a version-aware LTX profile) should not be built** — the guidance
> converged, so one profile is now correct, and `familyOf` already resolves
> `ltx2_25_*` to `ltx`. **R11 (cap the budget at 200 words) is no longer
> supported by the source** — the current guide replaces the fixed count with
> "match length to complexity". The single-take rule, the beat ceiling from
> §2.1, the shared speech-rate constant and dialogue language/accent shipped in
> v1.76. Everything else below still stands.

Reviewed 2026-08-04. Two sources, and they are complementary rather than
duplicative:

- **G1 — the prompting guide.** LTX-Video team, mirrored at
  [ComfyUI-Agent-Toolkit/prompting-guides/ltx-2.3-prompting-guide.md](https://github.com/Zambav/ComfyUI-Agent-Toolkit/blob/main/prompting-guides/ltx-2.3-prompting-guide.md).
  What a good prompt contains.
- **G2 — the adherence article.** LTX Team,
  [How To Improve LTX-2.3 Prompt Adherence](https://ltx.io/blog/how-to-improve-ltx-2-3-prompt-adherence)
  (2026-05-13). *Why* the model responds to it, plus the numeric limits and the
  guidance parameters that G1 never mentions. G2 is the more actionable of the
  two for this codebase because several of its claims are hard numbers that can
  be asserted in a test.

Where they conflict, G2 wins on numbers (it cites the documentation) and G1 wins
on wording. The one substantive tension is action density, resolved in §2.1.

All output quoted below was produced by `npm run prompts:preview`, not
reconstructed by reading code.

---

## 1. How StoryForge builds a video prompt today

There are **three** paths to `ScenePrompts.videoPromptSegment`, and they do not
agree with each other.

### Path A — deterministic v1 (`MEDIA_PROMPT_COMPOSER_V2=false`, the current default)

[lib/agents/mock-agents.ts](../lib/agents/mock-agents.ts) `buildVideoPrompts`
concatenates, in this order:

```
visualDescription. actionDescription. storyBeat.
Camera: <cameraMovement lowercased>, evolving from the start frame to the end frame over N seconds.
<dialogue quoted inline> <narration> Preserve subject identity, wardrobe, location, and lighting throughout.
+ lookPromptSuffix + sceneDirectionSuffix + globalStyleSuffix + castContinuityClause
```

The `family` argument is accepted and **ignored** on this path. Every family
gets byte-identical text:

```
[v1] ltx · video
Medium close-up of the apprentice at the bench, low angle. She seats the gear with a firm
clockwise turn. The scarf whips left. The apprentice commits to the repair. Camera: slow
push-in on the subject., evolving from the start frame to the end frame over 5 seconds.
Ana says, "Then we decide now." Lip movement matches the spoken words. Preserve subject
identity, wardrobe, location, and lighting throughout. cinematic style, moody mood.
```

### Path B — deterministic v2 (`MEDIA_PROMPT_COMPOSER_V2=true`, SPEC-003, flag off)

[lib/agents/media-prompt-builder.ts](../lib/agents/media-prompt-builder.ts)
`buildMediaPromptSpec` turns the scene card into a `MediaPromptSpec`;
[lib/agents/media-prompt-renderers.ts](../lib/agents/media-prompt-renderers.ts)
`renderVideoPrompt` has a real `case "ltx"` branch: dominant motion → secondary
motion → camera → end state → ambience → dialogue → narration → continuity, one
flowing paragraph, trimmed to `wordBudget("ltx", "video", seconds)` =
`min(320, 90 + 9·seconds)`.

```
[v2] ltx · video
Over 5 seconds, she seats the gear with a firm clockwise turn. The scarf whips left. The
camera makes a slow push-in on the subject. Ana says, "Then we decide now." Lip movement
matches the spoken words. Same characters, wardrobe, and location as the start frame.
Preserve subject identity, wardrobe, location, and lighting throughout. cinematic style,
moody mood.
```

### Path C — LLM (Video Prompt Agent)

[lib/agents/prompt-agents.ts](../lib/agents/prompt-agents.ts) composes the system
prompt as `videoPromptSystem(segmentSeconds)` +
`explicitnessDirective` + `videoPromptDirective(family, {segmentSeconds, nativeAudio})`
+ `castSystemDirective` + `precedenceDirective`. The LTX branch of
[lib/agents/model-directives.ts](../lib/agents/model-directives.ts) is the only
place in the app that carries LTX-specific guidance today, and it is decent: one
flowing present-tense paragraph, 4–8 sentences, behaviour instead of emotion
labels, camera stated relative to subject, no readable text, audio described,
dialogue quoted with delivery named.

Output is then run through `normaliseVideoPrompt` (dedupe + punctuation only —
no framing enforcement, correctly) and `withCastEnforcedVideo`, which appends
`lookPromptSuffix` and `castContinuityClause`.

**The family is resolved from `project.videoModel || config.wangp.videoModel`
via `familyOf()`. An unpinned project on an unpinned env default gets
`unknown` → the LTX directive never fires.**

---

## 2. Gap analysis against the LTX 2.3 guide

| Guide principle | StoryForge today | Verdict |
|---|---|---|
| 1. Be specific — the engine can handle it | v2 LTX budget 135 words @5s, 270 @20s. v1 has no budget. | OK (v2) |
| 2. Direct the scene — left/right, fore/background, facing | Nothing asks for or emits spatial blocking, in either the image or the video path | **Gap** |
| 3. Describe texture and material | Absent from video (defensible for I2V); `imagePromptDirective` has **no `ltx` case**, and LTX-2 renders stills too | **Gap** |
| 4. For I2V, use verbs | v2 leads with the dominant verb. v1 — the shipping default — opens with a static description and reaches the camera in sentence 5 | **Gap (v1)** |
| 5. Avoid static, photo-like prompts | Same as 4 | **Gap (v1)** |
| 6. Design for native portrait | `config.media.resolution` is one env-wide `1280x720`; no per-project aspect, no orientation ever stated in a prompt | **Gap** |
| 7. Be clear about audio | Directive asks the LLM for ambience/Foley. Deterministic v2 emits `Ambience:` **only** when a World Bible location name matched the scene text, so in practice it emits nothing. v1 emits nothing ever | **Gap** |
| Shot priority — one dominant event | `splitMotion` promotes one, keeps one, drops the rest (v2 only) | OK (v2) |
| Named motion over style words | Every path ends with `cinematic style, moody mood.` — the guide names `cinematic` explicitly as a word that carries no action. Defaults are `style: "cinematic"`, `tone: "inspirational"` | **Gap** |
| Camera intent | `deriveCameraMotion` + explicit `The camera holds still` | OK (v2) |
| Order: subject → action → camera → mood | v2 is action → camera → … → mood-by-suffix. Subject omitted on purpose (start frame carries it) | OK for I2V |
| Format: one paragraph, present tense, 4–8 sentences | v2 LTX matches. `videoPromptDirective` states 4–8 explicitly | OK |
| Avoid internal emotional states | `sceneDirectionSuffix` appends `Scene intent: <Director's intent>` verbatim to every deterministic prompt, and directorial intent is emotional by nature ("build dread"). `lookPromptSuffix` appends `<tone> mood` | **Gap** |
| Avoid text and logos | Stated in the LTX directive. **Not in the negative prompt** — `videoNegativePrompt` carries flicker/jitter/warping/duplicated subjects/abrupt cuts/identity drift/background deformation/unintended camera movement and no text, watermark, subtitle or logo term. LTX *does* support negative prompts (`supportsNegativePrompt("ltx") === true`) | **Gap** |
| Avoid conflicting lighting | `globalStyleSuffix` appends a Cinematographer lighting rule to the **video** prompt, competing with the lighting already baked into the start frame | **Gap** |
| **G2:** under 200 words | LTX budget is `min(320, 90 + 9·seconds)` → 180 words at 10s, **270 at 20s**. v1 has no budget at all | **Gap** |
| **G2:** one main action per 2–3 seconds | `splitMotion` returns exactly one dominant + one secondary at every duration, 5s to 20s. **Decided §2.1: adopt the rule** | **Gap** |
| **G2:** write chronologically — each sentence is a temporal beat | The LTX renderer emits **by category, not by time**: motion → camera → end state → ambience → dialogue → narration → continuity. A line spoken at the top of the clip is described after the shot has settled | **Gap** |
| **G2:** be literal, not metaphorical | Same defect as the emotional-state row, with a sharper statement: "a tense confrontation gives the model nothing to work with". `Scene intent` is exactly that kind of phrase | **Gap** |
| **G2:** always specify camera, or the model drifts | `deriveCameraMotion` emits `The camera holds still` when the card says static | OK (v2) |
| **G2:** no conflicting instructions | Style suffix + art-direction lighting rule + continuity clause + preserve clause all stack onto one prompt | **Gap** |
| **G2:** frame count must satisfy `(F-1) % 8 == 0` | `frameCountForFps` = `ceil(fps·seconds / 8) · 8 + 1`, so `F-1` is always a multiple of 8 | **OK — verified** |
| **G2:** bypass the prompt enhancer for creative control | `buildSettingsManifest` forces `prompt_enhancer = ""` on every job, because LTX-2 22B ships with it on | **OK — now externally justified** |
| **G2:** `cfg_scale` / `stg_scale` / `rescale_scale` govern adherence | StoryForge writes **none of them**. See §2.1 | **Gap** |

### 2.1 Action density — decided

G1 says "one dominant event or shot idea instead of several competing moments".
G2 says "one main action per 2–3 seconds of video" and that five actions in one
prompt will be compressed or skipped.

**Decision (2026-08-04): adopt G2's one-action-per-2–3-seconds rule.** The two
sources separate cleanly once *anchoring* is distinguished from *density*: there
is still exactly one action the clip is **about**, stated first, and G2's rule is
a ceiling on how many further beats may follow it. G1 is not overruled — it
never gave a number.

The implementation constant is `SECONDS_PER_ACTION_BEAT = 3`, the conservative
end of the published range rather than the 2.5 midpoint, because G2 also warns
that "each new element you add dilutes attention slightly" and that an
overloaded prompt drops its middle actions. Taking the cautious end costs one
beat at 20s and removes the failure mode entirely. The constant is the knob if
live renders say otherwise.

| Segment | Beats today | Beats under the rule |
|---|---|---|
| 5s | 2 | 1 |
| 10s | 2 | 3 |
| 15s | 2 | 5 |
| 20s | 2 | 6 |

Three consequences worth stating before anyone implements this:

1. **The 200-word cap binds before the beat ceiling at long durations.** At 20s
   the budget is 200 words total, of which dialogue can legitimately claim ~50
   (2.5 words/second) and camera, ambience and continuity another ~30. Six beats
   then have ~120 words between them, or 20 words each. That is workable but
   tight, so the ceiling must be applied as *"at most N, and fewer if the word
   budget says so"* — never the reverse. Dialogue stays authoritative and is
   never trimmed, which `trimToBudget` already guarantees.
2. **The card usually binds before either.** `splitMotion` splits
   `actionDescription` on sentences, and most cards carry two or three. The
   ceiling only matters for a rich card on a long segment — which is exactly the
   case that is broken today, but it means the change will look like a no-op on
   most scenes.
3. **At 5s the rule is stricter than today's behaviour**, cutting two beats to
   one. That is the correct direction — a 5s clip carrying two independent
   movements is the overloading G2 describes — but it is a visible behaviour
   change on short segments and should be watched in the fixed-seed renders.

This applies to **LTX only**. Wan's published image-to-video formula is motion
plus camera and nothing more; nothing in G2 concerns Wan, and its fixed 1 + 1
stays.

### 2.2 Guidance parameters — the half of adherence StoryForge does not touch

G2 is explicit: *"A well-written prompt with suboptimal guidance parameters will
still produce poor adherence."* Documented values:

| Parameter | Effect | Typical | Documented example |
|---|---|---|---|
| `cfg_scale` | How strongly the model follows the prompt | 2.0–5.0 video | 3.0 video, **7.0 audio** |
| `stg_scale` | Spatio-temporal guidance — frame-to-frame consistency. The lever for identity drift | 0.5–1.5 | — |
| `rescale_scale` | Counteracts over-saturation at high CFG | — | 0.7 |

`buildSettingsManifest` in [lib/wangp/settings.ts](../lib/wangp/settings.ts)
never writes `guidance_scale` (the alias map in
[lib/wangp/mcp/aliases.ts](../lib/wangp/mcp/aliases.ts) knows the field exists
and maps `guidance_scale` ↔ `cfg_scale`, but nothing sets it). It is therefore
inherited from `schema.defaultSettings`, which this repo has already established
is **saved WanGP UI state, not a model property** — the same root cause as the
`batch_size: 2` bug, the `activated_loras` bug, the `prompt_enhancer` default
and the four-step denoising bug. Every one of those was a case of a value tuned
by someone else in another application travelling into every StoryForge job
unexamined.

So the identity-drift and camera-drift symptoms this document has been treating
as prompt problems may be partly a `stg_scale` / `cfg_scale` problem, and no
amount of prompt rewriting will close that half of the gap.

**The accelerator trap applies here too.** `resolveSteps` already knows that a
distilled or Lightning checkpoint is tuned as a set — low steps *and* CFG 1. G2
names the two LTX-2.3 paths explicitly: `ltx-2.3-22b-dev` (multi-stage sampling,
full multimodal guidance) versus `ltx-2.3-22b-distilled` (8 predefined sigmas,
fast iteration). Forcing `cfg_scale: 3.0` onto a distilled checkpoint would
reproduce the smeared-frame failure exactly. Any guidance resolver must reuse
`isAccelerated`-style detection and leave distilled models alone.

### Additional defects found while reading

1. **Duplicated continuity sentence, v2 LTX.** Visible in the preview above:
   `Same characters, wardrobe, and location as the start frame.` immediately
   followed by `Preserve subject identity, wardrobe, location, and lighting
   throughout.` The first comes from `spec.continuity` inside the renderer, the
   second is concatenated by `buildVideoPrompts`. `dedupeSentences` cannot catch
   it — different wording, same instruction — and a diffusion model weights the
   constraint twice.

2. **`Scene intent` and `Shot plan` are emitted twice when the canvas plans
   exist.** `buildMediaPromptSpec` puts `Scene intent: …` into `spec.continuity`
   and `slice.shotPlan` into `spec.composition`; `buildVideoPrompts` /
   `buildImagePrompts` then append `sceneDirectionSuffix(slice)`, which emits
   both again. `dedupeSentences` runs inside the renderer, *before* the suffixes
   are appended, so both survive. Not visible in `npm run prompts:preview`
   because that fixture passes `plans: undefined` — which is itself a problem:
   the artifact a reviewer reads before authorising the v2 rollout never
   exercises the planned path.

3. **Punctuation artifact in the shipping v1 path**: `Camera: slow push-in on
   the subject., evolving from…`. Known, and fixed by v2 — which is off.

4. **Two different speech-rate constants.** `dialogueWordBudget` uses
   2.5 words/second; the LTX directive tells the model `segmentSeconds * 2`
   words. The lint therefore warns at a threshold the model was never given.

5. **No LTX version discrimination.** `familyOf` folds `ltx_video` (0.9-era),
   `ltx2_22B` and any future 2.3 checkpoint into one `"ltx"`. The 2.3 guidance
   ("simplifying no longer helps; specificity wins") is the *opposite* of the
   advice for the older LTX line, and the word budget should differ. G2 adds a
   second axis the resolver will need: dev versus distilled, which changes the
   guidance parameters and not the prompt text.

6. **The LTX word budget exceeds the documented cap by 35% at maximum segment
   length.** 270 words against a documented 200 at a 20s segment. Because
   `trimToBudget` protects the framing prefix and every quoted sentence, a long
   dialogue scene can also exceed its own budget legitimately — the trim drops
   optional style clauses first and then stops. Worth knowing that the cap is
   soft by construction.

7. **`segmentSeconds` can be set to 20, which G2 puts at the edge of what one
   prompt can hold.** `MAX_SEGMENT_SECONDS = 20`. G2's advice for a
   multi-action sequence is to split it and regenerate segments rather than
   packing one prompt — which is what StoryForge's scene segmentation already
   is. This is a hint for the intake form's guidance text, not a code defect.

---

## 3. Recommendations, in priority order

Re-ranked after G2. If only three things are done, do **R0** (nothing reaches a
render otherwise), **R11** (a documented hard limit, one line of code) and
**R14** (the half of adherence that no prompt change can reach).

**R0 — Close the SPEC-003 rollout gate for LTX first.** Nothing else in this
document reaches a render while `MEDIA_PROMPT_COMPOSER_V2` is false: the family
renderers, the motion-first ordering, the word budgets and the lint are all
dead code in production. SPEC-003 §17 requires fixed-seed live renders per
family before the flag flips, and those were never run or authorised. Run the
LTX pair (v1 vs v2, same seed, same start frame, same scene) and flip the flag.
Every recommendation below assumes v2 is on; several are pointless otherwise.

**R1 — Stop appending vague style words to LTX video prompts.** `lookPromptSuffix`
puts `cinematic style, moody mood.` at the end of every clip prompt. The guide
names this pattern directly. The suffix exists for a real reason — grade drifts
across twenty segments without it — so the fix is not to delete it but to make
it family-aware: for `ltx` video prompts, translate style/tone into visible
properties (palette, contrast, grain, light quality) drawn from the
Cinematographer's plan, and drop the bare adjective form. Keep the current
behaviour for image prompts, where a style label is doing legitimate work.

**R2 — Always give LTX an audio line.** LTX writing the soundtrack from the same
text is the model's single largest advantage and the deterministic path
currently uses none of it. Derive ambience from the scene card (setting words in
`visualDescription`, time of day, location) rather than only from a World Bible
location match, and emit an explicit ambience clause plus Foley for the dominant
motion. Add volume and delivery cues to `dialogueClause` when the card carries
them.

**R3 — Add text/watermark/subtitle/logo terms to `videoNegativePrompt` for LTX.**
The positive directive already says avoid readable text; the negative prompt is
where that instruction is cheap and reliable, and LTX honours it.

**R4 — Delete the duplicated continuity sentence and the doubled
`Scene intent` / `Shot plan`.** Decide once where each fact lives: inside the
spec (rendered by the family renderer, deduped, budgeted) or in the appended
suffix — never both. The spec is the right home; `sceneDirectionSuffix` and the
`Preserve subject identity…` tail should be dropped from the v2 branch.

**R5 — Per-project aspect ratio, with the prompt told about it.** LTX 2.3
supports native 1080x1920 and the guide is explicit that vertical must be
composed for, not cropped into. Today the only lever is a global
`DEFAULT_RESOLUTION` env var. Add `project.aspect` (`landscape | portrait |
square`), feed it to `buildImageManifest`/`buildVideoManifest`, and have the
prompt agents state vertical composition when portrait is selected. This also
retires the dead `resolutionPreset` field.

**R6 — Give `imagePromptDirective` an `ltx` case.** LTX-2 renders stills as well
as clips (`mainOutput` reports `image` in still mode — see
[lib/wangp/model-router.ts](../lib/wangp/model-router.ts)), so a project pinned
to LTX for keyframes currently gets an empty image directive. It should ask for
texture and material at two scales and for spatial blocking (R7).

**R7 — Ask for spatial blocking.** Guide principle 2 is the one StoryForge does
not attempt at all. Add to `IMAGE_PROMPT_SYSTEM`: state left/right, foreground/
background, facing direction, and distance between subjects whenever more than
one person is in frame. This is cheap, it benefits every family, and for I2V it
is what binds the clip's verb to the right body.

**R8 — Version-aware LTX profile.** `ltxProfileOf(modelType, declared)` →
`"ltx1" | "ltx2"`, selecting budget and directive. `ltx2` gets the 2.3
"specificity wins" wording and the larger budget; `ltx1` keeps today's
conservative text. Fold `hasNativeAudio` into the same resolver.

**R9 — One speech-rate constant.** Export `WORDS_PER_SECOND` from
`media-prompt-spec.ts` and have `videoPromptDirective` use it, so the number the
model is given and the number the lint enforces cannot diverge.

**R10 — Extend the preview fixture.** `scripts/prompt-preview.ts` must pass a
populated `CreativePlans` and a wardrobe, or the rollout-gate artifact keeps
hiding the defects that only appear on the planned path.

### Added after reading G2

**R11 — Cap the LTX word budget at 200.** `wordBudget("ltx", "video", s)` becomes
`min(200, 90 + 9·s)`. This is the cheapest change in the document and it is a
documented limit, not a preference. Assert it in a test so the ceiling cannot
drift back up. State the same number in `videoPromptDirective` so the LLM path
aims at it too — today the directive says "four to eight sentences" and nothing
about words.

**R12 — Scale the motion budget with duration (decided, see §2.1).** Concretely:

- Add `SECONDS_PER_ACTION_BEAT = 3` to
  [lib/agents/media-prompt-spec.ts](../lib/agents/media-prompt-spec.ts) beside
  `WORDS_PER_SECOND`, and `additionalBeats: string[]` to `MediaPromptSpec`.
- `splitMotion(actionDescription, seconds)` keeps returning `dominant` and
  `secondary` — so Wan and the generic renderer are untouched **by
  construction**, which is what keeps the "no change to other families" scope
  rule honest — and additionally returns the remaining sentences, capped at
  `max(1, floor(seconds / SECONDS_PER_ACTION_BEAT)) - 2`, in card order.
- Only `renderVideoPrompt`'s `case "ltx"` reads `additionalBeats`, and it emits
  them after the secondary motion, before the camera clause.
- At 5s the ceiling is 1, so `secondary` is dropped for LTX. That is intentional
  and is the one place this change makes a prompt shorter.
- The word budget is applied after, not before: `trimToBudget` already drops
  from the end and protects quoted speech, so an over-long beat list degrades
  gracefully into a shorter one.

**R12a — Move the beat rule out of the shared system prompt.**
`videoPromptSystem` tells every model "give the clip one dominant action and at
most one secondary movement", and `videoPromptDirective("wan")` then says the
same thing again. Under the decision above that shared sentence becomes **wrong
for LTX** — the LLM path would stay capped at two beats while the deterministic
path scales, and the LTX directive would contradict the system prompt it is
concatenated onto. Delete the sentence from `videoPromptSystem`, keep it in the
Wan directive where it belongs, and state the duration-scaled ceiling in the LTX
directive in words the model can act on ("about one action per three seconds of
clip, in the order they happen").

**R13 — Order the LTX prompt chronologically, not by category.** G2 is explicit
that the model maps prompt order onto the temporal dimension. The renderer
should emit beats in the order they occur — action beat, the camera move that
accompanies it, the line spoken during it — rather than grouping all motion,
then all camera, then all speech. The scene card has no per-beat timing, so the
honest version of this is: keep the card's sentence order for the action beats,
place the camera clause immediately after the beat it belongs to when the card
associates them, and interleave dialogue at the beat it is attached to rather
than appending it last. Where the card gives no timing, dialogue stays where it
is. **This is the largest change in the document and the one most likely to
regress lip sync**, so it should land last and behind the flag.

**R14 — Manage the LTX guidance parameters instead of inheriting them.** Mirror
`resolveSteps` with a `resolveGuidance(schema, project, family)` in
[lib/wangp/steps.ts](../lib/wangp/steps.ts) or a sibling module:

- Discover first: `npm run wangp:schema ltx2_22B guidance|cfg|stg|rescale` to
  find which of the three WanGP actually declares. **Nothing should be written
  before that output is read** — this repo's whole history with
  `defaultSettings` says the field names will not be what you expect.
- Precedence: per-project override → leave alone if the checkpoint is
  distilled/accelerated → else the documented default (3.0 video / 7.0 audio
  cfg, 0.7 rescale, stg mid-range).
- Emit a `wangp.guidance.resolved` telemetry event with the reason, exactly as
  `wangp.steps.resolved` does.
- Surface a per-project override on the settings screen beside `videoSteps`,
  blank = auto.

**R15 — Use the camera LoRAs, and keep describing the move in text.** G2 lists
pre-trained LTX camera LoRAs — dolly in/out/left/right, jib up/down, static —
and says the LoRA supplies mechanical execution while the prompt supplies
semantic context, so both are needed. StoryForge already has a LoRA catalog, a
per-scene `sceneLoras` map and auto-assignment logic
([docs/auto-lora-scene-assignment.md](auto-lora-scene-assignment.md)).
`deriveCameraMotion` already normalises the card's camera note into a verb
phrase, which is most of the classifier needed to pick one. Map that phrase to
an installed LTX camera LoRA when the catalog has one, leave the text clause
exactly as it is, and skip silently when no matching LoRA is installed.

**R16 — Adopt G2's iteration workflow for the SPEC-011 rollout.** Distilled for
prompt iteration, dev for the final render, seed fixed throughout to isolate
prompt changes from sampling variance. StoryForge already pins per-scene seeds
(`project.sceneSeeds`) and per-project video models, so this is a documented
procedure rather than a feature. It is also exactly the fixed-seed comparison
SPEC-003's rollout gate has been waiting for, which makes R0 cheaper than it
looked.

---

## 4. Build spec — SPEC-011 LTX 2.3 prompt alignment

Split into `docs/build-specs/SPEC-011-ltx23-prompt-alignment.md` when work
starts; the content below is complete enough to implement from.

### Scope

In: the `ltx` branches of the prompt composer, directives, negative prompt and
budgets; the LTX guidance parameters in the settings manifest; camera-LoRA
selection; per-project aspect; the preview fixture. Out: any change to Wan,
Qwen, FLUX or Krea output; any change to the WanGP transport or the scene queue.

### Slices

| # | Slice | Files | Flag |
|---|---|---|---|
| 1 | LTX profile resolver `ltxProfileOf`, `hasNativeAudio` folded in | [lib/wangp/family.ts](../lib/wangp/family.ts), [lib/agents/model-directives.ts](../lib/agents/model-directives.ts) | none |
| 2 | Remove doubled continuity / intent / shot plan from the v2 deterministic path | [lib/agents/mock-agents.ts](../lib/agents/mock-agents.ts), [lib/agents/media-prompt-builder.ts](../lib/agents/media-prompt-builder.ts) | `MEDIA_PROMPT_COMPOSER_V2` |
| 3 | Family-aware look suffix (R1) | [lib/agents/look.ts](../lib/agents/look.ts), call sites in [prompt-agents.ts](../lib/agents/prompt-agents.ts), [mock-agents.ts](../lib/agents/mock-agents.ts) | `MEDIA_PROMPT_COMPOSER_V2` |
| 4 | Ambience + Foley + delivery/volume cues (R2) | [lib/agents/media-prompt-builder.ts](../lib/agents/media-prompt-builder.ts), [media-prompt-renderers.ts](../lib/agents/media-prompt-renderers.ts) | `MEDIA_PROMPT_COMPOSER_V2` |
| 5 | LTX negative terms (R3) | [lib/agents/mock-agents.ts](../lib/agents/mock-agents.ts), [negative-prompt.ts](../lib/agents/negative-prompt.ts) | none |
| 6 | LTX image directive + spatial blocking (R6, R7) | [lib/agents/model-directives.ts](../lib/agents/model-directives.ts), [prompt-agents.ts](../lib/agents/prompt-agents.ts) | none |
| 7 | `project.aspect` end to end (R5) | [lib/schemas/project.ts](../lib/schemas/project.ts), [lib/services/wangp-service.ts](../lib/services/wangp-service.ts), [components/settings/project-settings.tsx](../components/settings/project-settings.tsx) | none |
| 8 | Preview fixture with plans (R10), `WORDS_PER_SECOND` unification (R9) | [scripts/prompt-preview.ts](../scripts/prompt-preview.ts), [lib/agents/media-prompt-spec.ts](../lib/agents/media-prompt-spec.ts) | none |
| 9 | 200-word LTX cap (R11) + duration-scaled motion budget (R12) | [lib/agents/media-prompt-spec.ts](../lib/agents/media-prompt-spec.ts), [media-prompt-builder.ts](../lib/agents/media-prompt-builder.ts), [model-directives.ts](../lib/agents/model-directives.ts) | `MEDIA_PROMPT_COMPOSER_V2` |
| 10 | `resolveGuidance` — cfg/stg/rescale, accelerator-aware (R14) | [lib/wangp/steps.ts](../lib/wangp/steps.ts) or sibling, [settings.ts](../lib/wangp/settings.ts), [components/settings/project-settings.tsx](../components/settings/project-settings.tsx) | none |
| 11 | Camera-LoRA mapping (R15) | [lib/lora/](../lib/lora), [lib/agents/media-prompt-builder.ts](../lib/agents/media-prompt-builder.ts) | none |
| 12 | Chronological beat ordering (R13) | [lib/agents/media-prompt-spec.ts](../lib/agents/media-prompt-spec.ts), [media-prompt-renderers.ts](../lib/agents/media-prompt-renderers.ts) | `MEDIA_PROMPT_COMPOSER_V2` |

Slices 1–6 and 9 are prompt-text changes and are covered by the existing flag.
Slice 7 changes a stored schema and needs `sceneIdRemapper`-style attention only
if it were per-scene — it is per-project, so duplicate/import need no rekeying,
but `duplicateProject` must copy it. **Slice 10 is not a prompt change at all**
and is independently valuable: it can land, ship and be measured without
touching a single prompt string, which makes it the best first move after the
flag-independent slices. Slice 12 is the riskiest and goes last.

### Functional requirements

- **FR-1** An LTX video prompt contains no bare style adjective (`cinematic`,
  `epic`, `dynamic`, `moody`) that is not attached to a visible property.
- **FR-2** An LTX video prompt states ambience whenever the scene card supplies
  any setting signal, and never states it for a non-`ltx` family.
- **FR-3** No instruction appears twice in a rendered prompt in two different
  wordings. Asserted by a semantic-duplication check, not `dedupeSentences`.
- **FR-4** `videoNegativePrompt` for `ltx` includes text/watermark/subtitle/logo
  terms exactly once (`normaliseNegative` already guarantees the "once").
- **FR-5** Dialogue remains verbatim and is never trimmed by any change here.
  Existing `missingDialogue` lint must stay clean.
- **FR-6** An `ltx2` model gets the 2.3 profile; `ltx_video`/`ltxv` gets the
  conservative profile; the resolver is total (no `unknown` LTX).
- **FR-7** Selecting portrait produces a portrait `resolution` in the WanGP
  manifest **and** a composition instruction in the prompt.
- **FR-8** Every change is a no-op with `MEDIA_PROMPT_COMPOSER_V2=false` for
  slices 2–4, 9 and 12, so the flag remains a working rollback.
- **FR-9** No rendered LTX video prompt exceeds 200 words, at any segment length
  from 5s to 20s, with or without dialogue.
- **FR-10** An LTX video prompt states at most
  `max(1, floor(seconds / SECONDS_PER_ACTION_BEAT))` distinct action beats and at
  least one, in the order the card gives them. Where the word budget and the
  beat ceiling disagree, the word budget wins.
- **FR-10a** Wan, Qwen, FLUX and Krea output is byte-identical before and after
  the R12 change. Asserted directly, not by inspection.
- **FR-11** `resolveGuidance` never raises `cfg_scale` above 1 on a checkpoint
  detected as distilled or accelerated, and records its reason in telemetry.
- **FR-12** A camera LoRA is activated only when the catalog reports it
  installed for the resolved model, and the camera text clause is unchanged by
  its presence.

### Tests

- Extend [tests/prompt-best-practices.test.ts](../tests/prompt-best-practices.test.ts)
  with an LTX block asserting FR-1…FR-4, FR-9 and FR-10. FR-9 needs a sweep over
  5/10/15/20s with and without a long dialogue exchange, because the trim
  deliberately protects quoted sentences and the cap is therefore soft.
- New `tests/ltx-profile.test.ts` for FR-6, including `ltx2_22B`,
  `ltx_video`, and a metadata-declared `ltx2`.
- Extend [tests/steps.test.ts](../tests/steps.test.ts) or a sibling for FR-11,
  reusing its existing distilled-checkpoint fixture — the guidance trap is the
  same trap the steps tests were written for.
- FR-10a is the cheap insurance on R12: render one fixture through every family
  before and after and assert equality for the four that are out of scope.
- `splitMotion` is exercised by
  [tests/media-prompt-renderers.test.ts](../tests/media-prompt-renderers.test.ts)
  with a three-sentence fixture ("She seats the gear. The scarf whips left. A
  clock chimes."), which currently asserts the third sentence is **dropped**.
  Under R12 that is only true below 9s, so the existing case needs a duration
  and a sibling case at 15s where the third beat survives.
- Whole suite must pass in **both** flag states — the SPEC-003 rollback proof.
- Note the trap recorded for SPEC-003: `tests/character-cast.test.ts` and
  `tests/creative-context.test.ts` pin exact negative-prompt strings, so slice 5
  will break them.

### Rollout

0. **Discovery, before any code:** `npm run wangp:schema ltx2_22B` and grep it
   for guidance, cfg, stg and rescale fields. Slice 10's design depends on what
   comes back, and the repo's history says the answer will not be the obvious
   one.
1. Land slices 1, 5, 6, 8 (flag-independent, low risk), then slice 10 (also
   flag-independent, and measurable on its own).
2. Run `npm run prompts:preview` with the enriched fixture and read the LTX diff.
3. Fixed-seed live renders, following G2's workflow — iterate on the **distilled**
   checkpoint, confirm on **dev**, seed pinned throughout. One scene, same start
   frame, five clips: v1, v2, v2+R1/R2, v2+R11/R12, v2+all. Compare motion
   adherence, audio presence and identity drift.
4. Flip `MEDIA_PROMPT_COMPOSER_V2` only after step 3 is reviewed.
5. Slice 12 (chronological ordering) is a separate round of step 3, judged on
   lip sync specifically.

### Risks

- **Removing `Preserve subject identity, wardrobe, location, and lighting
  throughout.` may increase identity drift**, even though it duplicates the
  spec continuity clause. Verify on the fixed-seed pair before deleting; keep
  whichever wording performs better and delete the other, not both.
- **Ambience text competes with dialogue for the audio budget.** Order matters:
  dialogue is authoritative and must stay ahead of ambience in the trim order
  (`trimToBudget` already protects quoted sentences).
- **Portrait changes the aspect the keyframes were rendered at.** A project that
  switches aspect mid-run will produce mismatched frames; gate the control or
  warn.
- **Raising `cfg_scale` raises saturation.** G2 says this is what
  `rescale_scale` is for, so the two must move together or the fix for
  adherence becomes a colour regression across the whole cut.
- **Chronological reordering can separate a spoken line from its speaker
  attribution** if the interleaving is done naively. `missingDialogue` checks
  the line survived, not that it stayed attributed — extend it or the
  regression is invisible.

---

## 5. What I would not change

- **Omitting the subject from the video prompt.** The guide's
  subject → action → camera → mood order is written for T2V. StoryForge is
  image-to-video with a start frame that already fixes the subject, and the repo
  has already paid for re-describing it (motion budget spent on appearance,
  subject rendered twice). Keep motion-first.
- **`Over N seconds,` leading the clip prompt.** It is not in the guide and
  duration is set numerically by `video_length`, but the repo's tests encode it
  deliberately as a pacing constraint for every family. Changing it is an
  evidence question for a live A/B, not a guide-compliance question.
- **The existing LTX directive text in `videoPromptDirective`.** It already
  matches the guide closely — one paragraph, present tense, 4–8 sentences,
  behaviour over emotion labels, no readable text, quoted dialogue with delivery
  named. It needs the audio and specificity additions from R2/R8 and the word
  cap from R11, not a rewrite.
- **Forcing `prompt_enhancer` off.** G2 recommends bypassing the enhancer
  whenever you want creative control, which is always true here: the enhancer
  would discard prompts four agents just spent tokens writing. StoryForge
  already does this and should keep doing it. Worth recording *why* in the
  comment, since the code currently justifies it only from first principles.
- **The frame-count maths.** `frameCountForFps` already satisfies G2's
  `(F-1) % 8 == 0` constraint at every fps and duration. No change; assert it if
  it is not already asserted.
