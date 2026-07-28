# StoryForgeAI

A **local-first agentic creative studio** that turns a single video concept into a
complete storyboard and generation package. StoryForgeAI orchestrates a team of
specialized AI agents to produce a creative brief, story arc, visual bible,
20‑second scene cards, image/video prompts, WanGP generation settings, and a final
assembled cut.

It is **TypeScript-first** (Next.js App Router) and runs **fully offline in demo
mode**: every external integration (LLM, WanGP/Wan2GP MCP, ffmpeg, Deepy,
PostgreSQL) sits behind a feature flag + swappable interface + deterministic mock,
so nothing cloud is required to run, test, or demo the app.

> This application integrates with WanGP/Wan2GP as a local media generation
> backend. WanGP is developed by DeepBeepMeep and is subject to its own license and
> terms. Review the license for each model used inside WanGP, as individual models
> and checkpoints can carry separate commercial-use restrictions.

---

## Features

- **Concept → storyboard** in fixed **20‑second** segments (`segmentCount = ceil(duration / 20)`).
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
- **Media generation** — per-scene start/end keyframes + a 20s video, scene attempts
  with retry/regeneration, QC results, and human approval.
- **LoRA selection** — pick LoRAs for the whole storyboard or override them per
  scene, filtered to those installed for the pinned image/video model, with
  per-LoRA strengths. Trigger words are read from WanGP's sidecar metadata and
  appended to prompts automatically when missing.
- **Editable prompts** — every scene's start-frame, end-frame, motion and negative
  prompts can be hand-corrected without regenerating the storyboard.
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
| Web framework | Next.js 14 (App Router) + React 18 |
| Styling | Tailwind CSS |
| Validation | Zod (at every trust boundary) |
| Persistence | Swappable repository — in-memory (demo) · Prisma + PostgreSQL (durable) |
| AI orchestration | In-process orchestrator + registry; optional OpenAI adapter |
| Media backend | WanGP MCP client (mock + live) · ffmpeg (mock + native) |
| Tests | Vitest + Testing Library (unit/integration/component) · Playwright (E2E) |
| Runner | `tsx` (scripts) |
| Packaging | Multi-stage Dockerfile + docker-compose |

---

## Getting started

### Prerequisites

- Node.js 20+ (built and verified on Node 24)
- npm 10+

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
STORYFORGE_PERSISTENCE=memory        # or "prisma"
DATABASE_URL=postgresql://storyforge:storyforge@localhost:5432/storyforge
DEFAULT_SEGMENT_SECONDS=20
AI_PLANNING_ENABLED=false            # + OPENAI_API_KEY to enable the LLM path
WANGP_MCP_ENABLED=false              # + WANGP_MCP_URL to reach a live WanGP server
DEEPY_ASSIST_ENABLED=false
ANIMATIC_ASSEMBLY_ENABLED=false
PLATFORM_DERIVATIVES_ENABLED=false
```

---

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start the dev server on **port 3200** |
| `npm run dev:e2e` | Dev server on port 3100 (used by the E2E suite) |
| `npm run build` | Production build (standalone output) |
| `npm run start` | Run the production build on **port 3200** |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (`next lint`) |
| `npm test` | Vitest unit + integration + component |
| `npm run test:e2e` | Playwright E2E (boots its own dev server on 3100) |
| `npm run smoke` | `tsx` full-pipeline smoke (create → storyboard → media → assemble) |
| `npm run prisma:generate` | Generate the Prisma client |
| `npm run prisma:seed` | Idempotent demo seed |

First E2E run downloads the browser: `npx playwright install chromium`.

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
2. **Variant Review** — generate 3 directions and select one (optional).
3. **Storyboard** — generate the brief, visual bible, and 20s scene cards.
4. **Agentic Canvas** — run World Builder / Director / Cinematographer / Art
   Director / Audio Director; view artifacts, status, and decision history.
5. **Generation Console** — inspect WanGP models and job status.
6. Per scene — **Generate media** (start/end frame + 20s video), run **QC**, and
   **Approve**.
7. **Assembly** — assemble a rough cut and export the package.

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
docs/                   # Spec, approach, ARCHITECTURE.md, BUILD-SUMMARY.md
Dockerfile, docker-compose.yml
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for diagrams and design detail, and
[docs/BUILD-SUMMARY.md](docs/BUILD-SUMMARY.md) for what is implemented vs. mocked.

---

## Docker

```bash
docker compose up --build
# app on http://localhost:3200, PostgreSQL on 5432
```

The image is a multi-stage build producing a self-contained Next.js standalone
server with a `/api/health` healthcheck. It defaults to in-memory demo mode; set
`STORYFORGE_PERSISTENCE=prisma` to use the bundled Postgres service.

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

## Prompt crafting

Every WanGP prompt is built from the scene's own content — visual description,
action, story beat, camera move, and dialogue. Dialogue is quoted inline in the
prose (`Lead says, "..."`), which is the format LTX-2 expects and how spoken
audio reaches the clip; nothing is synthesized separately.

Deterministic builders always produce a complete prompt. When `AI_PLANNING_ENABLED`
is set, an LLM refines each artifact and falls back to the builder on any failure.

### Local LLM (LM Studio, Ollama, llama.cpp)
```
AI_PLANNING_ENABLED=true
OPENAI_BASE_URL=http://127.0.0.1:1234/v1
OPENAI_MODEL=<model id from the server>
OPENAI_API_KEY=lm-studio
```

JSON mode is negotiated at runtime: the provider asks for `json_object` and
falls back to plain text if the server rejects it (LM Studio accepts only
`json_schema` or `text`), recovering the payload from prose or a code fence.

Every failure is logged as `agent.llm.failed` with a reason — `json_mode_unsupported`,
`schema_mismatch`, `unparseable_json`, `request_failed`. **Watch for these.**
A silent fallback to the deterministic builder looks like success but means the
LLM contributed nothing.

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

## Editing prompts

The prompts on each scene card are editable: start frame, end frame, motion, and
both negative prompts. Edits apply to that scene only and take effect on its next
generation — useful for adding a trigger word by hand or fixing one clumsy shot.

Edits are stored in the storyboard, so what the Prompts panel shows is exactly what
is sent to WanGP. Regenerating the storyboard rewrites them, so make hand edits
once the canvas plans are settled.

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

StoryForgeAI integrates with WanGP/Wan2GP (by DeepBeepMeep) as a local generation
backend, subject to its own license and terms. Review the license of each model or
checkpoint used inside WanGP for commercial-use restrictions. See the in-app
**About** page for the current disclosure and feature-flag status.
