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
inconsistent. This is the ceiling on output quality — **§5 now provides sourced replacement prompts
for all four canvas agents.**

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

**§5 now contains drop-in replacement prompts for the four canvas agents**, each grounded in a cited
source. The remaining agents, in brief:

**Story Architect** — should name a beat structure appropriate to the duration: a three-act shape
for longer pieces, a hook/turn/payoff for short-form, with an explicit midpoint or turn for anything
above ~6 segments. The current instruction is purely arithmetic. A story beat is defined in
screenwriting practice as *"a structural element of a narrative that's used to mark an intentional
shift in tone"* — the agent is currently asked for beats without being told that a beat must
*change* something.

**Image Prompt Agent** — restore the composition clause, and go further: require an explicit shot
size and camera height per frame, and state that the *first clause of the prompt sets the framing*.
Diffusion models weight early tokens heavily, and the observed close-up failure is consistent with
framing being buried mid-prompt.

**A shared vocabulary directive** would avoid repetition. `castSystemDirective` and
`precedenceDirective` already establish the pattern of composable directives appended to several
agents; a `craftDirective(kind)` alongside them fits the existing architecture.

### 4.3 Fix what the canvas agents can see — **shipped**

Ordered by value:

1. ~~**Pass the selected variant** to all four.~~ **Done.** Each agent now receives the direction's
   substance — name, hook, angle, visual style and risks — rather than nothing.
2. ~~**Persist the story plan.**~~ **Done.** `projectRecordSchema.storyPlan` holds it. Running the
   **Director** generates one when the project has none, since its prompt is the one that names the
   story arc; `generateStoryboard` then reuses it via `OrchestratorDeps.storyPlan` rather than
   paying twice, and persists a fresh one through `onStoryPlan`.
3. ~~**Pass the cast** to the Art Director.~~ **Done**, and to the World Builder and Director too.
4. ~~**Chain the canvas agents.**~~ **Done.** `canvasContext()` hands each agent the plans already
   approved, so the Cinematographer lights the Director's intent instead of inventing a second mood.

### 4.4 Make the ordering safe — **already built (correction)**

This section originally claimed the ordering rule was "documentation" only. That was wrong, and the
result of not reading `components/storyboard/creative-plans-panel.tsx` before writing it.

`planStates()` already derives staleness from the history — comparing each plan's
`*_plan.generated` entry against the last `storyboard.generated` — and the panel renders an amber
banner reading *"N plans changed after this storyboard was written"* with a **Regenerate storyboard
to apply** button. It also handles the inverse case, telling a user with no storyboard yet to run
the plans first.

That is a better implementation than the warning proposed here. Nothing to do.

The one idea in the original list still unbuilt is **regenerate prompts only** — re-running the two
prompt agents against existing scene cards, so a late plan applies without rewriting the story.
Worth considering only if regenerating whole storyboards proves annoying in practice.

### 4.5 Give the Variant Explorer something to vary

Explain `VARIANT_TYPES` in the prompt and require the three directions to differ on a *named axis* —
tone, structure, or point of view — rather than being three descriptions of one idea. Requiring each
variant to state what it sacrifices would make the `risks` field earn its place.

### 4.6 Watch `agent.fallback`

A deterministic fallback produces a schema-valid storyboard that looks finished. The event exists;
surfacing it in the UI when a storyboard was built from one would stop a mechanical plan being
mistaken for a considered one.

---

## 5. Sourced craft practice and drop-in prompts

Each subsection states the practice, cites where it comes from, says why it matters *for this
system specifically*, and gives a complete replacement prompt. The spec's own dropped sentence is
retained as the opening of each, so §4.1 and §5 can ship together.

**Sources**

- StudioBinder, *Guide to Camera Shots: Every Shot Size Explained* — shot-size taxonomy and the
  role of contrast
- StudioBinder, *Types of Camera Movements in Film* — movement vocabulary and motivation
- Wikipedia, *Three-point lighting* — key / fill / backlight and the four-point extension
- StudioBinder, *What is a Color Script* — colour as a narrative instrument
- StudioBinder, *What is Production Design in Film* — design as narrative information
- StudioBinder, *What Does a Director Do* — the director's role across departments
- StudioBinder, *What is a Story Beat in a Screenplay* — a beat as a deliberate shift in tone
- Wikipedia, *Bible (screenwriting)* and *Continuity (fiction)* — the bible as continuity record

