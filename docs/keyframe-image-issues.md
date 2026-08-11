# Keyframe image issues

A record of a long investigation into keyframe rendering in StoryForgeAI: what was
wrong, what was ruled out along the way, and what is left.

Written for an agent picking this up cold. Everything stated as a finding here was
measured against real output, not inferred from the code. Where something is a
hypothesis it says so.

## Status: the main fault is found and fixed

**The cause was the shape of the prompt, not the images, the model or the
continuity logic.** The appended character sheet carried every character's full
stored description and stated their outfit afterwards as a detached sentence. On
a three-person shot that was two thirds of the prompt, one character described at
four times the length of the person the shot was about. The model drew that
character twice, omitted another, and put the missing man's clothes on someone
meant to be naked.

Fixed in **v1.53**. Jump to **§2d** for the resolution and **§8** for what is
left to do.

**Sections 2, 2a, 2b and 2c are kept deliberately, in order, including the parts
that turned out to be wrong.** Eight versions were shipped against this symptom
and several were real defects that were not the cause. The sequence of wrong
turns is more instructive than the answer, and §9 says why.

---

## 1. The system in one paragraph

A project has a **cast**: named characters from a library, each with a written
description, an optional wardrobe, and zero or more reference photographs. Agents
write a **storyboard** of scenes; each scene gets a **start frame prompt** and an
**end frame prompt**. To those prompts the app appends a **character sheet** —
each named character's description followed by `Wearing exactly: <outfit>` — and a
**wardrobe continuity clause** for unnamed people. Frames are rendered through
WanGP. Under `reuse_end_frame` a scene's start frame *is* the previous scene's end
frame file, and the end frame is rendered with that file supplied as a reference.
Afterwards a **face swap** pass runs per character to correct likenesses.

The project this was debugged against: 18 scenes, `keyframes_only`,
`reuse_end_frame`, three people on screen — the wife and the husband (both in the library,
with photographs) and an unnamed third man described only in prose.

---

## 2. The first hypothesis — later disproved

> **Superseded.** Kept because the reasoning looks sound and was not. See §2a for
> the correction and §2d for what the cause actually was.

**Attribute binding fails when a frame carries more than one reference
photograph.**

The render job is a prompt plus a flat list of image files. **Nothing in the job
says which picture is which person.** The prompt names three people and states
three different outfits; the images arrive unlabelled. The model assigns them
however it likes.

### The measurement

`image_refs` on a keyframe job is `[inherited start frame?, ...character
portraits]`. The inherited frame is present only when the scene carried its start
frame over from the previous scene, and it leads the list, flagged by
`imageRefsLeadWithScene`. Counting *everything* in that list against the output:

| Frame | Inherited frame | Portraits | Total refs | Result |
| --- | --- | --- | --- | --- |
| s16 start — the husband alone (seam broke) | no | 1 | **1** | **Correct.** Right man, right polo, right chair. |
| s3 start — three people (seam broke, Krea) | no | 2 | **2** | **Correct.** All three, right clothes. |
| s12 end — the wife + unnamed man | yes | 1 | **2** | **Correct.** Both right, both nude as specified. |
| s14 end — the wife + unnamed man | yes | 1 | **2** | **Correct.** Both right. |
| s13 end — the husband + the wife + unnamed man | yes | 2 | **3** | **Catastrophic.** See below. |

The s13 end frame asked for: the unnamed man **fully nude** having sex with
the wife, and the husband watching from a corner chair in a white polo and blue jeans.

What rendered:

- The man in the bed is **light-skinned, wearing the husband's white polo and blue
  jeans** — during intercourse.
- The person in the corner chair is **a second woman resembling the wife**, not
  the husband.
- The unnamed black man is **absent entirely**.

Every attribute crossed over. This single frame is the whole bug.

### The rule that emerged

**Two reference images bind; three scramble.** The threshold is the size of the
whole list, not the portrait count — an unlabelled third image is where the model
stops being able to say which is which. This holds across both models tested,
including the one seam-broken frame that carried two portraits and no inherited
frame and came back correct.

People described only in words render *well*, including wardrobe and skin tone.
It is the images that compete.

