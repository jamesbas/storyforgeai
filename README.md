# StoryForgeAI

*Designed and built by [JabAI Solutions](https://www.jabaisolutions.com/).*

A **local-first agentic creative studio** that turns a single video concept into a
complete storyboard and generation package. StoryForgeAI orchestrates a team of
specialized AI agents to produce a creative brief, story arc, visual bible, scene
cards, image/video prompts, WanGP generation settings, and a final assembled cut.

It is **TypeScript-first** (Next.js App Router) and runs **fully offline in demo
mode**: every external integration (LLM, WanGP/Wan2GP MCP, ffmpeg, Deepy,
PostgreSQL) sits behind a feature flag + swappable interface + deterministic mock,
so nothing cloud is required to run, test, or demo the app.

> This application integrates with WanGP/Wan2GP as a local media generation
> backend. WanGP is developed by DeepBeepMeep and is subject to its own license and
> terms. Review the license for each model used inside WanGP, as individual models
> and checkpoints can carry separate commercial-use restrictions.

![A finished scene card: the objective and shot description the agents wrote, the start and end keyframes, and the clip generated between them](public/screenshots/storyboard.png)

*One scene from a finished project. Everything above the images was written by the
agent crew; everything below was rendered by WanGP from those prompts.*

---

## Update log

The current release is shown in the app's footer, so you can tell at a glance
whether what you are running matches what is described here. Only the five most
recent updates are kept below — every release ever made is in
[CHANGELOG.md](CHANGELOG.md).

| Version | Date | What changed |
| --- | --- | --- |
| **1.19** | 2026-08-07 | **Reference mode now says which picture the shot opens on, in the place that decides it.** Reference mode has no positional keyframes — the model knows a picture is the opening frame only because the prompt says so — and the prompt was saying it only in the bookkeeping sections at the top. The result was a clip that reached its closing frame exactly and opened on something invented. The shot description itself now begins by naming the opening frame and ends by naming the closing one, the summary states which picture the shot runs from and to, and each retention line says at which end it applies. That is four statements of the same fact, matching a hand-made render of the same model that came out correct — the description is the one that cannot be left out, because the writing agent is describing a scene rather than a set of pictures and will never mention them on its own. |
| **1.18** | 2026-08-07 | **Reference mode now sends the settings a working render actually used.** Three of them were wrong, and together they produced clips with nothing to do with their prompt — in one case a Japanese cartoon, complete with Japanese speech. The step-skipping cache was switched on beside a *strength* left over from WanGP's saved state, and at that value it skipped so much of the denoising that the model abandoned the prompt and fell back on whatever it was trained on; it now carries the strength measured alongside it, which is the difference between a clean 20-minute clip and an 8-minute one that is unusable. The reference images were labelled with the wrong letter, so the model took the wrong picture as its opening frame and the supplied start frame surfaced at the end. And a prompt written in labelled sections was being split into a separate prompt per section, because a carriage return meant something to WanGP that it did not mean to us. All three were settled by reading the settings WanGP writes beside every clip it renders — the app's own guesses had been wrong in both directions. |
| **1.17** | 2026-08-07 | **Reference mode stopped being told which picture is which in a language it does not speak.** WanGP labels reference images with letters — people, or a scene followed by people — and StoryForgeAI wrote that label on every job carrying references, because the models it had met until now ignore the images without it. MiniMax H3's reference variant is not one of those: it ships that field empty and reads the pictures straight, so writing a label changed which one it took as the opening frame. The result was a clip whose supplied start frame turned up at the *end* and whose opening was invented from nothing. That field is now left as the model ships it wherever a model publishes no default of its own, which is exactly the configuration the Wan2GP UI uses when the same job is set up by hand. |
| **1.16** | 2026-08-07 | **A failed scene now says why, on the screen.** The reason a batch failed was only ever in the tooltip of a small red chip, which is where an error goes to be missed — a scene could fail and the honest answer to "why?" was "hover over it". Failures are now listed in full under the batch controls. The message they carry is better too: a model that accepts no LoRAs used to say only that, and now names the LoRAs in question and where to clear them. That case has one common cause, so it is also headed off earlier — selecting reference mode with video LoRAs still chosen warns on the settings screen that every clip will fail, rather than letting you find out after the render. Reference mode takes no LoRAs at all, and accelerators are actively harmful there: a 4-step LoRA finished in a quarter of the time and scattered the referenced face across several people. |
| **1.15** | 2026-08-07 | **Clip prompts stopped narrating their own instructions.** Every video prompt was asked for "one dominant action and at most one secondary movement" — and models handed that phrasing back in the prose, writing *"the robot performs its dominant action: it tilts its head"*. A video model renders those words rather than obeying them, so the instruction ended up described in the picture and spent part of a prompt budget that is already tight. The same shape is now asked for by describing it rather than naming it, and every prompt is told to write only the scene — never to restate the brief or announce what a sentence is about to do. The scene card also warns when a model narrates the brief anyway, alongside the existing checks for repeated sentences and dropped dialogue. |

---

## Features

- **Concept → storyboard** in equal-length segments. **Clip length is set per project**
  on the New Project form — anywhere from **5 to 20 seconds**, defaulting to 20 — and
  the scene count follows from it (`segmentCount = ceil(duration / segmentSeconds)`).
  Shorter segments mean more scenes, more keyframes and finer control over pacing.
- **Agentic Canvas** — a visible creative crew: Intake Producer, Story Architect,
  World Builder, Director, Cinematographer, Art Director, Storyboard Artist,
  Image/Video Prompt Engineers, WanGP Producer, Audio Director, and Creative Critic.
  **Run core agents** executes the plan agents in dependency order and then the
  storyboard, which is what makes those plans reach the render.
- **Variant exploration** — generate 3 creative directions and pick one before
  committing to a storyboard.
- **Animatic** — previsualize pacing and captions before expensive video generation.
- **WanGP MCP integration** — model discovery, schema/default settings retrieval,
  settings-manifest generation, and job submit/poll/cancel.
- **Media generation** — per-scene start/end keyframes + a clip of the project's
  segment length, scene attempts
  with retry/regeneration, QC results, and human approval.
- **Imported keyframes** — a scene's start or end frame can be supplied as an image
  file instead of rendered, for a picture you already have or a render you edited
  outside the app. The clip, the end-frame reference and the next scene's
  carried-over start frame all read the imported image. Regenerating a scene's media
  re-renders both frames and discards it; rebuilding only the clip keeps it.
- **Character library** — reusable cast with up to two reference images each,
  a separable facial description that steps aside for a photo, and an optional
  face-swap pass over generated keyframes. Description, photograph and face swap
  apply only to the scenes a character is actually in, and a project can decline
  the photograph entirely and let the description and face swap carry the likeness.
- **Wardrobe timeline** — costume is a starting outfit rather than a constant.
  Changes are declared at the scene where they happen and carry forward, nudity is
  a wardrobe state rather than an outfit, and people who were never pinned to the
  library can be dressed by name ("the two men").
- **Scene continuity you can override** — a scene can start from the previous scene's
  end frame, and that frame is handed to the end-frame render as a reference so
  wardrobe, location and lighting carry across the seam. It carries props just as
  firmly, so **Match the carried-over frame** can be cleared on any single scene
  whose own action has to change something the start frame is still showing.
- **Live batch progress** — keyframes are written to the storyboard as each scene
  renders them rather than at the end of the phase, so a long run visibly fills in,
  cancelling keeps what has already been paid for, and the per-scene chips name the
  phase each scene is in.
- **Model-aware prompting** — prompts are written for the family that will render
  them (FLUX, Qwen, Krea, Wan, LTX). Exclusions are routed at render time, so a
  model with no negative prompt gets them folded into the positive prompt instead
  of silently discarding them.
- **Explicit-content directives** — when the audience or tone calls for it, the
  planning and prompt agents are told so plainly, using the same wording the
  settings screen shows.
- **LoRA selection** — pick LoRAs for the whole storyboard or override them per
  scene, filtered to those installed for the pinned image/video model, with
  per-LoRA strengths. Trigger words are read from WanGP's sidecar metadata and
  appended to prompts automatically when missing.
- **Editable scene cards and prompts** — correct a scene's objective, beat, visual,
  action or camera, then rewrite just that scene's prompts. Two model calls rather
  than the whole storyboard, with every other scene and its hand edits untouched.
  You are warned before a regeneration overwrites hand-edited scenes.
- **Project import** — restore a deleted project from its `project.json` record or
  a `storyboard.json` export. Import always creates a new project, so it can never
  overwrite one.
- **Project deletion** — remove a project and, optionally, its generated media,
  behind an explicit confirmation.
- **Assembly** — final-cut plan from approved clips, ffmpeg rough-cut, and an export
  package (`storyboard.json`, `storyboard.md`, `generation-manifest.json`,
  `animatic-plan.json`, `final-cut-plan.json`).
- **Deepy assist** — optional media helper actions (inspect, extract frame,
  transcribe, suggest regeneration).

---

## Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript (strict) |
| Web framework | Next.js 16 (App Router) + React 19 |
| Styling | Tailwind CSS |
| Validation | Zod (at every trust boundary) |
| Persistence | Swappable repository — JSON files (default) · in-memory (tests) · Prisma + PostgreSQL (scaffolded, not yet wired) |
| AI orchestration | In-process orchestrator + registry; optional OpenAI adapter |
| Media backend | WanGP MCP client (mock + live) · ffmpeg (mock + native) |
| Tests | Vitest + Testing Library (unit/integration/component) · Playwright (E2E) |
| Runner | `tsx` (scripts) |
| Packaging | Multi-stage Dockerfile + docker-compose |

---

## Getting started

### Prerequisites

- Node.js 20.9+ (enforced by `engines`; built and verified on Node 24)
- npm 10+

LM Studio is optional and is needed only for live AI planning; demo mode uses the
deterministic agents. For live planning, install LM Studio (or another compatible
OpenAI-style local server) and load an instruction-tuned model that can reliably
produce structured JSON. There is no fixed GPU or VRAM minimum: the machine needs
enough combined VRAM/RAM for the chosen model, quantization, and context window.
CPU-only inference can work but may be slow. If LM Studio and WanGP share one GPU,
leave enough headroom for generation or configure the LM Studio unload support
described under [Local LLM](#local-llm-lm-studio-ollama-llamacpp).

### Install & run

```bash
npm install
npm run dev
# open http://localhost:3200
```

The app boots in **demo mode** with an empty environment — no API keys, no database,
no WanGP server required. Deterministic mock agents and a mocked WanGP client back
every flow.

### Environment

Copy `.env.example` to `.env` and adjust as needed. All integrations default to
off/local:

```bash
STORYFORGE_PERSISTENCE=file          # "file" (default) or "memory"; "prisma" is
                                     # accepted but falls back to file — no
                                     # Prisma repository exists yet
DATABASE_URL=postgresql://storyforge:storyforge@localhost:5432/storyforge
DEFAULT_SEGMENT_SECONDS=20           # the form's starting value; each project
                                     # picks its own between 5 and 20
AI_PLANNING_ENABLED=false            # + OPENAI_API_KEY to enable the LLM path
WANGP_MCP_ENABLED=false              # + WANGP_MCP_URL to reach a live WanGP server
DEEPY_ASSIST_ENABLED=false
ANIMATIC_ASSEMBLY_ENABLED=false
PLATFORM_DERIVATIVES_ENABLED=false
```

Three further flags are implemented but **off pending validation against real
hardware**. All change behaviour that only a live render can judge, so none
is enabled by default:

| Flag | What it does | What it is waiting for |
| --- | --- | --- |
| `MEDIA_PROMPT_COMPOSER_V2` | Rebuilds deterministic prompts around a shared semantic contract | Fixed-seed renders compared per model family (`npm run prompts:preview` shows the diff) |
| `H3_NATIVE_PROMPT_FORMAT` | Sends MiniMax H3 the labelled prompt structure from its own published guide — frame alignment, timeline, ambience and score as separate fields | **Reassessment in progress.** Three runs showed no spoken dialogue in the labelled arm, but the test subject was a robot whose own prompt said it had no mouth. The same labelled prompt spoke, with a moving mouth, at both 4 and 8 accelerator steps — so the format was obeying a contradiction rather than failing, and the fast path never hits it. Needs one run at full step count on a character with a mouth |
| `DURABLE_TASKS` | Persists queue state so a restart reconciles instead of losing or resubmitting work | One interrupted live WanGP render resumed by polling |

The About page always shows which flags are currently enabled.

---

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start the dev server on **port 3200** |
| `npm run dev:e2e` | Dev server on port 3100 (used by the E2E suite) |
| `npm run build` | Production build (standalone output) |
| `npm run start` | Run the production build on **port 3200** |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint flat config (`eslint .`) |
| `npm test` | Vitest unit + integration + component |
| `npm run test:e2e` | Playwright E2E (boots its own dev server on 3100) |
| `npm run smoke` | `tsx` full-pipeline smoke (create → storyboard → media → assemble) |
| `npm run docs:screenshots` | Recapture the screenshots in this README and `docs/architecture.md` |
| `npm run audit:prod` | Dependency audit, runtime only, fails on high/critical |
| `npm run audit:all` | Dependency audit across the whole graph |
| `npm run prisma:generate` | Generate the Prisma client |
| `npm run prisma:seed` | Idempotent demo seed |

First E2E run downloads the browser: `npx playwright install chromium`.

The E2E server builds into `.next-e2e`, not `.next`, so it is safe to run the
suite while the app itself is running. They shared a build directory once, and
the consequence was not obvious: `next start` resolves a route's compiled module
the first time something asks for it, so the dev server rewriting `.next`
mid-session left the running app unable to find routes nothing had touched yet.
Media assets were the casualty every time, because nothing requests them until a
render has finished — the app looked fine for hours, then served broken images.

`npm run build` still writes `.next`, so that one does need the app stopped.

### Documentation screenshots

`npm run docs:screenshots -- --project <projectId>` photographs a running app and
writes `public/screenshots`. Point it at a project that has been taken all the way
through — canvas, storyboard, media, assembly — because the screenshots are of its
work: a half-finished project photographs empty cards and dead players.

It needs the real app (`npm start` or `npm run dev` on 3200), not the E2E server,
which runs in demo mode against an empty in-memory store. Videos are seeked a
little way in before the shutter, since a `<video>` that has never played paints
nothing and every clip would otherwise be a black rectangle.

### Ports

| Purpose | Port |
|---|---|
| App (dev &amp; production) | **3200** |
| E2E test server | 3100 |
| PostgreSQL (docker-compose) | 5432 |

To use a different port for a one-off run, invoke Next directly:
`npx next dev -p 4000` (or `npx next start -p 4000`). To change it permanently,
edit the `dev` / `start` scripts in `package.json`, the `EXPOSE`/`PORT`/healthcheck
values in the `Dockerfile`, and the port mapping in `docker-compose.yml`.

---

## Typical workflow

1. **New Project** — enter a concept, duration, style, tone, and toggles.
   Optionally attach reference images.

   ![The new project form: concept, duration, style, tone and generation toggles](public/screenshots/new-project.png)

2. **Variant Review** — generate 3 directions and select one (optional).
3. **Storyboard** — generate the brief, visual bible, and scene cards.
   References are read automatically if they have not been already.
4. **Agentic Canvas** — run World Builder / Director / Cinematographer / Art
   Director / Audio Director; view artifacts, status, and decision history.

   ![The agentic canvas: one card per agent showing its plan, the model that wrote it, and a decision history of the whole run](public/screenshots/agentic-canvas.png)

5. **Generation Console** — inspect WanGP models and job status.

   ![The generation console: resolved WanGP models, job status and queue state](public/screenshots/generation-console.png)

6. Per scene — **Generate media** (start/end frame + the scene's clip), run **QC**, and
   **Approve**.
7. **Assembly** — assemble a rough cut and export the package.

   ![Assembly: approval state, the assembled rough cut, its source clips and the export package](public/screenshots/assembly.png)

> Screenshots are captured from a real finished project with
> `npm run docs:screenshots -- --project <projectId>`, against a locally running
> app. See [Scripts](#scripts).

---

## Project structure

```
app/                    # Next.js routes (UI pages + API route handlers)
components/             # UI grouped by surface (shell, intake, storyboard, ...)
lib/
  config.ts             # Centralized feature flags + env
  types.ts              # Union-type enums (single source of truth)
  schemas/              # Zod schemas (intake, storyboard, canvas, audio, wangp, ...)
  agents/               # Orchestrator, registry, agents, mock builders, LLM adapter
  services/             # Business logic (project, wangp, media, assembly)
  wangp/                # WanGP MCP client interface + mock + model router + settings
  media/                # ffmpeg builders/runner + final-cut assembly
  deepy/                # Deepy assist
  db/                   # Repository interface + in-memory store
  telemetry/            # Structured JSON logging
prisma/                 # schema.prisma + seed
scripts/                # smoke script
tests/                  # Vitest suites
e2e/                    # Playwright specs
public/screenshots/     # Screenshots used by this README, docs/, and the Help page
docs/                   # Architecture, specs and reference notes
Dockerfile, docker-compose.yml
```

See [architecture.md](docs/architecture.md) — the single architecture reference,
covering the agent roster and interconnections, prompt precedence, LoRA and
character-identity conditioning, the face-swap pipeline, the continuity seam, the
data model, the API surface, and the flag/mock strategy.

---

## Docker

```bash
docker compose up --build
# app on http://localhost:3200, PostgreSQL on 5432
```

The image is a multi-stage build producing a self-contained Next.js standalone
server with a `/api/health` healthcheck. It defaults to in-memory demo mode; set
`STORYFORGE_PERSISTENCE=prisma` to use the bundled Postgres service.

Both services publish to `127.0.0.1` only. Without that prefix Docker opens the
port on every interface *and* bypasses the host firewall while doing it. The
container itself binds `0.0.0.0`, which is its own network namespace — the
boundary is the publish address. To reach the container from another device, add
that hostname to `STORYFORGE_ALLOWED_HOSTS` and change the publish address
deliberately.

---

## Testing & quality

Testing is a first-class part of every build phase. Quality gates:

```bash
npm run typecheck && npm run lint && npm test && npm run test:e2e && npm run smoke
```

- Every external dependency has a deterministic mock injected via dependency
  injection — no test needs cloud credentials or a running WanGP server.
- `/api/health` returns `200 ok`.

---

## Security

### Dependency audit policy

```bash
npm run audit:prod   # runtime dependencies only — must stay clean
npm run audit:all    # whole graph, including build and test tooling
```

- **`npm run audit:prod` must pass.** It audits runtime dependencies only and
  exits non-zero on any high or critical advisory. Treat a failure as a release
  blocker, not a warning.
- **`npm run audit:all` is expected to pass too**, and does today, but a build or
  test-only advisory is a lower priority than a runtime one — a vulnerable test
  runner is not reachable by a request.
- Run both after any dependency change and before cutting a release.

### Fixing an advisory

1. Prefer upgrading the direct dependency to the fixed version.
2. If the vulnerable package is transitive, check whether its parent already
   allows the fixed range. Several do, and npm simply picked the lowest
   satisfying version — an `overrides` entry then resolves it properly rather
   than needing an exception. The `overrides` block in `package.json` exists for
   exactly this and every entry is compatible with what its parent declares.
3. Only if neither works, record an exception with the advisory ID, why the code
   path is unreachable, the mitigation, an owner and an expiry date.
4. **Do not run `npm audit fix --force`.** It performs unreviewed major upgrades
   across the graph. Stage upgrades by blast radius instead — tooling first,
   framework last — and validate the gates after each group.

### Deployment

The app is built to run on a machine you control. Two settings define where it
listens and which requests it will honour.

| Variable | Default | Purpose |
| --- | --- | --- |
| `STORYFORGE_BIND_HOST` | `127.0.0.1` | The interface to listen on |
| `STORYFORGE_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | `Host` values the app answers to |

Out of the box the app serves your workstation only. Left unset, Next would bind
every interface, including whatever LAN you happen to be attached to.

**Reaching it from a phone over Tailscale.** `-H` takes one address, so there is
a trade-off to make deliberately:

*Tailnet only* — the desktop must then use the tailnet name too, because binding
to one interface stops `localhost` being served:

```env
STORYFORGE_BIND_HOST=100.71.40.31              # this machine's tailnet address
STORYFORGE_ALLOWED_HOSTS=box.tailnet.ts.net
```

*Loopback and tailnet together* — the only way to have both, since Next cannot
bind two specific addresses. The allowlist is doing the work here, so name the
hosts exactly:

```env
STORYFORGE_BIND_HOST=0.0.0.0
STORYFORGE_ALLOWED_HOSTS=localhost,127.0.0.1,box.tailnet.ts.net
```

With `0.0.0.0` the socket is open on your LAN as well, and a request arriving
there is refused by the `Host` check rather than by the network. That is a
weaker boundary than the first option — prefer it only if you need both, and
keep a host firewall in front. Allowlist entries match with and without the
port. The app **refuses to start** if you bind wider than loopback without
naming the allowlist, so the unsafe combination is a startup error rather than
something discovered later by whoever finds the open port.

**What this does and does not do:**

- The `Host` allowlist blocks **DNS rebinding** — a hostile domain re-resolving
  to `127.0.0.1`, which the browser then treats as same-origin, so CORS stops
  applying and the `Host` header is all that still gives it away.
- Cross-site `POST`/`PUT`/`PATCH`/`DELETE` requests are refused. This matters
  even on pure localhost: a cross-origin HTML form POST needs no CORS preflight,
  and several routes here take no request body at all, so any page you visit
  could otherwise trigger generation or unload your planning model.
- Requests carrying neither `Sec-Fetch-Site` nor `Origin` are allowed, which is
  how `npm run smoke` and the `wangp:*` scripts keep working. They are not
  browsers, and this guards against your browser being used against the app.
- There is **no login**, deliberately. Tailscale ACLs decide which devices may
  connect; these settings decide which requests are honoured once they do.
- There is **no rate limiting** and **no content moderation** anywhere.

> **Exposing the app publicly — Tailscale Funnel, a public reverse proxy, port
> forwarding — is out of scope for this design and needs real authentication
> first.** See `docs/build-specs/SPEC-007-network-trust-boundary.md`.

- Secrets live in `.env.local`, which is gitignored. Nothing is logged from it —
  telemetry records event names and IDs, never prompts or credentials.
- API responses that reflect mutable state send `Cache-Control: no-store`, so a
  browser cannot serve stale project state after a change.

---

## Prompt crafting

Every WanGP prompt is built from the scene's own content — visual description,
action, story beat, camera move, and dialogue. Dialogue is quoted inline in the
prose (`Lead says, "..."`), which is the format LTX-2 expects and how spoken
audio reaches the clip; nothing is synthesized separately.

Deterministic builders always produce a complete prompt. When `AI_PLANNING_ENABLED`
is set, an LLM refines each artifact and falls back to the builder on any failure.

### Written for the model that renders it

The image and video families disagree about what a good prompt is, so the prompt
agents are told which one they are writing for. The family comes from the model
pinned on the project's Settings screen; with no pin, no family guidance is given,
because a prompt written for one model and rendered by another is worse than a
neutral one.

- **FLUX** has no negative prompt. Exclusions are written into the prompt as the
  thing to render instead, and lighting is stated in full.
- **Qwen** is literal about structure: lettering is quoted exactly, materials are
  described at two scales.
- **Wan** asks for motion and camera and little else, so its clip prompts are short.
- **LTX** wants one flowing present-tense paragraph, and writes its own soundtrack
  from that prompt, so ambience and dialogue belong in it.

Because the model is only known for certain at render time — a pin can be missing
and fall through to the router — the exclusion is routed again on the way out. If
the resolved model cannot use a negative prompt, its terms are folded into the
positive prompt rather than dropped.

### Negative prompts are term lists

A negative prompt is a weighted list of things to steer away from, not a sentence.
The text encoder has no operator for "no", so `no watermarks` embeds the whole
phrase and the negation does nothing while the noun does the work by accident.
Prompts are stored as plain term lists — `watermark, distorted anatomy, low
quality` — and character negative terms are stripped the same way. Projects written
before this can be repaired in place from the Storyboard screen.

### Adult content

When the audience is *Adults only (explicit)* or the tone is erotic or raw/carnal,
the Director, Storyboard Artist and both prompt agents are told so directly, using
the same wording the settings screen showed. Without it they write euphemism, and
an image model has nothing to draw from an implication — it renders nouns. The app
applies no content filtering of its own. **Adult projects require an uncensored
planning model in LM Studio that will follow explicit-content instructions; a
censored or safety-aligned model may refuse, sanitize, or omit the required adult
prompts.** The image/video checkpoints used by WanGP must likewise support the
intended content. You are responsible for using lawful content and for checking
the licence and acceptable-use terms of every model and checkpoint.

### One take or an edit

A segment boundary exists because the video model renders only so much footage at a
time — up to about twenty seconds, which is why that is the ceiling on the project's
clip length. It is a **technical join, not a cut** — and the planning agents are told
which, from the project's scene-continuity setting.

On the continuing modes (`reuse_end_frame`, `continue_video`) the Cinematographer
holds the shot size, lens and camera height across boundaries and takes its
variety from movement instead — push-in, pull-out, orbit, arc, pan, tilt,
tracking. A push-in that ends tight is how the piece reaches a close-up; cutting
to one is not on the table. The Storyboard and Image Prompt agents get the
matching rule, and the Image Prompt Agent is handed the previous scene's
end-frame prompt so it can describe that same frame rather than opening a new
one.

On `cut`, the Cinematographer is told the opposite: vary shot sizes deliberately,
because contrast between framings is what signals which moments matter in an
edit. **To cut inside a continuous piece, say so in the concept text.**

Rendering enforces this independently. If a scene does cut to a different shot
size, or its transition names a cut, dissolve, fade or wipe, it renders its own
start frame even on a continuing mode. Without that rule the scene's start-frame
prompt was never sent to the image model at all — the clip opened on the previous
framing while its own prompt argued for a different one. When a frame *is*
inherited the scene card says so, since the Prompts panel would otherwise show a
start-frame prompt that had no effect on the image.

### Local LLM (LM Studio, Ollama, llama.cpp)
```
AI_PLANNING_ENABLED=true
OPENAI_BASE_URL=http://127.0.0.1:1234/v1
OPENAI_MODEL=<model id from the server>
OPENAI_API_KEY=lm-studio
```

Use an instruction-tuned model with enough context for the project and support for
structured output. StoryForgeAI defaults to a 12,000-token completion budget and a
240-second timeout; smaller/slower models may need the corresponding
`OPENAI_MAX_TOKENS` and `OPENAI_TIMEOUT_MS` settings adjusted. For adult projects,
the loaded model must be uncensored and willing to generate explicit prompts.

The response format is negotiated at runtime down a ladder — `json_schema`,
then `json_object`, then plain text — and a rung is abandoned only when the
server actually rejects it. Whether a given schema can be expressed as JSON
Schema is decided per call, so one unconvertible schema no longer demotes every
later agent. LM Studio accepts `json_schema` or `text` and refuses
`json_object`, which the ladder discovers once and then skips.

Every failure is logged as `agent.llm.failed` with a reason — `format_unsupported`,
`schema_mismatch`, `unparseable_json`, `request_failed`. **Watch for these.**
A silent fallback to the deterministic builder looks like success but means the
LLM contributed nothing — and because a built storyboard is schema-valid and
complete, the Storyboard screen shows an amber banner naming the reason rather
than leaving it to the log.

WanGP's own `prompt_enhancer` is explicitly disabled on every request. Several
models ship with it on (LTX-2 22B defaults to `"T"`), and it would rewrite the
crafted prompt with a local model that knows nothing about the visual bible or
scene continuity.

**Planning calls are serialized against a local server.** LM Studio and its peers
serve one request at a time, so overlapping structured-output calls are slower at
best and exhaust VRAM at worst — and a storyboard issues `4 + 2N` of them. Every
call goes through one chain whenever `OPENAI_BASE_URL` is set, which also covers
the Agentic Canvas firing several agents and a second browser tab. Hosted APIs
have no such limit and are left to run in parallel.

## Concept images

A project can hold up to six images that describe the piece rather than a
character in it. They live under **Project → Settings → Concept images**, and are
entirely optional: the typed concept leads, and a project with no images behaves
exactly as it does today.

Each image carries the kind it was uploaded as, and the kind decides what it may
do.

### Reference images

Pictures from outside the project whose look you want — a set, a palette, a
jacket, a quality of light. The Concept Reader writes a single description of
setting, lighting, mood, subjects, wardrobe, palette and details, and the
planning agents read that. The images themselves never reach the image
generator.

The Intake Producer, Visual Bible, World Builder and Art Director all receive
it. The Storyboard Artist does not — not an oversight: it already carries the
longest prompt in the app, and it reads the Visual Bible, so the look reaches it
there rather than as another directive competing for attention.

**There is no order to remember.** Generating a storyboard, or running any
canvas agent, reads the references first if they have not been read or the
images have changed since. Currency is decided by which files a reading came
from, not by a timestamp, so adding or removing an image invalidates it exactly
when it should.

You can also add references on the New Project form. They are uploaded once the
project exists, since the upload is keyed by project id.

### When a reference disagrees with your concept

The concept wins, and winning means the contested detail **never reaches the
agent at all**.

Each contradiction names the field it is about, and that whole field is dropped
from the payload — the agent writes it from the concept alone. Merely annotating
it would hand the model both values and ask it to arbitrate, which is precisely
the judgement it should not be making. Contradictions are shown on the settings
screen and again on the Agentic Canvas, so a silent withholding is never a
surprise.

Requires `OPENAI_VISION_MODEL`. Without it the reader falls back to the typed
concept and says so in an amber banner rather than pretending it looked.

### Concept fidelity check

Frames this project generated, compared against **what you originally typed**.
Press **Check against concept** and you get findings only — the image, what the
concept asks for, and what the frame actually shows.

Nothing written about these frames is fed back into the pipeline, and that is
enforced by the schema rather than by a rule: `conceptFidelitySchema` has no
palette, wardrobe, mood or lighting field to leak. A render records what the
pipeline *settled for*, not what was asked for. Describing one back into the
Visual Bible would teach each generation the last one's compromises — a scene
written as explicit and rendered as coy reads back as "intimate", and the drift
is always in the direction of less.

Because nothing in the pixels distinguishes a reference from a render, the kind
is chosen at upload and never guessed.

### How it differs from QC

Both look at rendered frames with a vision model, so the overlap is real. The
difference is the yardstick.

| | QC agent | Concept fidelity check |
|---|---|---|
| Measured against | The scene card | The typed concept |
| Scope | One scene's keyframes | Any frames, in one call |
| Catches drift in the card | No | Yes |
| Cross-scene continuity | No | Yes |
| When | Automatic, during generation | On demand |
| Output | Verdict + regeneration instructions | Findings only |

QC grades a render against its scene card. The scene card is itself written by
the Storyboard Artist *from* the concept, and can lose what you asked for before
a single pixel exists. A card written without the men in shot, rendered
faithfully, **passes QC** — correctly, because the render matches the card. The
concept is the only place the original intent survives, and nothing else in the
pipeline looks back at it.

QC also only ever sees one scene, so it cannot notice that scene 1 has three men
and scene 3 has four. Those frames are never in the same call. The fidelity
check receives them together.

Use QC to catch bad execution. Use the fidelity check to catch a plan that
drifted before rendering started.

## Regenerating only the clips

Changing a video prompt or a motion LoRA does not change the keyframes, but a
full regeneration re-renders both of them anyway — two image jobs per scene,
discarded, to arrive back where you started.

**Regenerate all video** on the Storyboard screen rebuilds every clip from the
frames already on the record. A collapsed *Regenerate video for selected scenes*
panel underneath does the same for a subset.

The frames come from each scene's chosen attempt, so a face swap or a
hand-swapped frame is what the new clip is built on.

### Continuity, and why a subset is not always a subset

The frame-chained modes — **cut** and **continue from previous end frame** —
chain keyframes, and a clip rerun does not touch those. The selection is honoured
exactly as given.

**Continue from previous clip** is different: each clip is built from the
previous scene's *rendered clip*. Rebuilding one in the middle would leave every
scene after it continuing from something that no longer exists, so the selection
is extended forward from the earliest scene you picked, and the screen says so.
Refusing outright would leave that mode with no way to do this at all; honouring
the selection literally would break the chain silently, which is worse than
either.

## Character identity

Holding one face across independently rendered scenes is the hardest part of the
pipeline, and the app uses several mechanisms that compound.

**Only the scenes they are in.** The description, the photograph and the face swap
all instruct the image model to put that person in the picture, so each applies
only to the scenes the character actually appears in. The Storyboard Artist records
who is visible in each shot; where it has not, presence is read from the scene card
by name. A scene naming nobody from the cast gets no description, no reference
image and no face swap — which is the right answer for a table of four men in a
story whose pinned character is elsewhere.

**Reference images.** Up to two per character, sent to the image model as
`image_refs` with the activating prompt-type letter. A second angle measurably
helps; two is the ceiling of the reference-capable models in use. The background
behind the subject is stripped (`remove_background_images_ref`), so the setting in
the photo does not become part of the reference — disable with
`WANGP_REMOVE_REFERENCE_BACKGROUND=false`.

A photograph conditions the **whole frame** rather than one figure in it, so on a
shot with several people the model can apply the likeness to more than one of them.
The project's Settings screen therefore offers the alternative: **description and
face swap only**, which sends no photograph, lets any image model be pinned, and
leaves the likeness to the written description corrected afterwards by the swap.
A swap targets one face in a finished frame; a reference image conditions the
entire generation, which is exactly the difference. Projects created before this
setting existed keep sending the photograph.

**Withholding the written face.** A character has an optional `facialDescription`
separate from its main description, withheld from a render prompt when a reference
image exists or when the shot does not show a face. A written face and a photograph
are competing conditioning signals, and under classifier-free guidance the text
wins — backwards, when the photo was supplied to fix the likeness. Removing those
sentences measurably improved identity in testing. Planning agents still receive
it, having no photo to work from, and the main description keeps carrying build,
hair and anything a headshot cannot show.

**Scaled to the shot.** On a close-up or tighter, a head-to-toe description is
mostly out of frame, and naming hair, jewellery and nails on a shot that cannot
show them pushes the model to widen the framing until it can. Where a character has
a reference photograph, the sheet is cut to their name and wardrobe for those shots.
Where there is none it stays whole, because then text is the only thing holding the
face together.

**Clips get names, stills get the sheet.** A start frame has nothing but its prompt
to establish a face, so the full description is appended to every image prompt. A
clip is rendered *from* that frame, which already fixes the face, wardrobe and
lighting — so the clip prompt gets the character's name and one instruction to hold
them steady. Repeating the description there spends the prompt on appearance the
model can already see, at the cost of the motion it cannot.

**Face swap.** Optional per character. After each keyframe renders, a Qwen Image
Edit pass replaces the head in the generated frame with the head from the
character's first reference image — four Lightning steps, so seconds rather than
minutes.

It is synchronous, and the ordering is the point:

```
start frame → swap → end frame (rendered against the SWAPPED start) → swap → clip
```

The end frame is conditioned on the start frame and the clip is rendered from
both, so a swap arriving afterwards would be overwritten by the frames it was
meant to correct. A failed swap keeps the original frame rather than failing the
scene.

Requires a reference image, a Qwen Image Edit model, and both face-swap LoRAs in
WanGP's `loras/qwen` folder. Only runs when exactly one character in a given scene
has it enabled — the recipe is written around a single subject, so with two there
is no way to say which face belongs where. Disable globally with
`FACE_SWAP_ENABLED=false`; change the model with `FACE_SWAP_MODEL`.

**Which shots get swapped.** The pass is unconditional once it runs: its prompt
says to replace "the head of the woman", so on a close-up of hands it grafts one
on rather than declining. Two things gate it: whether the subject is in the scene
at all, and `subjectFaceVisible` — set by the Storyboard Agent from the framing it
planned and shown as a **Face in frame** tick box. Clear it and that scene's frames
keep their originals. The manual **Swap face on** buttons are deliberately not
gated, being an explicit instruction rather than an inference.

Under `reuse_end_frame` one file is both a scene's end frame and the next scene's
start frame, so a shared frame is swapped only when **every** scene using it wants
the swap. A missing correction can be applied by hand afterwards; a face invented
in a frame nobody asked for cannot be taken back out.

A character arriving does **not** break the seam. Someone walking into shot is not
a cut, and rendering a fresh start frame with them already standing in it would be
a teleport. The seam working normally is what depicts an entrance: the start frame
is the frame before they arrive, the clip carries them in, and the end frame has
them settled — which is what the agents are told to write.

**Repairing one frame.** The flag is decided before anything is drawn, and a
render does not always match its prompt. `POST /scenes/{id}/face-swap` with
`{ "purpose": "start_frame" | "end_frame" }` — the **Swap face on** buttons on the
scene card — applies the swap to a stored frame after the fact, and `DELETE` with
`?purpose=` undoes it.

The attempt keeps `startImageSourcePath` / `endImageSourcePath`: the keyframes as
rendered, before any swap. A manual swap always works from those, so re-running
one redoes the swap instead of stacking a second head on the first, and a swap is
always reversible. What it does *not* do is touch anything already built from the
frame — the end frame, the next scene's start, the clip — which stays as it was
until regenerated.

**Scene continuity.** `reuse_end_frame` (the default) starts each scene from the
previous scene's end frame, so a corrected face propagates forward rather than
being re-synthesised per scene. It yields to a planned cut — see below.

> Face swap corrects keyframes. The clip between them is model-interpolated, so
> identity can still drift mid-motion; the endpoints of every scene are the frames
> it fixes.

## Model selection

WanGP exposes ~200 models and publishes **no quality ranking**, so automatic
selection cannot tell a general text-to-image model from an inpainting, editing,
or avatar variant. Left to itself it picked an image *editor* for keyframes and a
lip-sync avatar model for video. Pin the models you want:

```
WANGP_VIDEO_MODEL=ltx2_22B_distilled_1_1
WANGP_IMAGE_MODEL=flux_krea
WANGP_AUDIO_MODEL=stable_audio3_small
```

The resolved model is logged as `wangp.model.selected` with a `pinned` flag.

## LoRAs & trigger words

The WanGP MCP server exposes **no LoRA inventory tool**, so LoRAs are discovered by
reading WanGP's own folder. Point at it to enable the feature:

```
WANGP_LORA_ROOT=C:\path\to\wan.git\app\loras
# Optional. Defaults to the `loras_metadata` folder beside WANGP_LORA_ROOT.
WANGP_LORA_METADATA_ROOT=
```

A model is mapped to its folder by testing `base_model_type`, then `family`, then
`model_type` against the directories that actually exist. `family` is the reliable
key — `base_model_type` can disagree with it, and decoy folders exist (a model
reporting `ltx2_22B` belongs in `loras/ltx2`, not `loras/old_ltx2_22B`). Only
immediate `.safetensors` and `.sft` files are offered; `.lset` files are WanGP
presets rather than weights.

Select LoRAs for the whole storyboard in project **Settings**, or override them for
a single scene from its card on the Storyboard screen. An override *replaces* the
storyboard-wide selection rather than adding to it. Image and video LoRAs are
chosen separately, because the pinned image and video models have disjoint
catalogues.

**Trigger words.** Many LoRAs are inert unless a trained word appears in the
prompt. Where `loras_metadata/<family>/<name>.json` carries `trainedWords`, those
words are appended to the prompt at generation time — but only the ones the prompt
does not already contain, matched case-insensitively on word boundaries, and never
added to negative prompts. That keeps hand-written prompts free of duplicates. Set
`LORA_APPEND_TRIGGER_WORDS=false` to manage them yourself.

**Multi-concept LoRAs.** Trigger words are not always additive — one file can pack
several mutually exclusive behaviours selected by which word you use, so applying
them all would ask for contradictory output. The rule:

| Trigger words offered | Behaviour |
|---|---|
| One | Used automatically |
| Several | **None** used until you pick, via toggles in the LoRA panel |
| Deselected entirely | Remembered as a deliberate "none" |

Choosing several at once is allowed where a LoRA genuinely wants them together. A
choice the LoRA no longer offers is discarded rather than sent.

Sidecars come from whichever tool downloaded the LoRA, so some have none. Those
LoRAs still work; they simply show their filename and contribute no trigger words.

**Reproducibility note.** `activated_loras` is written on every job, including as
an empty list. WanGP's published default settings are its own saved UI state, so a
client that copies them — which a complete settings payload requires — otherwise
inherits whichever LoRAs were last selected in the WanGP window, and the same
project renders differently for no visible reason.

## Editing a scene

Each scene card exposes two panels.

**Scene card** — objective, story beat, visual description, action, camera and
**dialogue**. This is the text every prompt for that scene is written from, so it is
where you change *what the shot contains*. Rewriting the prompts of a card that
describes the wrong thing produces the wrong shot again, however many times you ask.
**Save and rewrite prompts** does both in one step.

Dialogue is the only source of speech in a clip: LTX speaks it word for word out of
the prompt, quoted inline in the prose the way its own model defaults do, and
nothing is synthesised separately. Roughly two words per second fills a segment at a
natural pace — about forty words for a twenty-second scene, proportionally fewer for
a shorter one — and the editor counts them for you.

**Prompts** — start frame, end frame, motion, and both negative prompts, exactly as
sent to WanGP. Edits apply to that scene only. **Regenerate these prompts** asks the
prompt agents to write that one scene again from its existing card: two model calls
rather than the whole storyboard, with the card, the other scenes and their hand
edits untouched. It still reads the scenes before it, because wardrobe carries
forward and a seam is matched against the prompt that precedes it.

Regenerating the whole storyboard rewrites every prompt. You are told how many
scenes carry hand edits before it runs, and can back out or export first.

Two mechanical repairs are offered on the Storyboard screen when they apply, and
neither runs a model: rewriting negative prompts as term lists, and rebuilding cast
sheets for scenes describing a character who is not in them. They are recorded under
their own history action, so they do not count as hand edits.

## Wardrobe

Costume is set per project rather than per character, since the same character
wears different clothes in different stories. It is a **starting** outfit, not a
constant: a change is declared on the scene where it happens and carries forward,
so you set it once.

A change can be **already done** when the scene opens — both frames show the new
outfit, and no render has to depict a garment mid-transition — or **on screen**,
which puts the old outfit in the start frame and the new one in the end frame so
the clip shows it happening. On a continuous take there is no cut for an off-screen
change to hide in, and you are warned.

Nudity is a wardrobe state rather than an outfit, because `Wearing exactly: nude`
is a sentence a model has to reconcile and the "wearing" is the part it acts on.
The Storyboard Artist records undressing as a change on its own; for storyboards
written before that, the Storyboard screen lists any scene whose action is only
possible undressed while the wardrobe still says otherwise.

People who were never pinned to the library can be dressed the same way, by the
name a prompt would use them under — "the two men". Without that they were locked
into identical clothing across a scene's two frames with no way to declare a
change, while nothing at all held their outfit steady between scenes.

## Importing a project

`Import a project file` on the Projects screen restores from a `project.json`
record, which carries everything, or a `storyboard.json` export, which carries the
scenes and prompts but no creative plans. Import always creates a new project, so
it can never overwrite one, and the result reports which plans it could not carry
and how many media files no longer exist.

## Repointing mocks at real systems

| Integration | How to enable |
|---|---|
| LLM (OpenAI) | `AI_PLANNING_ENABLED=true` + `OPENAI_API_KEY`; add the `openai` package |
| WanGP MCP | Start the WanGP MCP server, then set `WANGP_MCP_ENABLED=true` + `WANGP_MCP_URL`. `LiveWangpClient` is selected automatically |
| ffmpeg | Install ffmpeg + ffprobe, then set `FFMPEG_ENABLED=true` (override binaries with `FFMPEG_PATH` / `FFPROBE_PATH`) |
| Database | `STORYFORGE_PERSISTENCE=prisma` + `DATABASE_URL`, run migrations, add a Prisma-backed repository |

## Media playback

Generated media is served through `/api/projects/{projectId}/media/{assetId}` with
HTTP range support. Asset ids are opaque app identifiers (`scene~{sceneId}~{attemptId}~{role}`,
`rough-cut`, `final-cut`); the browser never receives a filesystem path. Every
resolved path is checked against the approved roots (`STORYFORGE_DATA_DIR` and
`WANGP_OUTPUT_DIR`) before any read, so set `WANGP_OUTPUT_DIR` to the WanGP
outputs folder or generated clips will not be servable. For a Pinokio install
that is usually `C:\pinokio\api\wan.git\app\outputs`.

## Audio

Speech is not synthesized. Dialogue and narration are performed by the video
model from each scene's prompt (WanGP's LTX-2 renders a soundtrack with the
video), so `VoiceProfile` is casting direction that shapes prompt wording rather
than a TTS configuration.

Music and SFX are generated separately as **audio cues** and mixed over the cut:

- A cue is anchored to a scene (`sceneId` + `startSeconds`) and resolved to an
  absolute timeline offset at assembly, so re-trimming or regenerating another
  scene never invalidates it.
- `duckNativeDb` is the single mixing control: `0` mixes on top of the clip's own
  audio (SFX), `-12` pushes it under a music bed, `-60` is an effective replace.
- Cues are generated through the same `wangp_generate` tool as video, routed to a
  dedicated audio model (ACE-Step, Stable Audio 3).
- Assembly runs a second pass over the rough cut with `-c:v copy`, so iterating on
  music never re-encodes picture. The un-scored rough cut is kept alongside the
  scored `final-cut.mp4`.

Only cues that are both generated and approved are mixed in.

---

## License & disclosure

StoryForgeAI is built and maintained by
**[JabAI Solutions](https://www.jabaisolutions.com/)**, an AI consulting and
development company.

Licensed under the **StoryForgeAI Community License 1.0** — see [LICENSE](LICENSE).
It is modelled on, and deliberately aligned with, the
[WanGP Community License 2.0](https://github.com/deepbeepmeep/Wan2GP/blob/main/LICENSE.txt),
because StoryForgeAI exists to drive WanGP and it would be unhelpful for the two
to grant rights on different terms.

- **Free to use, including inside a company.** Personal, hobby, research,
  educational, internal business, studio, agency and client work are all covered.
  Modify it, deploy it privately, redistribute it free of charge.
- **The video you make is yours.** Sell it, licence it, publish it. Credit is
  asked for only when you sell an Output directly — *"Made with StoryForgeAI"* is
  enough — and not for client work, internal use, or free publication.
- **You may charge for your own labour.** Installation, customisation,
  consulting, support, training and integration work are all fine, as long as you
  are not charging for access to the software itself.
- **Selling the software itself needs a conversation.** Reselling StoryForgeAI,
  white-labelling it, embedding it in a paid product, or offering paid
  API/SaaS/hosted access requires a separate written licence from JabAI
  Solutions.

> **If you commercialise a service built on this, you will likely need a
> commercial licence from the WanGP authors too.** Exposing WanGP to third
> parties for consideration is Restricted Commercialization under *their* terms,
> and complying with ours does not satisfy theirs.

StoryForgeAI integrates with WanGP/Wan2GP (by DeepBeepMeep) as a local generation
backend, subject to its own license and terms. It is an independent project, **not
affiliated with or endorsed by** the WanGP/Wan2GP project. Review the license of
each model or checkpoint used inside WanGP for commercial-use restrictions. See
the in-app **About** page for the current disclosure and feature-flag status.
