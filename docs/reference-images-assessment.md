# Reference images — how they actually work, and what they could do

**Date:** 2026-08-26
**Scope:** project-level *reference* images (the `Reference images — optional`
field on the New Project form and the Concept images panel in Settings). Not
character reference photographs, which are a separate mechanism.

---

## Summary

Your reading is close to right, and the part you have wrong is in your favour:
the images are not *only* a comparison tool. They are read once into a written
description that four agents genuinely consult.

But the substance of your concern holds. **Reference images influence how the
film looks, not what happens in it.** They reach no agent that decides story,
and they cannot exist before a concept does — so they can neither create nor
seed the idea. The comparison behaviour you noticed is real, and it *subtracts*:
where an image disagrees with your typed concept, the disagreeing detail is
deleted rather than debated.

---

## 1. How a reference image actually influences the project

### The path

```
upload  →  Concept Reader (one vision call)  →  conceptVisuals (text)  →  4 agents
```

A reference image is never seen by a planning agent. It is converted once into a
structured written artefact, and everything downstream reads that text. This is
deliberate and well-reasoned — attaching images to a call switches the provider
to `OPENAI_VISION_MODEL`, so confining vision to one call confines that
substitution to one call. See [concept-reader.ts](../lib/agents/concept-reader.ts).

### What the reading contains

`conceptVisualsSchema` in [agents.ts](../lib/schemas/agents.ts):

| Field | Content |
|---|---|
| `setting` | The place, written as a shot description would put it |
| `subjects` | Who is in the frame |
| `palette` | Colours |
| `lighting` | How the place is lit |
| `wardrobe` | What people are wearing |
| `mood` | Atmosphere |
| `notableDetails` | Distinguishing details |
| `contradictions` | Where the image disagrees with the typed concept |
| `sources` | Which files the reading came from |
| `fromImages` | False when no vision model was available |

Every one of these is a **look** field. There is no field for event, action,
conflict, causality or character motivation. The Concept Reader is explicitly
forbidden from inventing them — its system prompt says *"Do not invent a story,
do not guess at what happens next."*

**This is the crux.** The artefact is incapable of carrying story information,
so no amount of downstream wiring could make an image influence the plot.

### Which agents receive it

Confirmed by tracing `conceptVisualsPayload` / `conceptVisualsDirective`:

| Agent | Receives reference reading? | What it decides |
|---|---|---|
| Intake Agent → creative brief | **Yes** — [intake-agent.ts](../lib/agents/intake-agent.ts) | Logline, synopsis, narrative arc, visual style |
| World Builder | **Yes** — [canvas-agents.ts](../lib/agents/canvas-agents.ts) | World bible |
| Art Director | **Yes** — [canvas-agents.ts](../lib/agents/canvas-agents.ts) | Art direction plan |
| Visual Bible | **Yes** — [visual-bible-agent.ts](../lib/agents/visual-bible-agent.ts) | Locked visual description |
| **Concept Explorer (variants)** | **No** | **The story directions you choose between** |
| **Story Architect** | **No** | **Logline, beats, emotional progression** |
| Director | No | Shot intent |
| Cinematographer | No | Camera plan |
| Scene prompt agents | No (indirectly, via Visual Bible) | Per-shot prompts |

The Story Architect's payload is literally `{ project: ctx.project, brief: ctx.brief }`
— [story-architect-agent.ts](../lib/agents/story-architect-agent.ts). It never sees
`conceptVisuals`.

### How strong is the influence, where it exists?

Weak, by design. The directive attached to those four agents says:

> Treat it as the creator pointing at something and saying "like this" — use it
> for **texture, palette, materials and light where the concept is silent**. It
> does not outrank the concept, the brief or anything pinned.

So the reading only fills silence. It cannot override anything you typed.

### The comparison behaviour you spotted

This is `contradictions`, and it is stronger than annotation. From
[concept-visuals.ts](../lib/agents/concept-visuals.ts):

> A payload carrying `wardrobe: ["black silk robe"]` alongside a note saying the
> concept disagrees hands the model both and asks it to arbitrate… So a field
> named in a contradiction is **dropped wholesale**.

Upload a night-time storm photograph against a concept that says "sunlit
morning", and `lighting` is deleted from the payload entirely. The image
contributed nothing on that axis, and — this matters — **nothing on screen tells
you that happened** unless you open the Agentic Canvas, which surfaces
`conceptVisuals.contradictions`.

The reasoning behind the rule is sound: a model that quietly picks one produces
a project nobody asked for. But the *effect* is that the more your image differs
from your words, the less it does — which is the opposite of what someone
uploading an inspiring picture expects.

### When the reading runs

`withConceptVisuals` in [project-service.ts](../lib/services/project-service.ts)
re-reads automatically whenever the set of reference files differs from
`conceptVisuals.sources`. It is wired into:

- `generateStoryboard`
- `generateWorldBible`
- `generateDirectorialPlan`
- `generateCinematographyPlan`
- `generateArtDirectionPlan`