### 5.1 Cinematographer

**Practice.** Shot size is a named, standardised vocabulary — EWS, WS, FS, MWS, cowboy, MS, MCU,
CU, ECU — abbreviated on every shot list and storyboard in the industry. Crucially, meaning comes
from *contrast*: StudioBinder puts it directly — *"If you don't use all of the different types of
camera shots in film, how can you signal anything to your viewer without shot size contrast?"* Shot
size also drives lens choice, camera placement and staging, not just framing.

Camera movement is expected to be **motivated**, never decorative: pans are *"often motivated by a
character's actions"*, and of handheld work — *"the random movement should always serve the story"*.
Each move has a conventional meaning: push-in for intimacy or a decision forming; pull-out for
isolation or reveal; arc for unease; boom for scale; roll/Dutch for disorientation; zoom is
described as *"artificial or even unnatural"* because it has no equivalent in human vision.

Lighting has a standard three-point grammar: the key, whose *"strength, color and angle… determines
the shot's overall lighting design"*; the fill, *"usually softer and less bright than the key, up to
half the amount"*, whose absence produces deliberate chiaroscuro or low-key; and the backlight,
which *"separates the subject from the background and highlights contours"*.

**Why it matters here.** This is the agent whose output most directly shapes a render, and its
`sceneShotPlans` feed each scene's prompt. A plan that says "cinematic and moody" gives the Image
Prompt Agent nothing to convert into framing — which is consistent with the observed failure where
a scene specified as an extreme close-up rendered as a three-quarter shot.

> You are the Cinematographer Agent. Define the visual camera language for the project. Specify
> shot types, lens/framing rules, camera movements, lighting approach, and transition language.
>
> Use the standard shot-size vocabulary and name exactly one per scene: extreme wide (EWS), wide
> (WS), full (FS), medium wide (MWS), cowboy, medium (MS), medium close-up (MCU), close-up (CU),
> extreme close-up (ECU). Vary sizes deliberately across the storyboard — contrast between shot
> sizes is what signals which moments matter, and a run of identical framings has no emphasis.
> Establish a new location on a wider size before moving in.
>
> Give lens choices in millimetres with the reason: wide lenses (18–35mm) exaggerate depth and
> proximity; long lenses (85mm+) compress and isolate. State camera height per scene — eye level,
> low, high or overhead.
>
> Every camera move must be motivated by story, and you must state the motivation. Use the standard
> vocabulary and respect its meaning: static (lets performance carry; best for dialogue), push-in
> (rising intimacy, or a decision forming), pull-out (isolation, or revealing context), pan and tilt
> (following action, or revealing scale), tracking (travelling with a subject), arc (unease or
> heightened energy), boom or crane (scale, establishing), handheld (raw and immediate), roll or
> Dutch (disorientation), zoom (deliberately artificial — it has no equivalent in human vision).
> Where a scene needs no movement, say static and say why.
>
> Lighting rules must state key direction, key-to-fill ratio, hard or soft quality, colour
> temperature, and whether sources are practical (visible in frame) or motivated (implied by the
> world). Name low-key explicitly when you want deep shadow and high contrast, and specify the
> backlight or rim separately — it is what separates a subject from the background.

### 5.2 Art Director

**Practice.** Production design *"serves to provide the narrative with visual information that is
as important as dialogue or characterization."* Costume tells the audience *"where they come from,
their social status, their personality, and their profession"*, and props reveal character through
use: *"the placement of the prop and how the actor interacts with it can say a lot about a
character… and even reveal their backstory or motivations."* Sets must *"establish the location and
the era."*

Colour is handled as a **colour script** — *"a visual roadmap of a film's story, told through the
strategic use of colour"*, used for *"conveying emotional arc, establishing narrative rhythm,
visualizing scene transitions."* Pioneered by Pixar on *A Bug's Life* (1998). Temperature carries
meaning: *"cool colors like blue can create a sense of calm or sadness, while warm colors like red
can convey anger or love."*

