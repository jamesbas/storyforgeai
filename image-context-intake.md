# Concept images at intake — build spec

**Status:** proposed
**Estimate:** ~1 day, phased so each phase ships something usable
**Author's summary:** a project is described by typing. Let it also be described by
showing. One vision pass converts the images into a structured written artefact,
and every existing agent reads that text — no agent gains a vision dependency.

---

## 1. Why this is cheap

The vision transport is already built and proven by the QC agent.

| Piece | Exists | Where |
|---|---|---|
| `images` on the provider call | ✅ | `GenerateOptions` in [lib/agents/llm/provider.ts](lib/agents/llm/provider.ts) |
| Data-URL encoding, MIME allowlist, size cap | ✅ | `loadQcImages` in [lib/agents/qc-agent.ts](lib/agents/qc-agent.ts) |
| Vision-model config | ✅ | `OPENAI_VISION_MODEL` in [lib/config.ts](lib/config.ts) |
| Image upload, validation, safe filenames, serving | ✅ | character reference images |
| Per-project file storage that deletion already purges | ✅ | [lib/db/file-repository.ts](lib/db/file-repository.ts) |

Nothing in that list needs inventing. What is missing is storage keyed to a
project, one new agent, and the wiring.

---

## 2. The decision that matters

**Do not pass images to every agent. Read them once.**

A "Concept Reader" runs before the Intake Producer, looks at the images alongside
the typed concept, and writes a structured description. That description is
persisted on the project record and threaded into the agents as ordinary text.

Three reasons, in order of how badly the alternative fails:

1. **Sending images changes which model answers.** The provider picks
   `config.openai.visionModel` whenever images are present. An agent that attaches
   images is no longer being answered by the model pinned for planning. Confining
   vision to one call confines that substitution to one call.
2. **Planning calls are serialised** (`enqueuePlanning`), so every vision call is
   additive latency on a local server. A storyboard already issues `4 + 2N` calls;
   attaching two images to each would be the dominant cost of a run.
3. **Images are expensive in tokens.** QC's own comment records that a full frame
   "can cost more prompt budget than the whole scene card". The concept is worth
   reading once, not eighteen times.

It also matches how the pipeline already works: the Intake Producer distils the
concept into a brief, and everything downstream reads the brief rather than
re-deriving it.

---

## 3. Scope

### Images are optional, and the typed concept leads

### Two kinds of image, and only one of them informs anything

Testing against real output changed this design. Pointed at frames the pipeline
had itself produced, the reader wrote back `mood: "Intimate"` for a concept that
asks for something considerably stronger, and `wardrobe: "short black silk robe
or dress"` for a robe the concept says barely covers anything.

Both were accurate. That is the problem. A render records what the pipeline
settled for, not what was asked for, so feeding a description of one into the
Visual Bible starts the next generation from the last one's retreat — each step
small, defensible and invisible, and the drift always in the direction of less.

So provenance is recorded at upload and decides what an image may do:

| Kind | Meaning | Read by | Reaches a prompt |
|---|---|---|---|
| `reference` | From outside the project; a look to aim at | Concept Reader | Yes, via `conceptVisuals` |
| `render` | A frame this pipeline produced | Render Auditor | **No** |

Nothing in the pixels tells the two apart, so the kind is never inferred, and a
bare filename left over from before this split is read as a `render` — the
conservative direction, since the cost of that being wrong is a missing detail
rather than a corrupted look.

`renderAuditSchema` has no `palette`, `wardrobe`, `mood`, `lighting`, `setting`
or `subjects`. Not because a directive forbids passing them, but because they do
not exist to be passed.

### Images are optional, and the typed concept leads

The written concept is the project. Images are an addition for the things a
sentence carries badly — a palette, a particular room, a particular jacket — and
a project with none behaves exactly as it does today: no extra call, no extra
artefact, nothing on the record.

That is enforced rather than implied:

- `conceptImages`, `conceptVisuals` and `renderAudit` are all optional and
  absent by default.
- Both agents are **only** reachable on demand, and each refuses a project with
  no images of its kind rather than writing a "visual reference" derived from no
  visuals, or an empty audit that reads like a pass.