Notably **not** `generateVariants`. Currency is decided by filenames rather than
timestamps, which is a genuinely good design — adding or removing an image
invalidates the reading exactly when it should, with no clocks involved.

> **Documentation defect.** [architecture.md](architecture.md) names this
> function `resolveConceptVisuals`. No such symbol exists. The behaviour is
> real; only the name is wrong.

---

## 2. Can reference images build the project concept on their own?

**No, and the ordering makes it structurally impossible.**

Three independent blocks:

**The concept is mandatory.** `conceptField` in [intake.ts](../lib/schemas/intake.ts)
is `z.string().min(1, "concept is required")`. A project cannot be created
without typed text.

**Images arrive after the project exists.** From
[new-project-form.tsx](../components/intake/new-project-form.tsx):

> `references` are uploaded after the project exists — the upload route is keyed
> to a project id.

The picker on the New Project form holds files in browser state and uploads them
once the project has been created. So the concept must already be written before
the image can be stored.

**"Expand with AI" is blind to images.** `enhanceConceptSchema` accepts
`concept`, `requestedDurationSeconds`, `style`, `tone`, `audience`,
`creativeMode`. There is no image field, and
[concept-enhancer.ts](../lib/agents/concept-enhancer.ts) never loads one. The one
feature in the app whose explicit job is *developing your idea into a fuller
one* cannot see the pictures of the idea.

The result is a chicken-and-egg: **you must describe the thing before you can
show the app the picture of it, and the picture then only adjusts the palette.**

---

## 3. Recommendations

Ranked by value for effort. The first two together would deliver the intent you
described.

### R1 — Let "Expand with AI" see the images *(high value, moderate effort)*

This is the single change that most directly serves "reference images help
create a project concept". The enhancer already calls a provider; the vision
transport already exists (`loadImagesAsDataUrls`, `visionAvailable()`).

The obstacle is ordering: enhancement runs before a project id exists, and
storage is keyed to project id. Two ways through:

- **(a)** Post the selected files with the enhance request and encode them
  in-memory for that one call. No new storage, nothing to clean up. The files
  are already in browser state.
- **(b)** A staging area keyed to a draft id, promoted on creation. More moving
  parts, and orphan cleanup becomes a problem.

**(a) is clearly better** — it matches the existing "read once, don't persist the
pixels" philosophy and adds no lifecycle.

Worth noting this changes the enhancer's character: it would become the place
where an image genuinely shapes the *story*, because the enhancer writes prose
about events, not a look record. That is exactly what you asked for.

### R2 — A "draft a concept from these images" action *(high value, moderate effort)*

The strongest form of your intent, and a natural extension of R1. Upload
pictures, get a written concept back in the box, edit it freely, then create.

This inverts today's dependency without breaking the rule that the typed concept
leads — because the output lands in the concept field as editable text, and
everything downstream still reads only what you approved. The Concept Reader's
prompt would need a sibling that is *allowed* to propose a premise, kept separate
from the strictly-observational reader so the existing discipline is not
weakened.

### R3 — Give the Concept Explorer the reference reading *(moderate value, low effort)*

The variants agent proposes the story directions you pick between, and it is the
most conspicuous gap: it neither receives `conceptVisuals` nor triggers a read.
A storm-lashed lighthouse ought to be able to suggest directions.

Low effort — add `conceptVisualsPayload` / `conceptVisualsDirective` to
`conceptExplorerAgent` and wrap `generateVariants` in `withConceptVisuals`,
exactly as the other four already are.

### R4 — Tell the user what the images did *(moderate value, low effort)*

Three things are currently invisible:

1. Whether a reading has happened at all.
2. Which fields were **withheld** as contested — the case where an image is
   doing nothing and the user is most likely to believe it is doing something.
3. Whether the reading is `fromImages: false`, meaning no vision model was
   available and the "reference reading" was inferred from the text alone.

The data is all on the record. A line on the New Project / Settings panel saying
*"read from 3 images; lighting and wardrobe withheld — they disagree with your
concept"* would have answered this question without needing to read the source.

### R5 — Reconsider whether contested fields must be dropped wholesale *(low value, needs judgement)*

The current rule is defensible and I would not change it casually. But
"contradiction" currently covers both *"the image says night, you said morning"*
(a real conflict) and *"the image shows a detail your concept never mentioned"*
(not a conflict at all, if the reader is over-eager about what counts). If the
latter is being miscategorised in practice, images are silently losing influence
they should keep.

Worth measuring before changing: log how often each field is withheld across
real projects. If `notableDetails` or `palette` are frequently contested, the
classification is too aggressive.

### R6 — Fix the architecture doc *(trivial)*

`resolveConceptVisuals` → `withConceptVisuals` in
[architecture.md](architecture.md).

---

## What I would do first

R1 and R4 together, in that order. R1 delivers the capability you actually
wanted; R4 makes the whole mechanism legible, which is what turned this into a
question in the first place. R3 is cheap enough to fold in alongside.

R2 is the more ambitious version and worth doing once R1 proves the transport
works end to end from the New Project form.