**Why it matters here.** `artDirectionPlan` is the one plan that reaches renders *globally* —
`globalStyleSuffix()` appends its production design and first wardrobe, prop and set-dressing rule
to every prompt. Vague adjectives here are multiplied across every frame in the project. A colour
script is also the natural fit for a storyboard already divided into ordered segments.

> You are the Art Director Agent. Define production design, wardrobe, props, set dressing, texture,
> colour, typography, and brand/product placement rules.
>
> Production design carries narrative information as directly as dialogue does. Every choice should
> say something about who these people are and where they are. Anchor the world first: state the
> period, the geography and the economic register, because those three decide most of the rest.
>
> Give the project a colour script rather than a palette. Name the relationship (complementary,
> analogous, split-complementary, triadic, or monochrome with one accent), give the dominant and
> accent hues, and say how colour shifts across the storyboard as the emotional arc moves. Cool hues
> read as calm, distance or sadness; warm hues as intimacy, appetite or anger. State colour
> temperature explicitly so the palette and the lighting plan do not fight each other.
>
> Wardrobe must convey social status, profession and self-image through specific named garments,
> fabrics and colours — never a generic register such as "casual clothing". Choose props for what
> they reveal: name the object and what it says about its owner. Set dressing should show evidence
> of use — what is worn, repaired, cherished or neglected. Name surfaces and materials; texture
> carries as much as colour.

### 5.3 World Builder

**Practice.** A bible is a *"reference document used by screenwriters for information on characters,
settings, and other elements"*, kept as a live continuity record — the *Frasier* bible was
*"scrupulously maintained"*, with anything established on screen written back into it so it could
*"serve as a resource for writers to keep everything within the series consistent."*

Continuity matters most because film is shot out of order: *"scenes are rarely shot in the order in
which they appear in the final film"*, which is why a script supervisor keeps photographs and notes
*"so that all related shots can match, even though filming has been split up over months on
different sets and locations."* The failure modes are catalogued — visual errors where *"items of
clothing change colors, shadows get longer or shorter, items within a scene change place or
disappear"* — and they matter because they *"affect the audience's suspension of disbelief."*

**Why it matters here.** This is the closest real-world analogue to what StoryForgeAI actually does.
Every scene is generated independently, out of order, by a model with no memory of the last one —
the extreme case of the problem a script supervisor exists to solve. The bible should therefore be
weighted towards *checkable physical facts*, not lore. There is also a hard system constraint:
`forbiddenContradictions` are fed into negative prompts by `continuityNegativeSuffix()`, so their
wording must suit that use.

> You are the World Builder Agent. Create a World Bible for the selected creative direction. Define
> the universe, story rules, recurring locations, character relationships, motifs, visual anchors,
> and contradictions to avoid.
>
> A bible is a continuity reference, not an essay. Every entry must be a fact a later agent can
> check a scene against — prefer short, checkable statements to description.
>
> Scenes are generated independently and out of order, exactly as a film is shot out of sequence, so
> this document does the job a script supervisor does on set: it is the record that makes unrelated
> shots match. Weight it towards what would visibly differ between two separately generated images —
> recurring locations and their fixed features, time of day and weather, what each character
> habitually wears and carries, and the physical details that must not drift.
>
> Visual anchors must be concrete and repeatable: a specific object, colour, texture or light source
> that can recur across scenes and bind them together.
>
> Forbidden contradictions are used directly as negative prompts. Write each as a short noun phrase
> naming what must never appear, not as a sentence about what should be true.

### 5.4 Director

**Practice.** The director *"manages the creative aspects of the production… by visualizing the
script while guiding the actors and technical crew"*, and owns tone across departments: *"a film's
tone should be thoroughly considered and discussed before the first shot is taken. The film director
has the final say."*

A story beat is *"a structural element of a narrative that's used to mark an intentional shift in
tone"* — writers use beats *"to structure their narratives and control emotional arcs."* In the Save
the Cat model each beat *"is meant to move the story forward in a new and meaningful way."*

**Why it matters here.** `sceneIntent` is the Director's only output that reaches a render, arriving
as `Scene intent: …` in that scene's prompts. If the intent restates the visual description, it adds
tokens and no information. And because this system renders images rather than directing actors,
performance notes are only useful if they are *visible*.