- Where a reference contradicts the typed concept, the reader records the
  disagreement instead of resolving it, and phase 5's directive makes the typed
  concept authoritative: a photograph is evidence, not instruction.

### In

- Upload, store, view and delete concept images on a project, by kind.
- One vision pass per kind, producing a structured, persisted artefact.
- The **reference** artefact threaded into Intake, Visual Bible, World Builder,
  Art Director and the Storyboard Artist.
- The **render** artefact shown on the settings screen and nowhere else.
- Honest degradation when no vision model is configured.

### Out — deliberately

- **Concept images as WanGP render references.** Sending them as `image_refs` to
  condition keyframes is a different feature with a different failure mode (see
  the likeness-bleed problem the character library already has). Worth doing;
  not here.
- **Per-scene concept images.** The unit is the project.
- **Deriving characters from photographs.** The character library owns identity,
  and a face arriving through two routes is how likenesses start competing.

---

## 4. Data

### Project record

```ts
// lib/schemas/project.ts
/** Images under the project's concept-images folder, with their provenance. */
conceptImages: z.array(conceptImageSchema).max(6).optional(),
```

Optional, so every existing project parses unchanged.

### The artefact

```ts
// lib/schemas/agents.ts
export const conceptVisualsSchema = z.object({
  projectId: z.string(),
  /** What the images show, as a shot description would put it. */
  setting: z.string(),
  subjects: z.array(z.string()),
  palette: z.array(z.string()),
  lighting: z.string(),
  wardrobe: z.array(z.string()),
  mood: z.string(),
  notableDetails: z.array(z.string()).default([]),
  /**
   * Where the images and the typed concept disagree. Surfaced rather than
   * resolved: a picture of a night interior against a concept that says "sunlit
   * morning" is a decision for the user, and a model that quietly picks one
   * produces a project nobody asked for.
   */
  contradictions: z.array(z.string()).default([]),
});
```

`.default([])` on the soft fields, for the reason `continuityNotes` has it: a
detail must never be able to reject the whole artefact.

Persisted as `record.conceptVisuals`, alongside `storyPlan` — read once, reused,
regenerable on demand.

### On disk

`projects/<projectId>/concept-images/<slot>.<ext>`

Slot-based filenames, extension derived from the **MIME type** and never from the
client-supplied name, exactly as `setReferenceImage` does. Inside the project
folder so `deleteProject`'s existing purge removes them with no new code.

---

## 5. Phases

### Phase 1 — storage and upload (~2h)

- `lib/services/concept-image-service.ts`: `addConceptImage(projectId, file)`,
  `removeConceptImage(projectId, filename)`, `conceptImagePath(projectId, name)`.
  Copy the four validations from `setReferenceImage`: MIME allowlist,
  8 MB cap, zero-byte rejection, count ceiling (6).
- `POST` / `DELETE /api/projects/[projectId]/concept-images`.
- `GET /api/projects/[projectId]/concept-images/[filename]` to serve them back,
  content type from the extension, path resolution rejecting anything that
  escapes the project folder.
- UI: an upload strip on the project Settings screen with thumbnails and a remove
  button.

Shippable on its own: the images are stored and visible, doing nothing yet.

### Phase 2 — the shared data-URL helper (~30m)

Move `loadQcImages` to `lib/media/data-url.ts` as `loadImagesAsDataUrls`, with a
neutral telemetry event (`image.skipped` with a `purpose` field). Update the QC
call site. No behaviour change; the point is that two callers should not each own
a base64 encoder.

### Phase 3 — the Concept Reader agent (~3h)

`lib/agents/concept-reader.ts`, following the shape every other agent has:

- `CONCEPT_READER_VISUAL_SYSTEM` and `CONCEPT_READER_TEXT_SYSTEM`. **Two prompts,
  chosen by whether images actually made it** — the discipline QC established.
  A prompt that says "the attached images show…" when nothing was attached
  produces invented observations.