7 of 36 frames in this project carried two portraits: `s2 end`, `s3 start`,
`s3 end`, `s6 start`, `s6 end`, `s13 end`, `s18 end`. Those with an inherited
frame as well reached three, and failed.

### What was done about it (v1.50)

`photographedSubject()` in [lib/services/media-service.ts](../lib/services/media-service.ts)
now keeps only the **first-named** character's photograph and drops the rest,
logging `wangp.reference_images.trimmed` with `reason: "one_subject_per_frame"`.
That holds the total at two — inherited frame plus one portrait — in every case.
The dropped characters fall back to their written description plus the face-swap
pass.

**This is a mitigation, not a solution.** It trades a scrambled frame for a
weaker likeness on everyone after the first, and it caps the list rather than
fixing why the list is ambiguous. It has not yet been validated on a live run.

### The other lever

`sceneEndFrameRefs[sceneId] = false` (per scene, exposed in the storyboard UI as
the end-frame reference toggle) stops the inherited frame being passed at all,
taking the list back down to portraits only. `config.media.endFrameReferencesStartFrame`
does the same globally. That is the setting to reach for if a model is
reproducing the previous frame instead of following the prompt — at the cost of
the visual continuity the reference was there to provide.

---

## 2a. The correction to §2 — it was never mainly about the images

v1.50 shipped, `s13 end` was rendered again, and it was **still wrong**. That
render is the most informative artefact produced so far, and it overturns part of
the reasoning above.

`s13 end` asked for three people: the unnamed man **fully nude** with the wife, and
the husband watching from a corner chair in a white polo and blue jeans. Under v1.50
exactly one portrait was sent — the wife's, as the first-named. What came back:

- The unnamed man is **correctly black**, correctly built — his *identity* came
  through from prose alone with no photograph at all.
- He is wearing **the husband's white polo and blue jeans**.
- The corner chair holds a **second wife**, in a polo and dark trousers.
- **the husband is not in the picture.**

Two things follow, and they matter more than the reference-count rule:

**1. Prose identity works; capping the portraits did not help.** A man with no
photograph rendered correctly. Dropping the husband's portrait did not fix the frame —
arguably it made the "no the husband" symptom worse, because it removed the only thing
that made him a distinct body, leaving `Wearing exactly: blue jeans and a white
polo shirt` as an **unbound attribute** free to attach to anyone.

**2. The real mechanism is that the end frame cannot add a person.** The end
frame is rendered with its own start frame supplied as a reference plus
`MATCH_INSTRUCTION.inherited` — *"the named characters' wardrobe, hair and styling
are exactly as in the supplied reference frame."* `s13 start` holds **two**
people; `s13 end` states **three**. Asked to paint a third person into a picture
that does not contain them, the model does not. It duplicates somebody already in
shot and hands the missing person's stated outfit to whoever is nearest.

This is **exactly the 1.48 failure, one join earlier**: 1.48 fixed the seam
*between* scenes; this is the seam *within* a scene, start frame to end frame.

The control that proves it: `s3 start` states three people and rendered all three
correctly — with two portraits, which the §2 rule said should fail. The
difference is that `s3 start` had **no conditioning frame** (its seam had broken,
so it rendered fresh). Given a free hand, the model composes three people from
prose without trouble. Given a picture of two and told to match it, it cannot.

**So §2's "two bind, three scramble" rule is a coincidence of this dataset.** The
predictor is not how many images the job carries. It is *whether the frame is
conditioned on a picture whose population contradicts its prompt.*

### Scenes affected in this project

| Scene | Start → end population |
| --- | --- |
| s2 | 1 → 2 |
| s10 | 1 → 2 |
| s12 | 1 → 2 |
| s13 | 2 → 3 |
| s15 | 2 → 3 |
| s17 | 1 → 2 |
| s18 | 2 → 3 |

`s13` and `s18` are the two frames reported as broken over and over.

### What was done about it (v1.51)

`conditionEndOnStart()` in [lib/services/media-service.ts](../lib/services/media-service.ts):
where no clip will carry an arrival, an end frame that states **more** people than
its start frame is no longer conditioned on that start frame. It renders from its
own description instead, the way `s3 start` did. Logged as
`scene.continuity` with `seamBreak: "end_frame_gains_people"`.