> You are the Director Agent. Convert the selected concept and story arc into a directorial plan.
> Define creative thesis, pacing, emotional arc, performance guidance, and scene-level intent.
>
> The creative thesis is the argument the piece makes — one sentence, specific enough that someone
> could disagree with it. Everything else serves it.
>
> A beat marks a deliberate shift in tone, not a description of events. Each scene's intent must
> therefore state what *changes*: who wants what, what is in the way, and what is different by the
> end. "She plays pool in a bar" is not an intent; "she is being watched and pretends not to notice"
> is. Never restate the scene's visual description as its intent.
>
> The emotional arc must move. Name the value at each step (for example curiosity → confidence →
> exposure → resolve) and identify the turn, the point where the piece changes direction. Do not
> repeat the same emotional register in consecutive scenes.
>
> Performance direction must be physical and playable: posture, gesture, eyeline, tempo, and where
> the character's attention is. This system renders images, so direction that cannot be seen cannot
> be executed — "conflicted" is not directable; "holds eye contact a beat too long, then looks away
> first" is.

### 5.5 What these prompts assume — **resolved**

When written, all four prompts depended on input fixes that had not been made. Those are now in
place (§4.3), so the prompts run on real material:

- **5.1 and 5.4 write per-scene maps** against the persisted story plan's beats, and are told to key
  them by segment number so `sceneEntry()` resolves them.
- **5.2's colour script** has its own `colorScript` field. It is deliberately **not** added to
  `globalStyleSuffix`: the prompt agents read it when writing a scene, which is better than
  appending a paragraph of colour theory to every render job. `productionDesign` is now capped at
  two sentences in that suffix — it was previously the only entry there with no bound.
- **5.3's "selected creative direction"** is now supplied.

Shipped and verified live: the Cinematographer returns *"WS, 35mm (exaggerates depth to establish
bar scale), eye level, static to emphasize the quiet stillness of the room"* where it previously
returned mood adjectives.

---

## 6. Where the instructions came from

| Origin | Agents | Quality |
|---|---|---|
| **`video-storyboard-spec.md` §9.x, verbatim** | Intake, Visual Bible, Storyboard, Variant Explorer | Adequate. Field checklists. |
| **Spec, abbreviated in implementation** | World Builder, Director, Cinematographer, Art Director, Image Prompt, Video Prompt, Story Architect | **Below spec.** See §4.1. |
| **Debugged against observed production failures** | Image Prompt (wardrobe), Story Architect (segment length), Storyboard (timing, face visibility), QC (vision) | **Best in the system.** |
| **Deliberate, reasoned departure from spec** | Audio Director | Correct — spec was wrong for this architecture. |
| **External craft references** | *none yet* — proposed in §5 | **The gap.** |

No prompt in the system currently cites cinematography, screenwriting or production-design
practice. Every instruction is either a schema field list or a patch for a specific past failure.
That is a defensible way to have got here — the failures were real and the fixes work — but it means
the system's creative ceiling is the base model's unprompted instincts.

The agents that were burned are good. The agents that were not are placeholders. §5 is the first
material in this system sourced from outside it.

---

## 7. Suggested sequence

§4.1, §4.2/§5 and §4.3 are **shipped**. §4.4 turned out to be **already built**. What remains:

1. **§4.5** — give the Variant Explorer a named axis to vary on.
2. **§4.6** — surface `agent.fallback` in the UI, so a mechanical storyboard is not mistaken for a
   considered one.
3. The Story Architect and Intake agents (§3.1, §3.2) are still field checklists. The Story
   Architect is the higher value of the two: it decides the beats everything downstream works from,
   and currently has only an arithmetic constraint.

A note on measuring this: the prompt-agent output is stored, so the effect of §5 is directly
inspectable. Generate a storyboard before and after on the same concept and seed, and compare the
stored `startFramePrompt` values — the sourced prompts should produce an explicit shot size and
camera height where the current ones produce mood adjectives.

Structured output is now reliable (see the format-ladder fix of 2026-07-30), so richer prompts and
larger schemas are a safer bet than they were when this system was first assembled. That was the
main technical reason to keep instructions thin, and it no longer applies.
