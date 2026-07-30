# StoryForgeAI agents — what they know, where it came from, and what to fix

**Status:** review. No code changed.
**Date:** 2026-07-30
**Scope:** every agent that produces content which reaches a render, plus the flow that carries it
there. Assessment covers the *instructions* (system prompts), the *inputs* they receive, and the
*craft knowledge* encoded in each.

---

## 1. Executive summary

Three findings, in order of importance.

**1. Four of the five Agentic Canvas agents ship with less instruction than the project's own spec
defines.** `video-storyboard-spec.md` §9.10–9.13 gives each a sentence listing what to define. That
sentence was dropped in implementation. The World Builder prompt is now two sentences, one of which
is "Return only valid JSON". This is a regression against an existing written standard, not a design
gap — and it is free to fix (§4.1).

**2. No agent encodes craft vocabulary.** Every prompt is a *checklist of nouns* — "define
characters, locations, props, colour palette". None names a shot size, a lens length, a lighting
setup, a story structure, or a colour-theory relationship. The agents' expertise is therefore
entirely whatever the base model brings unprompted, which on a local 26B model is shallow and
inconsistent. This is the ceiling on output quality (§4.2).

**3. The canvas agents are asked to plan scenes they have never seen.** All four receive only
`{ project }` — no brief, no story beats, no cast, not even the selected creative variant. Yet the
Director must emit `sceneIntent` keyed by scene, and the Cinematographer `sceneShotPlans`. They are
writing per-scene direction blind (§4.3).

Against that: the prompts that have been **debugged against real failures** are genuinely good, and
measurably better than the spec they came from. The Image Prompt Agent's wardrobe rules, the Story
Architect's segment-length interpolation and the Audio Director's rejection of speech synthesis are
all hard-won and correct. The pattern is clear — **instructions improve where they have been
burned, and stagnate where they have not.**

---

## 2. What actually creates content

Two pipelines. Only the first reaches a render on its own.

### 2.1 The storyboard pipeline (`runStoryboardOrchestrator`)

Runs on **Generate storyboard**. Sequential, and every step feeds the next.

```
Project
  └─ Intake Agent            → CreativeBrief
       └─ Story Architect    → StoryPlan (logline, emotional progression, per-segment beats)
            └─ Visual Bible  → VisualBible (characters, locations, palette, negative rules)
                 └─ Storyboard Agent → SceneDraft[]  (one card per segment)
                      └─ Image Prompt Agent  → startFramePrompt, endFramePrompt, imageNegative
                      └─ Video Prompt Agent  → videoPromptSegment, videoNegative, checklist
                           └─ StoryboardSnapshot (persisted)
```

The last two run **per scene**, so a 15-scene storyboard is 4 + 30 LLM calls, serialized by
`enqueuePlanning`.

Everything downstream of this reads the *stored prompts*. No agent runs during image or video
generation.

### 2.2 The Agentic Canvas (on demand, optional)

Five independent endpoints. Each writes one plan onto the project record.

| Agent | Produces | Read by |
|---|---|---|
| Variant Explorer | 3 `CreativeVariant`s | `generateStoryboard` via `selectedVariantId` |
| World Builder | `WorldBible` | Visual Bible, Storyboard, prompt agents |
| Director | `DirectorialPlan` | as above |
| Cinematographer | `CinematographyPlan` | as above |
| Art Director | `ArtDirectionPlan` | as above |

**The ordering trap:** `generateStoryboard()` reads these at generation time and bakes them into
scene prompts. A plan created *after* the storyboard was written reaches nothing. The Storyboard
screen states this, which is good, but nothing enforces it.

### 2.3 Content-producing agents that do **not** reach a render

- **Audio Director** — plans music and SFX beds. Assembled, never prompted into image or video.
- **QC Agent** — grades finished scenes. Off by default (`project.qcEnabled`).
- **Deepy** — on-demand inspection of one media file.

### 2.4 Deterministic builders behind every agent

Each agent has a `build*()` fallback in `mock-agents.ts` / `mock-canvas.ts`, used when no provider
is configured or the LLM output fails validation. These are *structurally* valid but creatively
mechanical. `agent.fallback` telemetry fires when one is used for the storyboard — worth watching,
because a fallback storyboard looks finished and is not.

---

## 3. Agent-by-agent assessment

Verdict scale: **A** = craft knowledge encoded and debugged · **B** = correct but generic ·
**C** = schema restatement, no domain content.

### 3.1 Intake Agent — **B**

```
You are the Intake Agent for a video storyboard production system. Convert the user's rough
concept into a structured creative brief. Preserve the user's intent. Fill reasonable defaults
when information is missing. Do not generate scene prompts yet. Return only valid JSON matching
the CreativeBrief schema.
```

