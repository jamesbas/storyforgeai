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
- **Variant exploration** — generate 3 creative directions and pick one before
  committing to a storyboard.
- **Animatic** — previsualize pacing and captions before expensive video generation.
- **WanGP MCP integration** — model discovery, schema/default settings retrieval,
  settings-manifest generation, and job submit/poll/cancel.
- **Media generation** — per-scene start/end keyframes + a 20s video, scene attempts
  with retry/regeneration, QC results, and human approval.
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
# open http://localhost:3000
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
| `npm run dev` | Start the dev server |
| `npm run build` | Production build (standalone output) |
| `npm run start` | Run the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (`next lint`) |
| `npm test` | Vitest unit + integration + component |
| `npm run test:e2e` | Playwright E2E (boots the dev server) |
| `npm run smoke` | `tsx` full-pipeline smoke (create → storyboard → media → assemble) |
| `npm run prisma:generate` | Generate the Prisma client |
| `npm run prisma:seed` | Idempotent demo seed |

First E2E run downloads the browser: `npx playwright install chromium`.

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
# app on http://localhost:3000, PostgreSQL on 5432
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

## Repointing mocks at real systems

| Integration | How to enable |
|---|---|
| LLM (OpenAI) | `AI_PLANNING_ENABLED=true` + `OPENAI_API_KEY`; add the `openai` package |
| WanGP MCP | Start the WanGP MCP server, set `WANGP_MCP_ENABLED=true` + `WANGP_MCP_URL`, implement the live client in `lib/wangp/factory.ts` |
| ffmpeg | Implement a native `FfmpegRunner` and return it from `getFfmpegRunner()` |
| Database | `STORYFORGE_PERSISTENCE=prisma` + `DATABASE_URL`, run migrations, add a Prisma-backed repository |

---

## License & disclosure

StoryForgeAI integrates with WanGP/Wan2GP (by DeepBeepMeep) as a local generation
backend, subject to its own license and terms. Review the license of each model or
checkpoint used inside WanGP for commercial-use restrictions. See the in-app
**About** page for the current disclosure and feature-flag status.