The cost is the same trade 1.48 made: those end frames lose pixel continuity with
their own start frames. On a keyframes-only project there is no clip spanning the
join anyway.

**Not yet validated on a live run.**

### What is still unexplained

Even with the conditioning removed, nothing binds `Wearing exactly: <outfit>` to a
*body*. The cast sheet is a list of names and attributes appended after the scene
description; the model has no spatial anchor for any of it. v1.51 removes the
contradicting picture, but on a free render with three people and three stated
outfits the attributes can still cross. **This is the problem worth solving
properly**, and §3 is the most promising route to it.

A second observation worth chasing: the unnamed man's `Wardrobe continuity — the
muscular Black man: nude` clause is the very **last** text in the prompt, the
position normally described as strongest, and he still rendered in a polo. So
"last is strongest" is not reliable when the attribute has no anchor. Position is
not the lever; binding is.

---

## 2b. v1.51 did not fix it either — and the prompt itself is now the suspect

`s13 end` was regenerated alone under v1.51, with the start-frame conditioning
removed. It came back **still wrong**: the wife nude and correct on the bed, the
unnamed man correctly **black** but wearing **the husband's white polo and blue jeans**,
and a **second wife** sitting in the chair where the husband should be.

So a completely free render — no conditioning frame, one portrait — still
scrambles. That eliminates the conditioning image as the explanation for this
frame and moves the suspicion onto the prompt.

### The prompt, measured

The full stored end-frame prompt is 2183 characters. Where that text goes:

| Section | Characters |
| --- | --- |
| Scene description (the actual shot) | 600 |
| Appended `husband:` block | 544 |
| Appended `wife:` block | **966** |
| Unnamed man, in the scene description | 183 |
| Unnamed man, appended (`the muscular Black man: nude`) | 50 |

**the wife is described at four times the length of the man the shot is about.**
Two-thirds of the prompt is an appended cast sheet describing two people in
minute anatomical detail, and the third person — the one performing the action —
gets a single clause.

That is a plausible account of every symptom: the model renders what it was told
most about, twice, and the one concrete garment in the sheet (`blue jeans and a
white polo shirt`) attaches to the only body that can wear clothes.

**Untested.** The obvious experiment is to shorten the appended blocks — cap each
character's description, or drop the appended sheet entirely for characters the
body prose already describes — and re-render `s13 end`. Nobody has tried it.

### A real defect found while reading that prompt (fixed in v1.52)

The stored **negative** prompt for this scene contained:

```
… athletic build for the wife, flat midsection for the wife, short hair for the wife,
dark skin for the husband, blue eyes for the husband, cool fluorescent lighting …
```

`dark skin for <character>` — in a scene whose leading man is black.

A negative prompt has **no addressee**. The sampler sees `dark skin` and steers
the entire frame away from it. The prompt agents write these scoped exclusions
routinely; they read as careful per-person direction and cannot work as one. This
had been actively fighting the positive prompt on every multi-person frame in the
project, and is a strong candidate for why the man kept returning too light or
replaced altogether.

`withoutCharacterScopedTerms()` in
[lib/agents/negative-prompt.ts](../lib/agents/negative-prompt.ts) now drops a term
matching `<trait> for <CastName>` unless the frame states exactly one person, in
which case the scope is redundant and the trait is kept. Applied at render time,
so stored prompts need no repair. For `s13 end` this removes five terms including
both of the husband's.

**Note this was found by reading the prompt end to end, which had not been done
before.** Several earlier hypotheses would have been discarded sooner if it had.

---

## 2c. Everything except the prompt has now been eliminated

`s13 end` was rendered again with **all three** of the remaining suspects removed
at once:

| Variable | State |
| --- | --- |
| Conditioning start frame | **not sent** (v1.51 headcount rule fires: 2 → 3) |
| Character reference photographs | **none** — project set to description-and-face-swap-only |
| Character-scoped negative terms | **removed** (v1.52) |
| Model | `flux2_klein_9b`, not an edit model |

It failed identically: the man correctly black but wearing **a white polo shirt
and blue jeans**, a **woman in the corner chair** where the husband should be,
and no husband anywhere.

One detail kills the reference-photograph theory outright: the woman in the chair
is a **brunette who does not resemble the wife**. She is not a duplicated reference
subject. She is simply *a woman*, generated where the prompt asked for a man.

So the failure survives with no images of any kind in the job. **The prompt is
the only remaining variable**, and §2b's description-mass hypothesis is now the
sole surviving explanation rather than one of several.

### The experiment currently loaded

`s13`'s stored end-frame prompt has been replaced by hand with a rewritten
version — 2183 characters down to 1042 — built on three changes:

1. **No names.** A name is an unbindable label; the model has no idea who
   "the husband" is. Each person is a self-contained physical description.
2. **Wardrobe bound inline**, adjacent to the body it belongs to, instead of
   appended in a separate sheet at the end.
3. **An explicit contrast**: *"Only the older white man wears clothes. The two
   people on the bed are completely naked."*

The negative prompt was replaced too, adding `duplicated person, twins, two
identical women, cloned face, second woman, two women` — nothing in the original
was aimed at the duplication failure.

The original is preserved in `project-backup-3ce84bc0-pre-testA.json`.

**If this renders correctly, the prompt builder is the whole problem** and the
fix is to compose prompts this way rather than appending a cast sheet. If it
fails, the remaining explanation is that the model cannot compose three people in
an entangled intimate scene at all, and the answer is compositional — keep the
watcher out of these frames.

---

## 2d. RESOLVED — it was the prompt format

Test A rendered **correctly on the first attempt**: three distinct people, every
attribute on the right body. The black man nude, the wife nude, the husband clothed
in the corner chair. Both face-swap passes then landed on the right heads.

The same scene, same model, same seed, same settings had failed repeatedly for a
day. The only thing that changed was the shape of the prompt.

### What actually fixed it

| | Before | After |
| --- | --- | --- |
| Length | 2183 chars | 1042 chars |
| Cast sheet | appended block, 1510 chars | none |
| Wardrobe | trailing `Wearing exactly: <outfit>` | inline, adjacent to the body |
| Names | `husband:`, `wife:` | none — physical description only |
| Explicit contrast | absent | "Only the older white man wears clothes" |

The diagnosis in §2b was right: **the appended cast sheet was two-thirds of the
prompt and described one character at four times the length of the person the
shot was about.** A model allocates attention roughly by description mass, and
`Wearing exactly: <outfit>` sitting at the end with only a name to bind it to is
an unanchored attribute that lands on whichever body can wear it.

### The rule

> Describe each person once, compactly, with their clothing attached to them in
> the same clause. Do not append a separate sheet of names and attributes. Do not
> use names at all — the model has never heard of them.

### What this means for the fixes shipped along the way

- **1.45–1.48, 1.51** — narrowing who a frame describes, and not conditioning a
  frame on a picture that contradicts it — were real defects and remain correct.
- **1.52** (character-scoped negative terms) was a genuine defect: `dark skin for
  the husband` in a scene led by a black man. Keep.
- **1.49** (one photograph per character) is still sound: four pictures of one
  person is four subjects to place.
- **1.50** (one portrait per frame) was built on a rule §2a disproved. With the
  prompt fixed it may be unnecessary, and it costs a likeness on every character
  after the first. **Re-test before keeping.**
- **The repository cache fix** matters more than it looks: the store hydrated once
  per process and never re-read, so a hand-corrected prompt was invisible until a
  restart and would be overwritten by the next save. It hid this experiment's
  result for an hour and would have silently reverted the correction.

### Reference photographs: retested, and the earlier answer was wrong

An initial comparison — same seed, prompt fixed, references on versus off —
found no meaningful difference, and this document recommended leaving them off.
**That recommendation is withdrawn.**

A later full run on `krea2_turbo_edit` **with** identity references produced the
best output of the whole investigation: three distinct people, correct clothing
on each, the watcher present in the background, and clean anatomy on an
entangled two-body pose that had been failing for everything else.

Why the first comparison saw nothing is worth keeping in mind. It ran on
`flux2_klein_9b` with v1.50's one-portrait cap in force, so exactly one
character's photo was sent and the other's likeness came from prose plus the
face swap **in both arms**. It compared one portrait against none — not
references against no references.

**Current position:** references are safe alongside a compact bound prompt, and
appear to help on a model built around identity. Whether they are *necessary* is
still open, since the face swap corrects head and hair regardless.

### Still outstanding

The prompt agents are still instructed to write scene bodies that **rely on an
appended sheet** — they are told not to describe a pinned character, because
`castPromptSuffix` will. Getting all the way to Test A's shape — one description
per person, written inline, no names at all — needs those instructions changed
too, and that only affects **newly generated storyboards**. v1.53 is the
mechanical half, reachable by existing projects through **Repair prompts**; the
agent half is worth doing once 1.53's format has held up across a full run.

---

## 3. Numbered references — no longer needed, kept for reference

> **Largely moot.** This was the leading idea while references were believed to
> be the problem. They are not (§2d), and the recommendation is now to send none
> at all where face swap is enabled. It stays here because the technique is
> sound and would matter again if references ever become necessary — for a
> character whose face is not swapped, or a model without a swap step.

**Number the references in the prompt.** The app already does this elsewhere and
it works:

- The **face swap** prompt says *"start with Picture 1 as the base image… replace
  the head with the head of the man from Picture 2"* — and correctly swaps the
  right person.
- The **ref2va** path builds `CastReference` objects and, per its own comment,
  sends the description alongside so *"the prompt can name who each reference
  is, which is the only thing telling the model that picture 3 is a person
  rather than another composition to reproduce."*

The keyframe path does neither. It sends a bare list.

An agent picking this up should look first at whether the keyframe cast sheet can
be restructured as *"Picture 1 is the wife: <description>, wearing X. Picture 2 is
the husband: <description>, wearing Y."* with the image order guaranteed to match. If
that binds reliably, the v1.50 one-photo cap can be lifted and both likenesses
kept. `resolveCastSubjects()` in `media-service.ts` is the existing shape to copy.

Open questions for that work:

- Does `flux2_klein_9b` respect picture numbering the way the swap model does?
- Reference order is currently whatever `charactersInFrame` returns. It would
  have to become explicit and stable.
- The inherited start frame is *also* in `image_refs`, and it is already
  positioned via `imageRefsLeadWithScene`. Numbering must account for it.

---

## 4. Fixed already — do not re-investigate

Each of these was a real defect, found by inspecting output rather than code, and
each was fixed and covered by tests. They are listed so the next agent does not
spend time re-deriving them.

| Version | Defect | Cause |
| --- | --- | --- |
| 1.45 | A character framed out still donated his clothes | Character sheet built from the scene **card**, appended to a **frame**. Card and frame disagree constantly. Now built per frame. |
| 1.46 | An unnamed person's wardrobe pin leaked into shots they were not in | Same fault in the "Wardrobe continuity" clause. Now placed per frame, matched on describing words rather than the exact phrase. |
| 1.47 | A character's **photograph** reached frames they were not in | Same fault again, in the image channel. This is why 1.45 and 1.46 did not help — the picture outranks the prompt. Face-swap planning had it too. |
| 1.48 | A new person entering a scene never appeared | `reuse_end_frame` deliberately survives an arrival because *the clip carries them in*. On `keyframes_only` **there is no clip**, so the end frame had to introduce a stranger against an inherited picture of the old cast, and the picture won. A headcount change now breaks the seam. |
| 1.49 | One character rendered twice in a frame | All four of the wife's photographs were sent on every job. An edit model reads four pictures as four things to place, not four pieces of evidence about one face. Now one per person. |
| 1.50 | Attributes crossing between people | Capped portraits at one per frame. **This did not fix it** — see §2a. |
| 1.51 | A person joining a shot mid-scene replaced by a duplicate | The end frame is conditioned on its own start frame, whose population contradicts it. 1.48's failure at the within-scene join. **Did not fix `s13 end`** — see §2b. |
| 1.52 | Character-scoped negative terms suppressing a trait globally | `dark skin for <character>` in a scene led by a black man. A negative prompt has no addressee. |
| 1.53 | The appended cast sheet crowding out the shot | Full stored descriptions plus a detached `Wearing exactly:`. Trimmed to a budget, wardrobe bound into the same clause. **This was the cause** — see §2d. |
| — | A hand-edited project file invisible to the running app | The repository hydrated once per process and never re-read, so an external correction stayed unseen until a restart and was overwritten by the next save. |

**The recurring shape:** the same "who is in this shot" question was answered from
the scene card in four separate places — character sheet, wardrobe clause,
reference photographs, face-swap plan. Each had to be found and fixed
independently. If a fifth consumer exists, it has the same bug.

**The second recurring shape**, and the more expensive one: *a conditioning image
whose contents contradict the prompt wins, silently.* It has now appeared three
times — 1.47 (a portrait of someone not in the shot), 1.48 (an inherited frame
missing an arriving character), 1.51 (a start frame missing a character the end
frame adds). Any new code path that passes an image alongside a prompt should be
checked against this before anything else.

---

## 5. Model choice — Krea for this material, and why the first answer was wrong

The project was on **`krea2_turbo_edit`** ("Krea 2 Turbo Identity Edit v1.2"), an
**edit** model, and `docs/Discord Intro.md` had already recorded what that costs:

> "An edit model treats a reference image as the thing to reproduce, not as
> guidance, and no amount of prompt text outranks that… if a reference image and
> the prompt disagree, decide which one you actually want to win, and route the
> job to a model that behaves that way. Do not try to negotiate with a
> reconstruction objective."

On that basis this section previously advised moving to `flux2_klein_9b` and
**not** going back. Moving did help — wardrobe changes started landing — but it
did not fix the real fault, which was the prompt (§2d).

**With the prompt fixed, `krea2_turbo_edit` was retried with identity references
on, and produced the best output of the investigation.** So the earlier advice
was drawn from evidence gathered while every prompt was twice the size it should
have been. The quoted warning still describes what an edit model *does*; what
changed is that a compact, bound prompt no longer loses the argument to the
reference.

### The comparison, run properly

An 18-scene run was then repeated on `flux2_klein_9b` against the existing Krea
set: same build, references on in both, same pinned seeds, same prompts. Only the
model differed. Two things separate them on this material.

**Anatomy on entangled poses.** Klein distorted an intimate two-shot badly — an
elongated ribcage, wrong proportions, a stray limb at the frame edge. Krea's
version of the same seed is coherent.

**Fidelity to the shot as written.** A scene asking for missionary with a watcher
in a background corner chair came back from Klein with the man kneeling beside
her and the watcher leaning in close over the bed. Krea placed both as described.

Identity and wardrobe were correct on **both**, which is the part the prompt fix
owns rather than the model.

**Conclusion, scoped:** for this project — explicit, multi-person, intimate
staging — `krea2_turbo_edit` is the better choice, and its name is a fair
description of what it is good at. That is one project and one kind of content;
a chase sequence or a crowd scene has not been tested and might well go the other
way. The earlier advice to avoid it was wrong, and wrong for an instructive
reason: it was measured on broken prompts.

Of 97 image models on the server, **22 are installed**. The reference-capable
non-edit options are `flux2_klein_9b` (8 default steps) and `flux2_klein_base_9b`
(30). `flux2_dev` (Flux 2 Dev 32B) qualifies but is **not downloaded**.

**Trap:** `ACCELERATOR_PATTERNS` in [lib/wangp/steps.ts](../lib/wangp/steps.ts)
recognises `turbo`, `distill`, `schnell` and so on, but **not `klein`**. So
`flux2_klein_9b`, whose own default is 8 steps, gets forced up to the 30-step
floor — four times the render time and over-cooked output. Adding `klein` to that
list was tried and reverted: `flux2_klein_base_9b` is *not* distilled (it declares
30 for itself) and an existing test uses it as the canonical unaccelerated
example. **Set the project's Image steps to 8 manually instead** — a project
override outranks the floor.

---

## 6. Known-good and known-bad, for regression checking

**Known good** — if a change breaks these, it is a regression:

- A frame with one character and one photograph renders that character correctly,
  including wardrobe.
- A person described only in prose, with no photograph, renders correctly —
  including skin tone, build and clothing.
- Scene 3's start frame, rendered fresh after the 1.48 seam fix, correctly shows
  all three people in the right clothes.

**Known bad:**

- Any frame carrying two photographs, before 1.50.
- Anatomy in intimate two-person compositions is unreliable (extra limbs). This
  is model quality, not app logic, and is out of scope for the above.

---

## 7. How to reproduce and inspect

Renders land in `C:\pinokio\api\wan.git\app\outputs` named
`<timestamp>_seed<n>_<first 50 chars of prompt>.jpg`. The prompt fragment in the
filename is enough to map a file to a scene — **note that under `reuse_end_frame`
scene N's start prompt is byte-identical to scene N−1's end prompt**, so two files
sharing a prompt with different seeds means the seam broke and the scene rendered
its own start frame.

WanGP does **not** write a settings sidecar and does **not** embed the job JSON in
the image, so the payload cannot be recovered after the fact. Telemetry goes to
`console.log` in the terminal running the app; `run-storyforge-ai.bat` does not
redirect it to a file. **This is the single biggest obstacle to debugging** — every
finding above had to be reconstructed by correlating output images against
recomputed prompts. Persisting the submitted job settings would pay for itself
immediately.

To recompute what a frame *would* be sent without rendering, load the project
record and call `rebuiltPrompts()` from
[lib/agents/cast-sheet.ts](../lib/agents/cast-sheet.ts) together with
`wardrobeTimeline()`. That is how §2's table was produced.

Do not run `npm run build` while a generation is in progress — the production
server reads the prebuilt `.next` output and rewriting it mid-run breaks a batch
that may be hours in. Editing source is safe. Check with
`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`.

---

## 8. Suggested order of work

Items 1 and 2 of the previous list are done: reference photographs were tested
and make no difference (§2d), and the composer was rebuilt in **v1.53** —
descriptions trimmed to a sentence boundary within a budget for renders only,
wardrobe bound into the same clause as the person it belongs to. Measured across
the project that exposed all this, end-frame prompt text fell from 26554 to 16310
characters. What remains:

1. **Run a full film on v1.53 before anything else.** One scene proved the shape;
   a whole run is what proves the format. Existing projects pick it up through
   **Repair prompts**.
2. **Change the prompt agents to write bodies that stand alone.** They are
   currently told *not* to describe a pinned character because a sheet will be
   appended. Test A — the version that worked first time — had one compact
   description per person written inline and **no names at all**. Reaching that
   shape means rewriting `castSystemDirective` in
   [lib/agents/cast.ts](../lib/agents/cast.ts) and dropping the appended sheet,
   and it only affects newly generated storyboards.
3. **Re-test v1.50's one-portrait cap** and remove it if the prompt fix makes it
   redundant. It was introduced on a rule §2a disproved.
4. **Persist the submitted job settings** per attempt. Every finding here was
   reconstructed by correlating output images against recomputed prompts.
5. **Audit for a fifth consumer** of the scene-card cast question (§4), and for
   any other place an image is passed alongside a prompt it might contradict.

A caveat for anyone repairing the project this was debugged against: **scene 13
holds a hand-written prompt** that already describes all three people inline.
Rebuilding it appends a sheet on top and describes everyone twice — 1042
characters becoming 1590. Repair the other seventeen.

---

## 9. A note on method, for whoever picks this up

Eight versions were shipped against this symptom. Several were real defects worth
fixing. **None of them was the cause.**

The pattern in the wrong turns is consistent: each was a hypothesis formed by
reading code, and each survived longer than it should have because the artefact
was not examined first. Every turning point came from looking directly —

- opening the rendered images, which showed the "black man in the husband's clothes"
  was sometimes the husband and sometimes a stranger, and once a brunette woman where a
  man was asked for;
- printing the prompt end to end, which exposed both the description imbalance
  and a negative term sabotaging every multi-person frame;
- measuring the prompt in characters per person, which turned a vague sense that
  it was "too long" into a 4:1 ratio.

The one experiment that settled it took two minutes and no code.

Before forming the next hypothesis: **read the exact prompt, look at the exact
image, measure what is actually in the job.** The code is a poor witness to what
the model received.