**Source:** spec §9.1, **verbatim**. **Input:** `{ project }`.

"Preserve the user's intent" and "fill reasonable defaults" are the two rules that matter for an
intake step, and both are present. Nothing here is wrong. Equally, nothing here is expert — it
does not ask *what is this film actually about*, name an audience-first or premise-first framing, or
require the brief to be falsifiable.

### 3.2 Story Architect — **A−**

```
You are the Story Architect Agent. Create a complete narrative plan sized to the requested
duration. The video will be generated in {segmentSeconds}-second segments. Create a story arc
that can be divided cleanly into the required number of segments. Return JSON with title,
logline, emotional progression, and per-segment story beat summaries.
```

**Source:** spec §9.2, with the segment length **interpolated rather than hard-coded** — a real
improvement, documented in the code: telling the model "20-second segments" for an 8-second project
produces beats with far too much action for the clip that renders. `creativeModeDirective(project)`
is appended, so `creativeMode` reaches planning.

**Weakness:** the spec asked for *synopsis* and *narrative arc*; both were dropped. More
importantly, **no story structure is named.** The agent is told to produce an arc that divides
evenly — a *mathematical* constraint — with nothing about what makes an arc. A 15-segment piece has
no act breaks, no midpoint, no escalation rule. That is why beats tend to read as a list of
tableaux rather than a story.

### 3.3 Visual Bible — **B+**

```
You are the Visual Bible Agent. Create a continuity guide that keeps all generated images and
videos visually consistent. Define characters, locations, props, color palette, lighting, camera
style, and negative rules. Return only valid JSON matching the VisualBible schema.
```

**Source:** spec §9.3, **verbatim**, plus two genuine additions: `castSystemDirective(cast)` and
`precedenceDirective(cast, plans)`. `withPinnedCast()` then *forces* the pinned library description
back in afterwards, so a model that paraphrased a character cannot break identity. That
belt-and-braces treatment is the right instinct.

**Weakness:** "color palette" and "lighting" are asked for as nouns. No colour relationship
(complementary, analogous, monochrome), no lighting vocabulary (key/fill ratio, practical,
motivated, hard vs soft). The model fills these with whatever it associates with the concept.

### 3.4 Storyboard Agent — **A**

Spec §9.4 verbatim, plus three earned additions: segment-length scoping, `subjectFaceVisible`
guidance (added 2026-07-30), and `creativeModeDirective` + `castSystemDirective` +
`precedenceDirective`. Output passes through `withDerivedTiming()`, which overwrites the timing and
identity fields — because a model under structured output fills every field it is shown, including
ones it has no business setting.

This is the most defensively engineered agent in the system, and it earned that the hard way.

### 3.5 Image Prompt Agent — **A** for continuity, **C** for composition

The shipped prompt adds a large, specific block absent from the spec:

> The start and end frame are the same moment seconds apart: every character must wear identical
> clothing in both … never a vague placeholder such as 'casual attire' … Do not restate the
> project's style or tone; both are appended to every prompt automatically.

Every clause traces to an observed defect — mismatched trousers between frames, doubled style terms
weighting the render. Excellent.

**But it dropped the spec's craft clause.** Spec §9.5 required:

> Each image prompt must describe a single still frame with **composition, subject, setting,
> lighting, style, and camera framing**.

That is gone. The agent is now expert at *continuity* and silent on *composition* — which is a
plausible contributor to the framing failures observed in testing, where an "extreme close-up of
eyes" rendered as a three-quarter shot.

### 3.6 Video Prompt Agent — **B−**

```
You are the Video Prompt Agent. For each scene, create a WanGP-ready prompt for a
{segmentSeconds}-second video segment focused on motion, camera movement, action, and scene
evolution. Describe only as much action as fits the segment length. Include a negative prompt and
generation notes. Return only valid JSON.
```

Duration scoping is a good addition. **Two valuable spec clauses were dropped**, and both matter for
image-to-video:

> …and **what must remain consistent from the start frame**. **Do not waste tokens re-describing
> details already present in the start image unless they are continuity constraints.**

The second is a real i2v efficiency rule: the model already has the start frame as `image_start`, so
re-describing the subject burns prompt budget that motion description needs. Its absence is visible
in production — video prompts currently repeat the full character description, which in one measured
case was over half the prompt.

### 3.7 Variant Explorer — **C**

Spec §9.9 verbatim. A list of fields to fill. `VARIANT_TYPES` exists in the schema but is never
explained to the model, so the three "distinct" directions tend to be tonal variations of one idea
rather than genuinely different strategies.