- `conceptReaderAgent(project, images, provider)` returning `ConceptVisuals | null`.
- `buildConceptVisuals(project)` deterministic fallback, so the parity rule holds
  and the pipeline runs with no provider at all.

Guard before calling, as QC does:

```ts
const images = visionAvailable() ? await loadImagesAsDataUrls(paths, "concept") : [];
```

### Phase 4 — close the silent-drop hole (~30m)

In [lib/agents/llm/provider.ts](lib/agents/llm/provider.ts), when
`images.length > 0 && !config.openai.visionModel`:

```ts
logEvent("agent.llm.images_dropped", { provider: label, images: images.length });
```

and export `visionAvailable()` so callers have one place to ask. Without this the
whole feature is a no-op that looks like it worked when `OPENAI_VISION_MODEL` is
blank — which it is by default in `.env.example`.

### Phase 5 — threading (~2h)

- Orchestrator: run the Concept Reader before the Intake Producer when the
  project has images and `record.conceptVisuals` is absent or stale; report it
  through an `onConceptVisuals` callback, matching `onStoryPlan`.
- Add `conceptVisuals` to the user payload of Intake, Visual Bible, World Builder,
  Art Director and the Storyboard Artist.
- Add one line to each of those system prompts: the visual reference describes
  what the piece should look like, and where it contradicts the typed concept the
  **typed concept wins** — the user typed it deliberately, and a photograph is
  evidence rather than instruction.

Not the per-scene prompt agents. They receive it through the Visual Bible and the
Art Direction plan, which is the existing budgeting rule.

### Phase 6 — surfacing (~1h)

- Show `contradictions` on the Agentic Canvas as a warning band. This is the
  feature's most useful output and the easiest to bury.
- Add the Concept Reader to the canvas roster so it can be re-run after changing
  the images.
- Upload control on the new-project form: create the project, upload, then
  navigate — the id has to exist before a file can be keyed to it.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| **Blank `OPENAI_VISION_MODEL` makes it a silent no-op.** Blank is the default. | Phase 4 telemetry, a `TEXT_SYSTEM` variant that admits it cannot see, and a note in the UI when images are stored but no vision model is configured. |
| **Vision model ≠ planning model.** The storyboard's author changes silently. | Confined to one call by design. Worth stating in Help: set `OPENAI_VISION_MODEL` to the same model when it is vision-capable. |
| **Images contradict the text and the model picks one.** | `contradictions[]` surfaces the disagreement; the directive makes the typed concept authoritative. |
| **Prompt budget.** A local model's context is finite and images are tokens. | One call, cap of 6 images, 8 MB each, and `scripts/llm-context-check.ts` already exists to measure it. |
| **Vision quality on a 26B local model.** Descriptions may be generic. | Ship Phase 1–4 and read the artefact before wiring Phase 5. If the output is vague, the feature is not worth threading. |

---

## 7. Tests

- `addConceptImage` rejects a non-image MIME, an oversized file, an empty file,
  and the seventh image.
- The stored extension comes from the MIME type, not the filename — a
  `payload.png.exe` upload lands as `.png` or is refused.
- Path resolution refuses a filename escaping the project folder.
- `deleteProject` removes the concept-images folder.
- `conceptReaderAgent` returns the deterministic build when no provider exists.
- With a provider and no vision model, the **text** system prompt is used and no
  images are sent.
- With both, images are passed as data URLs and the visual prompt is used.
- `contradictions` survives a round trip and reaches the canvas.
- Duplicating and importing a project carry `conceptImages` correctly — note the
  files live under the old project id and must be **copied**, not referenced.

That last one is the trap: `sceneIdRemapper` handles scene-keyed maps, and this is
a project-keyed folder. `duplicateProject` and `importProject` both need to copy
the files or clear the field, and doing neither leaves a project pointing at
another project's images.

---

## 8. Recommendation

Build phases 1–4, upload two or three images to a real project, and **read the
generated artefact before writing any of phase 5**. The whole value rests on
whether a 26B local vision model produces a description specific enough to be
worth threading. If it comes back with "a warm, moody interior", the honest answer
is to stop — the typed concept already said that, and the feature would be adding
tokens without adding information.
