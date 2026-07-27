# StoryForgeAI — Build Summary (what was built vs. stubbed)

Built following `video-storyboard-spec.md` and governed by `generic-build-spec.md`.
TypeScript-first Next.js App Router modular monolith. Runs fully local in demo
mode with every integration behind a feature flag + swappable interface + mock.

## Implemented building blocks

- **Web/UI layer** — New Project, Storyboard Review, Agentic Canvas, Variant
  Review, Animatic Review, Generation Console, Assembly, About/Disclosure.
- **API layer** — thin route handlers under `app/api/**`, Zod-validated,
  `{ error, details }` responses.
- **Service layer** — `lib/services/*` (project, wangp, media, assembly) holds all
  business logic; UI/handlers stay thin.
- **Data layer** — swappable `ProjectRepository`; in-memory store default (demo),
  Prisma/Postgres schema scaffolded for the durable path.
- **Agent orchestration** — orchestrator + registry; six planning agents (Intake,
  Story Architect, Visual Bible, Storyboard, Image Prompt, Video Prompt) plus
  Agentic Canvas agents (Variant Explorer, World Builder, Director,
  Cinematographer, Art Director), Audio Director, and QC/Critic.
- **Deterministic/AI parity** — every agent has a deterministic mock builder and a
  null-tolerant LLM path that produces the same artifact shape.
- **WanGP MCP** — `WangpClient` interface, model router, settings-manifest builder
  (20s frame-count from FPS), job submit/poll/cancel, Generation Console.
- **Media generation** — per-scene start/end keyframes + 20s video, scene attempts
  with retry/regeneration, QC results, approval.
- **Assembly** — final-cut plan from approved clips, ffmpeg command builders,
  rough-cut assembly, export package (storyboard.json/.md, generation-manifest,
  animatic-plan, final-cut-plan).
- **Audio/animatic** — AudioPlan + VoiceProfile artifacts, animatic plan + export.
- **Audio cues** — timed music/SFX beds anchored to scenes, generated through
  WanGP audio models and mixed over the cut at assembly with per-cue gain, fades,
  and ducking of the clip's own audio. Speech is never synthesized; the video
  model performs dialogue from the scene prompt.
- **Deepy assist** — optional helper actions (inspect/extract/transcribe/suggest).
- **Ops** — `/api/health` (200 ok), structured JSON telemetry, centralized config
  with `bool()` flags, multi-stage Dockerfile + docker-compose (app + Postgres
  healthcheck).

## Mocked / stubbed (swap-ready)

- **LLM provider** — OpenAI adapter via guarded dynamic import; disabled by
  default (`AI_PLANNING_ENABLED=false`). Falls back to deterministic builders.
- **WanGP client** — `MockWangpClient` (in-memory model catalog + simulated job
  progression) is the default. `LiveWangpClient` talks to a real WanGP MCP
  server over streamable HTTP and is selected by `WANGP_MCP_ENABLED=true`.
  Field-name drift between WanGP models/versions is absorbed by
  `lib/wangp/mcp/aliases.ts` (canonical vocabulary) and
  `lib/wangp/mcp/normalize.ts` (payload mapping).
- **ffmpeg** — `MockFfmpegRunner` records the concat command and returns the
  output path. `NativeFfmpegRunner` (`FFMPEG_ENABLED=true`) shells out to ffmpeg
  and renders a real rough cut, normalizing mixed resolutions/frame rates and
  applying per-scene trims through a concat filter graph. WanGP LTX-2 clips ship
  an aac/48 kHz/stereo audio track, which is carried through the concat; clips
  without audio are padded with `anullsrc` silence so segments stay alignable.
- **Deepy** — deterministic simulated responses; `DEEPY_ASSIST_ENABLED` gates the
  real integration.
- **Persistence** — in-memory (per-process, non-durable) by default; set
  `STORYFORGE_PERSISTENCE=prisma` + `DATABASE_URL` to use Postgres.

## Active feature flags (defaults)

All off/local: `AI_PLANNING_ENABLED`, `WANGP_MCP_ENABLED`, `DEEPY_ASSIST_ENABLED`,
`ANIMATIC_ASSEMBLY_ENABLED`, `PLATFORM_DERIVATIVES_ENABLED`;
`STORYFORGE_PERSISTENCE=memory`.

## Repoint a mock at a real system

1. **LLM** — set `AI_PLANNING_ENABLED=true` + `OPENAI_API_KEY`; add the `openai`
   package. Agents automatically use the provider path.
2. **WanGP** — start the WanGP MCP server
   (`python wgp.py --mcp --mcp-transport streamable-http --mcp-host 127.0.0.1
   --mcp-port 7866`), then set `WANGP_MCP_ENABLED=true` + `WANGP_MCP_URL`.
   `lib/wangp/factory.ts` returns `LiveWangpClient` automatically.
3. **ffmpeg** — install ffmpeg + ffprobe and set `FFMPEG_ENABLED=true`
   (`FFMPEG_PATH` / `FFPROBE_PATH` override the binaries).
4. **Database** — set `STORYFORGE_PERSISTENCE=prisma` + `DATABASE_URL`, run
   `prisma migrate`, and add a Prisma-backed `ProjectRepository`.

## Quality gates (all green)

typecheck · lint · 79 unit/integration/component tests (Vitest) · 5 E2E
(Playwright) · smoke (full pipeline) · production build · `/health` → 200 ok.

> Note: the Docker image was not built in this environment; the container CMD
> (`node server.js`) is the same production server verified via `npm run start` +
> `/api/health`.