### 3.8 World Builder / Director / Cinematographer / Art Director — **C**

The four core canvas agents, in full:

```
You are the World Builder Agent. Create a World Bible for the selected creative direction.
Return only valid JSON matching the WorldBible schema.

You are the Director Agent. Convert the selected concept and story arc into a directorial plan.
Return only valid JSON matching the DirectorialPlan schema.

You are the Cinematographer Agent. Define the visual camera language for the project.
Return only valid JSON matching the CinematographyPlan schema.

You are the Art Director Agent. Define production design, wardrobe, props, set dressing,
typography, and product placement rules. Return only valid JSON matching the ArtDirectionPlan
schema.
```

**Three separate problems.**

**(a) They are below spec.** Each spec version carries a middle sentence that was dropped:

| Agent | Dropped from spec |
|---|---|
| World Builder | "Define the universe, story rules, recurring locations, character relationships, motifs, visual anchors, and contradictions to avoid." |
| Director | "Define creative thesis, pacing, emotional arc, performance guidance, and scene-level intent." |
| Cinematographer | "Specify shot types, lens/framing rules, camera movements, lighting approach, and transition language." |
| Art Director | "texture, color" and "brand/" (partial drop) |

**(b) They see almost nothing.** All four are called as
`generateJson(SYSTEM, JSON.stringify({ project }), schema)`. No brief. No story plan. No cast. **Not
even the selected variant** — despite the World Builder prompt beginning "for the selected creative
direction", which it is never given. The Director's prompt says "convert the selected concept **and
story arc**"; there is no story arc in its input.

**(c) They plan scenes that do not exist.** `directorialPlanSchema.sceneIntent` and
`cinematographyPlanSchema.sceneShotPlans` are `Record<string, string>` keyed by scene. The canvas
runs *before* the storyboard, and the story plan is never persisted — so at canvas time there are no
scenes and no beats. The best either agent can do is key by segment number and guess what happens
there. `sceneEntry()` in `creative-context.ts` gamely accepts `"3"`, `"scene 3"`, `"Scene 3"` and the
scene id, which is sound defensive coding around a structurally impossible request.

What partially rescues these agents is `withSchemaHint()`, which appends the schema's key names and
types to every system prompt. The model therefore learns *what fields exist* even when the prompt
does not say. That is why the output is coherent at all — but a field list is not direction.

### 3.9 Audio Director — **A**

The one prompt that **deliberately and correctly departs from the spec.** Spec §9.14 asks for
narration, dialogue and lip-sync planning. The shipped version says:

> Dialogue and narration are performed by the video model from each scene's prompt, so do not plan
> speech synthesis.

That is architecturally right for this build — LTX-2 renders speech from the scene prompt — and
following the spec here would have produced a plan nothing could execute. Good judgement, and worth
citing as the model for how the other prompts should be revised.

### 3.10 QC Agent — **A** (rewritten 2026-07-30)

Now two prompts chosen by whether `OPENAI_VISION_MODEL` is configured: a visual grading prompt when
keyframes are attached, and an explicitly limited text-only prompt when they are not. The previous
single prompt told the model to spot visual artifacts while handing it file paths, and models
responded by inventing verdicts about renders they had never seen.

### 3.11 Not implemented

- **WanGP Settings Agent** (spec §9.7) — implemented as deterministic code
  (`buildSettingsManifest`, `resolveSteps`, `resolveResolution`) rather than an agent. **Correct
  call.** Settings are a schema-constrained mapping problem; an LLM adds latency and failure modes
  for no gain.
- **Platform Repurposing Agent** (spec §9.15) — absent entirely.

---

## 4. Recommendations

### 4.1 Restore the dropped spec clauses *(free, do first)*

Four one-line prompt edits bring the canvas agents back to their own written standard, and one each
restores the Image and Video Prompt agents' lost craft clauses. No schema change, no new inputs, no
risk. This is the highest value-per-effort item in the document.

Highest priority of the six: the Video Prompt Agent's *"do not re-describe details already present
in the start image"*. It reduces prompt bloat on every video job in the system.

### 4.2 Give the agents real craft vocabulary

The single largest quality lever. Each agent should name the concepts a practitioner would use, so
the model has something specific to reason with instead of a noun list.

**Cinematographer** — currently "define the visual camera language". Should specify:

> Work in standard shot sizes (extreme wide, wide, medium, medium close-up, close-up, extreme
> close-up) and state one per scene. Give lens choices in millimetres with the reason (wide for
> distortion and immersion, long for compression and isolation). Movement must be motivated by
> story, not decoration — name the motivation. Lighting rules should state key direction, key-to-fill
> ratio, quality (hard/soft) and colour temperature, and whether sources are practical or motivated.

**Director** — should name a structure and require intent per scene to be an *objective plus
obstacle*, not a description. Emotional arc should move, with a stated turn.

**Art Director** — should ask for a colour script with a named relationship (complementary,
analogous, split-complementary, monochrome with accent), texture language, and a period/geography
anchor. Currently asks for "production design" and gets adjectives.

**Story Architect** — should name a beat structure appropriate to the duration: a three-act shape
for longer pieces, a hook/turn/payoff for short-form, with an explicit midpoint or turn for anything
above ~6 segments. The current instruction is purely arithmetic.

**Image Prompt Agent** — restore the composition clause, and go further: require an explicit shot
size and camera height per frame, and state that the *first clause of the prompt sets the framing*.
Diffusion models weight early tokens heavily, and the observed close-up failure is consistent with
framing being buried mid-prompt.

**A shared vocabulary directive** would avoid repetition. `castSystemDirective` and
`precedenceDirective` already establish the pattern of composable directives appended to several
agents; a `craftDirective(kind)` alongside them fits the existing architecture.

### 4.3 Fix what the canvas agents can see

Ordered by value:

1. **Pass the selected variant** to all four. The World Builder prompt already claims to have it.
   One-line change per agent.
2. **Persist the story plan.** It is generated inside `runStoryboardOrchestrator` and thrown away.
   Storing it on the record would let the Director and Cinematographer write per-scene direction
   against real beats instead of guessing, and would let a user inspect the arc.
3. **Pass the cast** to the Art Director. It writes wardrobe rules that can contradict a pinned
   character, and `precedenceDirective` then has to resolve a conflict that need not have existed.
4. **Chain the canvas agents.** The Cinematographer should see the Director's plan; the Art Director
   should see both. Currently three of them independently invent a mood from the same one-line
   concept, and the storyboard has to reconcile them.

### 4.4 Make the ordering safe

Canvas plans only reach a render if they existed when the storyboard was written. Today that is
documentation. Options, cheapest first:

- Warn on **Generate storyboard** when a plan is newer than the existing storyboard.
- Record which plans were present at generation time, and show it on the Storyboard screen — the
  "in this storyboard" badges already imply this and would become factual rather than advisory.
- Offer **regenerate prompts only**, re-running the two prompt agents against the existing scene
  cards, so a late plan can be applied without rewriting the story.

### 4.5 Give the Variant Explorer something to vary

Explain `VARIANT_TYPES` in the prompt and require the three directions to differ on a *named axis* —
tone, structure, or point of view — rather than being three descriptions of one idea. Requiring each
variant to state what it sacrifices would make the `risks` field earn its place.

### 4.6 Watch `agent.fallback`

A deterministic fallback produces a schema-valid storyboard that looks finished. The event exists;
surfacing it in the UI when a storyboard was built from one would stop a mechanical plan being
mistaken for a considered one.

---

## 5. Where the instructions came from

| Origin | Agents | Quality |
|---|---|---|
| **`video-storyboard-spec.md` §9.x, verbatim** | Intake, Visual Bible, Storyboard, Variant Explorer | Adequate. Field checklists. |
| **Spec, abbreviated in implementation** | World Builder, Director, Cinematographer, Art Director, Image Prompt, Video Prompt, Story Architect | **Below spec.** See §4.1. |
| **Debugged against observed production failures** | Image Prompt (wardrobe), Story Architect (segment length), Storyboard (timing, face visibility), QC (vision) | **Best in the system.** |
| **Deliberate, reasoned departure from spec** | Audio Director | Correct — spec was wrong for this architecture. |
| **External craft references** | *none* | **The gap.** |

No prompt in the system cites cinematography, screenwriting or production-design practice. Every
instruction is either a schema field list or a patch for a specific past failure. That is a
defensible way to have got here — the failures were real and the fixes work — but it means the
system's creative ceiling is the base model's unprompted instincts.

The agents that were burned are good. The agents that were not are placeholders.

---

## 6. Suggested sequence

1. **§4.1** — restore the dropped clauses. An hour, no risk, immediate effect on every project.
2. **§4.3.1–2** — pass the selected variant; persist the story plan. Unblocks everything else.
3. **§4.2** — craft vocabulary, one agent at a time, starting with the Cinematographer and Image
   Prompt agents since they most directly shape what is rendered.
4. **§4.4** — ordering safety, once plans are worth protecting.
5. **§4.5, §4.6** — polish.

Structured output is now reliable (see the format-ladder fix of 2026-07-30), so richer prompts and
larger schemas are a safer bet than they were when this system was first assembled. That was the
main technical reason to keep instructions thin, and it no longer applies.
