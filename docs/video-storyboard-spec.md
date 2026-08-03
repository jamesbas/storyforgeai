# StoryForgeAI — Build Specification

> **Historical — not maintained.** This is the original specification the app was
> built from, kept as a record of intent and still cited by section number (the
> agent prompt work refers to §9.x throughout). It is **not** a description of how
> StoryForgeAI works today, and parts of it have been deliberately superseded.
> For current behaviour see [architecture.md](architecture.md), the
> [README](../README.md), or the in-app Help page.

## 1. Product summary

Build a local-first web application that converts a simple video concept into a complete storyboard and generation package. The application should orchestrate specialized agents that create a storyboard, keyframe prompts, video prompts, model settings, and WanGP generation jobs.

The system should integrate with WanGP/Wan2GP through its MCP server and optionally support Deepy-assisted review/refinement workflows.

The main application should be TypeScript-first. WanGP and Deepy should run as Python sidecar capabilities behind the WanGP MCP interface, not as the primary application backend.

## 2. Core requirements

### 2.1 User input requirements

The initial screen must collect:

- `concept`: free-text video idea
- `requested_duration_seconds`: desired final runtime
- `aspect_ratio`: `16:9`, `9:16`, `1:1`, or custom
- `resolution_preset`: draft, standard, high
- `style`: visual style
- `tone`: emotional tone
- `audience`: target audience
- `narration_required`: boolean
- `dialogue_required`: boolean
- `music_required`: boolean
- `sfx_required`: boolean
- `reference_assets`: optional images/audio/video/brand files
- `generation_mode`: `storyboard_only`, `keyframes_only`, `video_segments`, `full_auto`
- `model_strategy`: `auto`, `prefer_wan`, `prefer_ltx`, `prefer_hunyuan`, `manual`

### 2.2 Duration requirements

All generated video scene prompts must target 20-second segments.

```ts
const SEGMENT_SECONDS = 20;
const segmentCount = Math.ceil(requestedDurationSeconds / SEGMENT_SECONDS);
const generatedDurationSeconds = segmentCount * SEGMENT_SECONDS;
const finalTrimSeconds = generatedDurationSeconds - requestedDurationSeconds;
```

Default behavior:

- Generate `segmentCount` scene cards.
- Each scene card is planned as a 20-second scene.
- If `finalTrimSeconds > 0`, mark the final scene as `trim_at_end_seconds = 20 - finalTrimSeconds` during assembly.
- Do not generate non-20-second prompts unless the user explicitly changes the segment duration in advanced settings.

### 2.3 Output requirements

For each scene, the system must produce:

- Scene title
- Timestamp range
- Scene objective
- Story beat
- Visual description
- Camera movement
- Character and continuity notes
- Start-frame image prompt
- End-frame image prompt
- Video prompt for a 20-second clip
- Negative prompt
- Suggested model and settings
- WanGP settings JSON
- Generation job IDs
- Generated media paths
- QC status
- Approved attempt

The app must support exporting:

- `storyboard.json`
- `storyboard.md`
- `generation-manifest.json`
- `final-cut-plan.json`
- Generated images/videos/audio
- Final assembled video



## 2A. Galleri5-inspired product extensions

The Galleri5 AI Studio / Agentic Canvas reference implies that this app should be framed as an **Agentic Creative Studio**, not only as a storyboard generator. The MVP can still start with storyboard + WanGP generation, but the data model and UX should leave room for these additional capabilities.

### 2A.1 Creative modes

Add `creative_mode` to the project intake:

```ts
type CreativeMode =
  | "film_short"
  | "microdrama"
  | "youtube_video"
  | "shorts_reels_tiktok"
  | "brand_ad"
  | "product_demo"
  | "educational_explainer"
  | "ai_avatar"
  | "social_campaign";
```

### 2A.2 Brand/campaign fields

When `creative_mode` is `brand_ad`, `product_demo`, or `social_campaign`, collect:

- `brand_name`
- `product_or_service`
- `campaign_objective`
- `target_buyer`
- `primary_cta`
- `brand_voice`
- `required_claims`
- `forbidden_claims`
- `logo_assets`
- `brand_colors`
- `disclaimer_text`

### 2A.3 Agentic creative team model

The app should show a visible team of agents, each responsible for a creative artifact:

| Agent | Artifact | MVP? |
|---|---|---:|
| Intake Producer | Creative brief | Yes |
| Writer / Story Architect | Narrative structure | Yes |
| World Builder | World Bible | Add now to schema; UI can be simple |
| Director | Directorial plan | Yes |
| Art Director | Art direction and visual design | Yes |
| Cinematographer | shot language and camera plan | Yes |
| Storyboard Artist | scene cards and animatic plan | Yes |
| Prompt Engineer | image/video/audio prompts | Yes |
| WanGP Producer | model/settings/job manifests | Yes |
| Audio Director | narration/music/SFX plan | Phase 2 |
| Voice / Lip-Sync Agent | dialogue, voice, lip-sync plan | Phase 2 |
| Creative Critic | review, challenge, regeneration notes | Yes |
| Platform Repurposing Agent | YouTube/Shorts/social derivatives | Phase 3 |
| Trend / Audience Agent | optional trend and audience guidance | Phase 3 |

### 2A.4 Variant exploration

Before producing the final storyboard, support multiple creative directions:

```ts
type CreativeVariant = {
  id: string;
  projectId: string;
  name: string;
  variantType: "concept" | "story" | "visual_style" | "hook" | "scene" | "platform_cut";
  summary: string;
  strengths: string[];
  risks: string[];
  selected: boolean;
  createdByAgent: string;
  createdAt: string;
};
```

Default MVP behavior:

- Generate 3 concept/story variants.
- User selects one.
- Generate the full storyboard from the selected variant.

Advanced behavior:

- Generate A/B variants for individual scenes.
- Generate multiple visual styles before committing keyframes.
- Preserve all variants in project history.

### 2A.5 Animatic stage

Add an animatic stage before full video generation.

Animatic output:

- ordered keyframes
- temporary voiceover or text captions
- rough timing
- basic transitions
- scene duration map
- optional low-res preview video assembled with ffmpeg

The animatic lets the user approve pacing and story flow before expensive WanGP video generation.

### 2A.6 Create once, scale everywhere

Add output derivatives from the same canonical storyboard:

```ts
type PlatformDerivative = {
  id: string;
  projectId: string;
  platform: "youtube_16x9" | "youtube_shorts_9x16" | "instagram_reels_9x16" | "tiktok_9x16" | "square_social_1x1" | "website_banner";
  targetDurationSeconds: number;
  aspectRatio: string;
  safeAreaRules: string[];
  captionPlan?: string;
  titleOptions: string[];
  descriptionOptions: string[];
  thumbnailPrompt?: string;
  cutPlan: string[];
  exportPath?: string;
};
```

MVP can implement this as export metadata only. Later phases can physically crop/reframe/assemble the derivative cuts.

### 2A.7 Audio, voice, and lip-sync as first-class tracks

Add separate artifacts instead of burying audio in scene notes:

```ts
type AudioPlan = {
  projectId: string;
  narrationRequired: boolean;
  dialogueRequired: boolean;
  musicRequired: boolean;
  sfxRequired: boolean;
  voiceProfiles: VoiceProfile[];
  sceneAudioCues: SceneAudioCue[];
  musicDirection?: string;
  sfxLibraryNotes?: string;
};

type VoiceProfile = {
  id: string;
  name: string;
  role: "narrator" | "character" | "host" | "announcer";
  voiceDescription: string;
  accent?: string;
  pacing?: string;
  emotion?: string;
};

type SceneAudioCue = {
  sceneId: string;
  narrationText?: string;
  dialogueLines?: DialogueLine[];
  musicCue?: string;
  sfxCues?: string[];
  lipSyncRequired: boolean;
};
```

### 2A.8 Model router

Formalize WanGP discovery into a model routing layer:

```ts
type ModelCapability = {
  modelType: string;
  provider: "wangp" | "external";
  outputs: ("image" | "video" | "audio" | "voice" | "lip_sync" | "postprocess")[];
  inputs: ("text" | "image" | "video" | "audio")[];
  supportsStartFrame: boolean;
  supportsEndFrame: boolean;
  supportsReferenceImages: boolean;
  supportsLora: boolean;
  maxFrames?: number;
  recommendedFps?: number[];
  vramProfile?: "low" | "medium" | "high";
  qualityRank?: number;
};
```

This preserves the WanGP MCP-first design while making the application ready for multi-model orchestration later.

## 3. Recommended technology stack

StoryForgeAI should use the user's reusable TypeScript full-stack blueprint as the primary application architecture.

### 3.1 Primary application stack

| Layer | Technology | Notes |
|---|---|---|
| Language | TypeScript strict | Single language for UI, route handlers, service layer, tests, schemas, and agent orchestration. |
| Web framework | Next.js App Router | Server-first rendering, route handlers, and app workflow in one project. |
| UI | React | Storyboard canvas, Agentic Canvas, scene cards, asset gallery, review screens. |
| Styling | Tailwind CSS + shadcn-style components | Fast, clean UI scaffolding. |
| Validation | Zod | Required at every trust boundary: intake, agent output, storyboard JSON, WanGP manifests, exports. |
| Persistence | Prisma + PostgreSQL | Durable project, scene, job, asset, approval, and revision state. |
| Local storage | `projects/<project-id>/...` | Stores generated media and export packages in local/dev mode. |
| Agent orchestration | TypeScript service layer | `lib/agents/` owns the orchestrator, registry, prompts, output parsing, and deterministic mocks. |
| LLM adapter | TypeScript provider adapter | Optional, feature-flagged, mockable. |
| WanGP integration | TypeScript MCP client adapter | `lib/wangp/` wraps WanGP MCP tools and provides a mock implementation. |
| Media assembly | ffmpeg via Node subprocess wrapper | Use direct subprocess calls first. Add a Python worker only if necessary. |
| Testing | Vitest + Testing Library + Playwright | Unit, integration, component, and E2E coverage. |
| Packaging | Dockerfile + docker-compose | Local Postgres and app runtime. |

### 3.2 WanGP / Deepy sidecar stack

WanGP and Deepy remain Python-based sidecar capabilities.

| Sidecar concern | Technology | Notes |
|---|---|---|
| WanGP runtime | Existing WanGP Python environment | Do not port or reimplement WanGP. |
| WanGP tool surface | WanGP MCP server over streamable HTTP | Default integration path for the web app. |
| Deepy | Existing WanGP Deepy assistant | Optional helper for inspection, extraction, transcription, merging, and guided regeneration. |
| Direct Python API | Optional future path | Use only if MCP cannot support a required workflow. |
| FastAPI worker | Not part of MVP | Add later only if direct Python media processing or in-process WanGP API access becomes necessary. |

### 3.3 Explicit stack decision

Do **not** build the MVP as a FastAPI-first application.

Recommended application pattern:

```text
Next.js / TypeScript modular monolith
  -> TypeScript WanGP MCP adapter
      -> WanGP MCP server sidecar
          -> WanGP Python runtime + Deepy
```

FastAPI may be added later as an optional media worker, but it should not own project state, storyboard state, approvals, or the main orchestration workflow.

## 4. Local architecture

```text
Browser UI
  |
  | Next.js server actions / route handlers / streaming status updates
  v
Next.js TypeScript Application
  |
  +-- UI surfaces
  |     +-- New Project / Creative Brief
  |     +-- Agentic Canvas
  |     +-- Variant Review
  |     +-- Storyboard Review
  |     +-- Generation Console
  |     +-- Asset Gallery / Export Package
  |
  +-- TypeScript service layer
  |     +-- Project service
  |     +-- Agent orchestrator
  |     +-- Agent registry
  |     +-- Approval/versioning service
  |     +-- Generation service
  |     +-- Export service
  |
  +-- Zod schemas
  +-- Prisma/PostgreSQL
  +-- Local media storage
  +-- WanGP MCP Client Adapter
  +-- ffmpeg Assembly Adapter
  |
  v
WanGP MCP Server Sidecar
  |
  v
WanGP Python runtime + Deepy + local models + galleries
```

### 4.1 Application ownership boundaries

| Concern | Owner |
|---|---|
| Project records | Next.js/TypeScript app |
| Storyboard and creative variants | Next.js/TypeScript app |
| Agent artifacts and revision history | Next.js/TypeScript app |
| Approval workflow | Next.js/TypeScript app |
| WanGP model discovery | TypeScript WanGP MCP adapter |
| Job submission and polling | TypeScript WanGP MCP adapter |
| Image/video/audio generation | WanGP Python sidecar |
| Deepy media inspection/refinement | WanGP/Deepy sidecar, invoked optionally |
| Final export metadata | Next.js/TypeScript app |
| Final video assembly | TypeScript ffmpeg adapter first; optional Python worker later |

### 4.2 Recommended folder structure

```text
storyforge-ai/
  app/
    layout.tsx
    page.tsx
    storyboard/
      page.tsx
    agentic-canvas/
      page.tsx
    generation-console/
      page.tsx
    asset-gallery/
      page.tsx
    api/
      projects/route.ts
      agents/route.ts
      variants/route.ts
      storyboard/route.ts
      wangp/route.ts
      exports/route.ts
  components/
    shell/
    intake/
    agentic-canvas/
    storyboard/
    generation-console/
    asset-gallery/
  lib/
    config.ts
    types.ts
    db/
      client.ts
      queries.ts
    agents/
      orchestrator.ts
      registry.ts
      prompts.ts
      mock-agents.ts
      provider-adapter.ts
    schemas/
      intake.ts
      storyboard.ts
      agents.ts
      wangp.ts
      exports.ts
    wangp/
      client.ts
      mock-client.ts
      model-router.ts
      types.ts
    media/
      ffmpeg.ts
      paths.ts
      assembly.ts
    telemetry/
      index.ts
  prisma/
    schema.prisma
    seed.ts
  projects/
  scripts/
  tests/
  e2e/
  docs/
    video-storyboard-approach.md
    video-storyboard-spec.md
  .vscode/
    mcp.json
```

## 5. WanGP MCP integration

### 5.1 Start WanGP MCP server

Preferred command for a local streamable HTTP MCP server:

```bash
cd <WanGP repo>
python wgp.py --mcp --config <config_dir> --output-dir <output_dir> \
  --mcp-transport streamable-http --mcp-host 127.0.0.1 --mcp-port 7866
```

Expected MCP endpoint:

```text
http://127.0.0.1:7866/mcp
```

Use `--mcp-host 0.0.0.0` only on a trusted network or behind authentication.

### 5.2 MCP tools to use

The TypeScript WanGP MCP adapter should wrap these WanGP MCP tools:

- `wangp_list_models`
- `wangp_list_model_defs`
- `wangp_get_model`
- `wangp_get_model_metadata`
- `wangp_get_model_availability`
- `wangp_list_model_availability`
- `wangp_get_default_settings`
- `wangp_get_model_schema`
- `wangp_generate`
- `wangp_get_job`
- `wangp_cancel_job`

### 5.3 WanGP model discovery flow

Before generating media:

1. Call `wangp_list_models(main_output="image")` for image/keyframe options.
2. Call `wangp_list_models(main_output="video")` for video options.
3. Filter video models by `metadata.inputs` and `metadata.media_inputs`.
4. Prefer models that support image start frames for scene continuity.
5. Fetch schema/default settings with `wangp_get_model_schema(model_type)`.
6. Start from `default_settings` and change only validated fields.
7. Submit the generation with `wangp_generate`.
8. Poll job status with `wangp_get_job`.
9. Store result paths and structured errors.

## 6. Project data model

### 6.1 Project

```ts
type Project = {
  id: string;
  title: string;
  concept: string;
  requestedDurationSeconds: number;
  segmentSeconds: 20;
  segmentCount: number;
  generatedDurationSeconds: number;
  finalTrimSeconds: number;
  aspectRatio: string;
  style: string;
  tone: string;
  audience?: string;
  status: "draft" | "storyboard_ready" | "generating" | "needs_review" | "approved" | "assembled" | "failed";
  createdAt: string;
  updatedAt: string;
};
```

### 6.2 CreativeBrief

```ts
type CreativeBrief = {
  projectId: string;
  logline: string;
  synopsis: string;
  narrativeArc: {
    beginning: string;
    middle: string;
    end: string;
  };
  visualStyle: string;
  tone: string;
  audience: string;
  constraints: string[];
};
```

### 6.3 VisualBible

```ts
type VisualBible = {
  projectId: string;
  artDirection: string;
  colorPalette: string[];
  lightingRules: string[];
  cameraStyle: string;
  characters: CharacterSpec[];
  locations: LocationSpec[];
  props: PropSpec[];
  negativeRules: string[];
};
```



### 6.3A WorldBible

```ts
type WorldBible = {
  projectId: string;
  premise: string;
  universeRules: string[];
  timelineRules: string[];
  locations: LocationSpec[];
  factionsOrGroups?: string[];
  characterRelationships: string[];
  recurringMotifs: string[];
  visualAnchors: string[];
  continuityConstraints: string[];
  forbiddenContradictions: string[];
};
```

### 6.3B DirectorialPlan

```ts
type DirectorialPlan = {
  projectId: string;
  creativeThesis: string;
  pacingStrategy: string;
  emotionalArc: string[];
  performanceDirection: string[];
  sceneIntent: Record<string, string>;
  approvalNotes: string[];
};
```

### 6.3C CinematographyPlan

```ts
type CinematographyPlan = {
  projectId: string;
  cameraLanguage: string;
  lensAndFramingRules: string[];
  movementRules: string[];
  lightingRules: string[];
  sceneShotPlans: Record<string, string>;
  transitionLanguage: string[];
};
```

### 6.3D ArtDirectionPlan

```ts
type ArtDirectionPlan = {
  projectId: string;
  productionDesign: string;
  wardrobeRules: string[];
  propRules: string[];
  setDressingRules: string[];
  typographyRules?: string[];
  productPlacementRules?: string[];
};
```

### 6.4 Scene

```ts
type Scene = {
  id: string;
  projectId: string;
  sceneNumber: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  targetDurationSeconds: 20;
  trimAtEndSeconds?: number;
  title: string;
  sceneObjective: string;
  storyBeat: string;
  visualDescription: string;
  actionDescription: string;
  cameraMovement: string;
  transitionIn: string;
  transitionOut: string;
  continuityNotes: string[];
  narrationText?: string;
  dialogue?: DialogueLine[];
  musicNotes?: string;
  sfxNotes?: string;
  status: "planned" | "ready" | "generating" | "generated" | "needs_review" | "approved" | "failed";
};
```

### 6.5 ScenePrompts

```ts
type ScenePrompts = {
  sceneId: string;
  startFramePrompt: string;
  endFramePrompt: string;
  imageNegativePrompt: string;
  videoPrompt20s: string;
  videoNegativePrompt: string;
  promptQualityChecklist: string[];
};
```

### 6.6 WanGPGenerationSettings

```ts
type WanGPGenerationSettings = {
  id: string;
  sceneId: string;
  purpose: "start_frame" | "end_frame" | "video_segment" | "audio" | "postprocess";
  modelType: string;
  settings: Record<string, unknown>;
  mcpJobId?: string;
  status: "draft" | "submitted" | "running" | "completed" | "failed" | "cancelled";
  generatedFiles: string[];
  errors: string[];
};
```

### 6.7 SceneAttempt

```ts
type SceneAttempt = {
  id: string;
  sceneId: string;
  attemptNumber: number;
  startImagePath?: string;
  endImagePath?: string;
  videoPath?: string;
  audioPath?: string;
  settingsIds: string[];
  qcResult?: QCResult;
  approved: boolean;
  createdAt: string;
};
```

## 7. API endpoints

### 7.1 Project endpoints

```http
POST /api/projects
GET /api/projects
GET /api/projects/{projectId}
PATCH /api/projects/{projectId}
DELETE /api/projects/{projectId}
```

### 7.2 Storyboard endpoints

```http
POST /api/projects/{projectId}/generate-brief
POST /api/projects/{projectId}/generate-storyboard
POST /api/projects/{projectId}/approve-storyboard
PATCH /api/projects/{projectId}/scenes/{sceneId}
```

### 7.3 Prompt endpoints

```http
POST /api/projects/{projectId}/generate-prompts
POST /api/scenes/{sceneId}/regenerate-prompts
GET /api/scenes/{sceneId}/prompts
```



### 7.3A Variant and creative-canvas endpoints

```http
POST /api/projects/{projectId}/generate-variants
GET /api/projects/{projectId}/variants
POST /api/projects/{projectId}/variants/{variantId}/select
POST /api/projects/{projectId}/generate-world-bible
POST /api/projects/{projectId}/generate-directorial-plan
POST /api/projects/{projectId}/generate-cinematography-plan
POST /api/projects/{projectId}/generate-art-direction-plan
POST /api/projects/{projectId}/generate-animatic
```

### 7.3B Audio, voice, and platform endpoints

```http
POST /api/projects/{projectId}/generate-audio-plan
POST /api/scenes/{sceneId}/generate-voice
POST /api/scenes/{sceneId}/generate-lip-sync
POST /api/projects/{projectId}/generate-platform-derivatives
GET /api/projects/{projectId}/platform-derivatives
POST /api/projects/{projectId}/export-platform-derivative/{derivativeId}
```

### 7.4 WanGP endpoints

```http
GET /api/wangp/models
GET /api/wangp/models/{modelType}/schema
POST /api/scenes/{sceneId}/generate-start-frame
POST /api/scenes/{sceneId}/generate-end-frame
POST /api/scenes/{sceneId}/generate-video
GET /api/wangp/jobs/{jobId}
POST /api/wangp/jobs/{jobId}/cancel
```

### 7.5 QC and assembly endpoints

```http
POST /api/scenes/{sceneId}/qc
POST /api/scenes/{sceneId}/approve-attempt/{attemptId}
POST /api/projects/{projectId}/assemble
GET /api/projects/{projectId}/exports
```

## 8. Agent orchestration flow

### 8.1 Full storyboard flow

```text
1. User submits creative brief form.
2. Intake Producer normalizes inputs.
3. Variant Explorer Agent creates 2-3 possible creative directions.
4. User selects a direction or asks for revisions.
5. Writer / Story Architect creates title, logline, synopsis, and narrative arc.
6. World Builder creates the World Bible.
7. Director creates the Directorial Plan.
8. Art Director and Cinematographer create visual and shot-language plans.
9. Visual Bible Agent creates reusable continuity rules.
10. Storyboard Artist creates 20-second scene cards.
11. Optional Audio Director creates narration/dialogue/music/SFX plan.
12. User reviews/edits/approves storyboard and animatic plan.
13. Image Prompt Agent creates start/end image prompts.
14. Video Prompt Agent creates 20-second WanGP-ready video prompts.
15. WanGP Settings Agent queries MCP and creates settings JSON.
16. User approves generation package.
17. Execution Agent submits WanGP jobs.
18. QC/Critic Agent reviews outputs.
19. User approves/regenerates scenes.
20. Assembly Agent creates final cut.
21. Platform Repurposing Agent creates YouTube/Shorts/social derivative plans.
```

### 8.2 Scene generation flow

```text
For each scene:
  1. Generate start-frame image.
  2. Generate end-frame image.
  3. Generate 20-second video segment.
  4. Poll job until complete.
  5. Store generated files.
  6. Run QC.
  7. Mark attempt approved or needs regeneration.
```

## 9. Agent prompt specifications

### 9.1 Intake Agent system prompt

```text
You are the Intake Agent for a video storyboard production system. Convert the user’s rough concept into a structured creative brief. Preserve the user's intent. Fill reasonable defaults when information is missing. Do not generate scene prompts yet. Return only valid JSON matching the CreativeBrief schema.
```

### 9.2 Story Architect Agent system prompt

```text
You are the Story Architect Agent. Create a complete narrative plan sized to the requested duration. The video will be generated in 20-second segments. Create a story arc that can be divided cleanly into the required number of segments. Return JSON with title, logline, synopsis, narrative arc, emotional progression, and per-segment story beat summaries.
```

### 9.3 Visual Bible Agent system prompt

```text
You are the Visual Bible Agent. Create a continuity guide that keeps all generated images and videos visually consistent. Define characters, locations, props, color palette, lighting, camera style, and negative rules. Return only valid JSON matching the VisualBible schema.
```

### 9.4 Storyboard Agent system prompt

```text
You are the Storyboard Agent. Create exactly one scene card per 20-second segment. Each scene must include scene objective, story beat, visual description, action, camera movement, transition in/out, continuity notes, and optional narration/dialogue/music/SFX notes. Do not write image prompts or video prompts yet. Return only valid JSON.
```

### 9.5 Image Prompt Agent system prompt

```text
You are the Image Prompt Agent. For each scene, create a start-frame image prompt and end-frame image prompt. The prompts must follow the Visual Bible and preserve continuity. Each image prompt must describe a single still frame with composition, subject, setting, lighting, style, and camera framing. Include a negative prompt. Return only valid JSON.
```

### 9.6 Video Prompt Agent system prompt

```text
You are the Video Prompt Agent. For each scene, create a WanGP-ready prompt for a 20-second video segment. Focus on motion, camera movement, character action, scene evolution, and what must remain consistent from the start frame. Do not waste tokens re-describing details already present in the start image unless they are continuity constraints. Include negative prompt and generation notes. Return only valid JSON.
```

### 9.7 WanGP Settings Agent system prompt

```text
You are the WanGP Settings Agent. Use WanGP MCP discovery results to select valid models and settings. Start from each model's default settings and only change fields that are supported by the schema. Prefer image-to-video models when start frames are available. Use absolute file paths for media inputs. Return valid JSON settings manifests.
```

### 9.8 QC Agent system prompt

```text
You are the QC Agent. Compare generated media against the scene card, visual bible, and prompts. Identify continuity breaks, subject drift, visual artifacts, weak motion, incorrect framing, bad text, missing actions, or audio mismatch. Return pass/fail, severity, and specific regeneration instructions.
```



### 9.9 Variant Explorer Agent system prompt

```text
You are the Variant Explorer Agent. Create 3 distinct creative directions from the same user concept. Each direction must include a title, hook, story angle, visual style, strengths, risks, and best-fit platform. Do not create the final storyboard yet. Return only valid JSON.
```

### 9.10 World Builder Agent system prompt

```text
You are the World Builder Agent. Create a World Bible for the selected creative direction. Define the universe, story rules, recurring locations, character relationships, motifs, visual anchors, and contradictions to avoid. Return only valid JSON matching the WorldBible schema.
```

### 9.11 Director Agent system prompt

```text
You are the Director Agent. Convert the selected concept and story arc into a directorial plan. Define creative thesis, pacing, emotional arc, performance guidance, and scene-level intent. Return only valid JSON matching the DirectorialPlan schema.
```

### 9.12 Cinematographer Agent system prompt

```text
You are the Cinematographer Agent. Define the visual camera language for the project. Specify shot types, lens/framing rules, camera movements, lighting approach, and transition language. Return only valid JSON matching the CinematographyPlan schema.
```

### 9.13 Art Director Agent system prompt

```text
You are the Art Director Agent. Define production design, wardrobe, props, set dressing, texture, color, typography, and brand/product placement rules. Return only valid JSON matching the ArtDirectionPlan schema.
```

### 9.14 Audio Director Agent system prompt

```text
You are the Audio Director Agent. Create a project-level audio plan covering narration, dialogue, music direction, ambient sound, SFX, and per-scene audio cues. If lip-sync is required, flag the scenes and voice profiles that need it. Return only valid JSON matching the AudioPlan schema.
```

### 9.15 Platform Repurposing Agent system prompt

```text
You are the Platform Repurposing Agent. Turn the approved storyboard and final-cut plan into derivative plans for YouTube 16:9, Shorts/Reels/TikTok 9:16, square social, thumbnails, captions, titles, and descriptions. Preserve the core story while adapting pacing, safe areas, and hooks for each platform. Return only valid JSON.
```

## 10. Prompt templates

### 10.1 Start-frame image prompt template

```text
Create a cinematic still frame for Scene {{sceneNumber}} of {{projectTitle}}.

Scene purpose: {{sceneObjective}}
Visual bible: {{visualBibleSummary}}
Characters: {{charactersInScene}}
Location: {{location}}
Composition: {{composition}}
Lighting: {{lighting}}
Camera/lens: {{cameraStyle}}
Mood: {{tone}}
Action frozen in frame: {{startMoment}}
Continuity rules: {{continuityNotes}}

The image should feel like the first frame of a 20-second video scene.
```

### 10.2 End-frame image prompt template

```text
Create a cinematic still frame for the final moment of Scene {{sceneNumber}} of {{projectTitle}}.

This image must logically follow the start frame and represent where the 20-second scene ends.
Scene outcome: {{sceneOutcome}}
Character/prop changes: {{changesFromStart}}
Composition: {{endComposition}}
Lighting: {{lighting}}
Camera/lens: {{cameraStyle}}
Continuity rules: {{continuityNotes}}

The image should feel like the last frame of a 20-second video scene and should set up the transition into Scene {{nextSceneNumber}}.
```

### 10.3 Video prompt template

```text
20-second video scene. Start from the provided start frame and preserve the subject identity, wardrobe, location, lighting style, and composition unless explicitly changed.

Scene objective: {{sceneObjective}}
Action over 20 seconds: {{actionDescription}}
Camera movement: {{cameraMovement}}
Scene evolution: {{startToEndChange}}
Mood and pacing: {{toneAndPacing}}
Continuity constraints: {{continuityNotes}}
End state target: {{endFrameDescription}}

Avoid: {{negativePrompt}}
```

## 11. WanGP settings strategy

### 11.1 Frame count

For 20-second clips, derive frame count from FPS:

```ts
videoLengthFrames = fps * 20 + 1;
```

Examples:

| FPS | 20-sec frame count |
|---:|---:|
| 12 | 241 |
| 16 | 321 |
| 24 | 481 |
| 25 | 501 |
| 30 | 601 |

Some WanGP models may have preferred frame counts or sliding-window constraints. The Settings Agent must validate against model schema and adjust according to available values.

### 11.2 Image-to-video settings shape

The final settings must be built from `wangp_get_model_schema(model_type).default_settings`.

Example conceptual settings object:

```json
{
  "model_type": "selected_i2v_model",
  "prompt": "20-second video scene prompt here",
  "negative_prompt": "negative prompt here",
  "resolution": "1280x720",
  "force_fps": 24,
  "duration_seconds": 20,
  "video_length": 481,
  "num_inference_steps": 8,
  "image_start": "C:/absolute/path/to/scene-01-start.png",
  "image_end": "C:/absolute/path/to/scene-01-end.png",
  "_api": {
    "return_media": false
  }
}
```

Important: the actual field names and allowed values must be confirmed by the selected model schema before submission.

### 11.3 Discovery-first model selection

Pseudocode:

```python
models = await wangp.list_models(main_output="video", inputs="image")

candidates = []
for model in models:
    media_inputs = model["metadata"].get("media_inputs", {})
    image_inputs = media_inputs.get("image", {})
    if image_inputs.get("start"):
        candidates.append(model)

selected = rank_models(candidates, project_preferences)
schema = await wangp.get_model_schema(selected["model_type"])
settings = schema["default_settings"]
settings.update(scene_specific_overrides)
validate_against_schema(settings, schema)
```

## 12. Deepy integration plan

Deepy should be integrated after the direct MCP workflow is working.

### 12.1 Deepy-assisted review

Add an “Ask Deepy” button to each generated scene card.

Possible actions:

- Inspect selected image
- Inspect selected video frame
- Extract final frame
- Transcribe generated audio
- Merge a quick rough preview
- Suggest why generation failed
- Create a regeneration prompt based on selected media

### 12.2 Deepy CLI mode

Deepy can be launched from CLI with:

```bash
python wgp.py --ask-deepy
```

The app should not depend on CLI Deepy for core automation. Treat CLI Deepy as a manual operator tool or future advanced integration.

## 13. File storage layout

Use a project folder per video:

```text
projects/
  <project-id>/
    project.json
    storyboard.json
    storyboard.md
    visual-bible.json
    generation-manifest.json
    scenes/
      scene-001/
        prompts.json
        settings-start-image.json
        settings-end-image.json
        settings-video.json
        attempts/
          attempt-001/
            start.png
            end.png
            video.mp4
            qc.json
          attempt-002/
            start.png
            end.png
            video.mp4
            qc.json
    assembly/
      final-cut-plan.json
      rough-cut.mp4
      final.mp4
```

## 14. UI specification

### 14.1 Page: New Project

Fields:

- Concept text area
- Duration input
- Aspect ratio dropdown
- Style dropdown/free text
- Tone dropdown/free text
- Audience input
- Narration toggle
- Dialogue toggle
- Music/SFX toggle
- Reference asset uploader
- Generation mode selector
- Create Storyboard button

### 14.2 Page: Storyboard Review

Display:

- Project title/logline/synopsis
- Duration summary
- Scene count
- Visual bible summary
- Scene cards
- Approve storyboard button
- Regenerate storyboard button
- Export storyboard button

Scene card tabs:

- Story
- Image prompts
- Video prompt
- Settings
- Generated media
- QC notes

### 14.3 Page: Generation Console

Display:

- WanGP connection status
- Available models
- Queue of pending/running/completed jobs
- Per-scene progress
- Event log
- Cancel job button
- Retry failed job button

### 14.4 Page: Assembly

Display:

- Approved clip list
- Drag/drop scene order override
- Transition choices
- Audio/narration track selection
- Final trim setting
- Assemble rough cut button
- Export final video button



### 14.5 Page: Agentic Canvas

Display a creative-team view with agent cards:

- Agent name and role
- Current artifact status
- Last output summary
- Confidence/QC status
- “View output” action
- “Regenerate” action
- “Compare variants” action where applicable

This page should make the workflow feel like a virtual production team rather than a hidden automation pipeline.

### 14.6 Page: Variant Review

Display:

- 3 creative direction cards
- Hook, story angle, visual style, strengths, risks
- Best-fit format/platform
- Select direction button
- Combine ideas button
- Regenerate variants button

### 14.7 Page: Animatic Review

Display:

- Ordered keyframes
- Temporary captions/narration
- 20-second scene timing
- Rough transition notes
- Optional low-res preview video
- Approve animatic button

### 14.8 Page: Platform Outputs

Display derivative output packages:

- YouTube 16:9
- YouTube Shorts / Reels / TikTok 9:16
- Square social
- Thumbnail concepts
- Captions/subtitles
- Titles/descriptions
- Export status

## 15. Job status lifecycle

```text
planned -> ready -> submitted -> running -> completed -> qc_pending -> approved
                                               |             |
                                               v             v
                                             failed      needs_regen
```

## 16. QC rules

A scene fails QC if:

- The generated subject does not match the visual bible.
- The action does not match the scene objective.
- The scene is visibly shorter or longer than expected.
- The end frame does not set up the next scene.
- The camera movement contradicts the prompt.
- Characters, wardrobe, location, or major props drift unexpectedly.
- There are obvious artifacts: mangled hands/faces, warping, flicker, broken text, severe blur, repeated objects.
- The output path is missing or unreadable.

QC output schema:

```ts
type QCResult = {
  passed: boolean;
  score: number;
  severity: "none" | "minor" | "major" | "critical";
  issues: string[];
  matchedRequirements: string[];
  regenerationInstructions?: string;
};
```

## 17. Assembly strategy

Use ffmpeg for MVP assembly.

Steps:

1. Normalize all approved clips to the same resolution/FPS/codec.
2. Trim final clip if needed.
3. Concatenate scene clips.
4. Add transitions only after simple concatenation works reliably.
5. Add narration/music/SFX tracks.
6. Export `rough-cut.mp4`.
7. Export final video when approved.

Example conceptual ffmpeg concat flow:

```bash
ffmpeg -f concat -safe 0 -i clips.txt -c copy rough-cut.mp4
```

If codec/resolution/FPS mismatch, transcode each clip first.

## 18. VS Code / MCP configuration

Example `.vscode/mcp.json` concept:

```json
{
  "servers": {
    "wangp": {
      "type": "http",
      "url": "http://127.0.0.1:7866/mcp"
    }
  }
}
```

Exact MCP configuration syntax may vary based on the VS Code MCP client or agent host being used. The important requirement is that the coding agent and/or app runtime can access the local WanGP MCP server.

## 19. Environment variables

```bash
# Application
NODE_ENV=development
STORYFORGE_DATA_DIR=./projects
DATABASE_URL=postgresql://storyforge:storyforge@localhost:5432/storyforge

# Story/video defaults
DEFAULT_SEGMENT_SECONDS=20
DEFAULT_ASPECT_RATIO=16:9
DEFAULT_FPS=24
DEFAULT_RESOLUTION=1280x720

# WanGP sidecar
WANGP_MCP_ENABLED=true
WANGP_MCP_URL=http://127.0.0.1:7866/mcp
WANGP_OUTPUT_DIR=<absolute-path-to-wangp-output-dir>

# AI planning agents, optional
AI_PLANNING_ENABLED=false
OPENAI_API_KEY=<optional-if-using-openai-for-planning-agents>
OPENAI_MODEL=<optional-model-name>

# Feature flags
DEEPY_ASSIST_ENABLED=false
ANIMATIC_ASSEMBLY_ENABLED=false
PLATFORM_DERIVATIVES_ENABLED=false
```

The app must boot in demo/local mode even when AI and WanGP are disabled. In that mode, use deterministic mock agents and a mocked WanGP client.


## 20. MVP acceptance criteria

The MVP is complete when:

1. A user can create a project from a single concept and duration.
2. The app calculates the correct number of 20-second scenes.
3. The app generates a complete editable storyboard.
4. The app generates start-frame, end-frame, and video prompts for every scene.
5. The app connects to WanGP MCP and lists available models.
6. The app creates WanGP settings JSON from model defaults/schema.
7. The app submits at least one start image job and one video job.
8. The app polls WanGP job status and stores output file paths.
9. The app displays generated outputs in scene cards.
10. The app exports storyboard and generation manifest files.



Additional Galleri5-inspired acceptance criteria:

11. The app generates at least 3 creative variants before final storyboard generation.
12. The app stores a World Bible, Directorial Plan, Cinematography Plan, and Art Direction Plan.
13. The app exposes an Agentic Canvas page showing the status/output of each creative agent.
14. The app can export an animatic plan before full video generation.
15. The app can generate at least one platform derivative plan, such as YouTube 16:9 plus Shorts/Reels 9:16 metadata.
16. Audio/voice/lip-sync plans are represented as structured project artifacts, even if generation is deferred to a later phase.

## 20A. Testing and quality standards

StoryForgeAI follows the testing and quality standards defined in `generic-build-spec.md` Section 6. Testing is a first-class part of every phase, not a final step. Each phase ships with its own tests and must pass its quality gate before the next phase begins.

### 20A.1 Test layers

| Layer | Tool | When it applies | What to cover |
|---|---|---|---|
| Unit | Vitest | Always | Pure logic: duration segmentation, Zod schema validation, model-router selection, prompt/settings assembly, export serialization |
| Integration | Vitest + in-memory fakes | Flows spanning services | Orchestrator + mock agents + mock WanGP client end-to-end via dependency injection |
| Component | Vitest + Testing Library + jsdom | UI with logic | New Project form, scene cards, Agentic Canvas, Variant Review, Generation Console |
| E2E | Playwright | User-facing flows | Concept → storyboard → approve → (mock) generate → export against a booted dev server |
| Smoke | `tsx` scripts | Before/after each phase | Drive the main path with seeded data and print pass/fail |

### 20A.2 Mock and fixture strategy

- Every external dependency (LLM adapter, WanGP MCP client, ffmpeg, Deepy) has a deterministic mock implementation injected via dependency injection.
- No test may require a live LLM, a running WanGP server, or cloud credentials.
- Keep unit/integration tests under `tests/` and E2E specs under `e2e/`, each with its own runner and config.

### 20A.3 Quality gates

Run these as separate gates for every phase. Type-checking is never skipped, even if lint is allowed to report without blocking:

```bash
npm run typecheck   # tsc --noEmit — must pass
npm run lint        # eslint — must run and report
npm run test        # vitest: unit + integration + component — must pass
npm run test:e2e    # playwright E2E for the phase's flows — must pass
npm run smoke       # tsx smoke script for the main path — must pass
```

- The app must expose a `/health` route handler returning `200 ok`; the WanGP MCP sidecar must expose its own health signal.
- The app must boot and pass all gates in demo/local mode with every integration feature flag disabled.

## 20B. Phase completion policy

- Each phase below lists **Build tasks**, **Tests to add**, and an **Exit gate**.
- A phase is complete only when all of its quality gates pass: `typecheck`, `lint`, unit, integration, component, and the phase's E2E/smoke checks.
- **When every gate for the current phase is green, proceed automatically to the next phase without waiting for further confirmation.**
- If any gate fails, stop and fix the failure before starting the next phase. Never skip, disable, weaken, or comment out tests to force a phase to pass.

## 21. Implementation phases

### Phase 1 — Foundation and tooling

Build tasks:

- Create Next.js App Router project using TypeScript strict
- Add Tailwind/shadcn-style UI foundation
- Configure `@/*` import alias, ESLint, Prettier, and `typecheck`/`lint`/`test`/`test:e2e`/`smoke` npm scripts
- Add centralized `lib/config.ts` with feature flags (all integrations off/local by default) and a `bool()` helper
- Add `lib/types.ts` with union-type enums as the single source of truth
- Add Zod schemas under `lib/schemas/`
- Add Prisma + PostgreSQL schema and idempotent seed data
- Add structured JSON telemetry (`lib/telemetry/`) and a `/health` route handler
- Build New Project screen and storyboard review screen
- Add JSON/Markdown export
- Add deterministic mock agents so the app works without external services

Tests to add:

- Unit: duration segmentation (segment count, generated duration, final trim), Zod intake/storyboard validation, export serialization
- Component: New Project form and scene card rendering
- E2E: create project → view storyboard → export
- Smoke: seeded project → storyboard → export prints pass

Exit gate: all quality gates green in demo mode with no external services running. When green, proceed to Phase 2.

### Phase 2 — Agent planning

Build tasks:

- Add Intake Agent
- Add Story Architect Agent
- Add Visual Bible Agent
- Add Storyboard Agent
- Add Image Prompt Agent
- Add Video Prompt Agent
- Wire the orchestrator and registry so deterministic mock agents and optional (feature-flagged) LLM agents produce the same result snapshot

Tests to add:

- Unit: each agent's output parsing and schema conformance using fixed fixtures
- Integration: orchestrator runs the full planning pipeline with mock agents via DI
- E2E: concept → generated storyboard with prompts for every scene

Exit gate: all quality gates green; the planning pipeline is reproducible with mocks. When green, proceed to Phase 2A.

### Phase 2A — Agentic Canvas extensions

Build tasks:

- Add Variant Explorer Agent
- Add World Builder Agent
- Add Director Agent
- Add Cinematographer Agent
- Add Art Director Agent
- Add Agentic Canvas page
- Add Variant Review page
- Persist all agent artifacts and decision history

Tests to add:

- Unit: WorldBible, DirectorialPlan, CinematographyPlan, ArtDirectionPlan, and CreativeVariant schema validation
- Integration: variant generation → selection → storyboard from the selected variant
- Component: Agentic Canvas and Variant Review pages
- E2E: generate 3 variants → select one → generate storyboard

Exit gate: all quality gates green; variant history is persisted and reproducible. When green, proceed to Phase 2B.

### Phase 2B — Audio and animatic planning

Build tasks:

- Add Audio Director Agent
- Add VoiceProfile and AudioPlan schemas
- Add animatic plan export
- Add optional rough animatic assembly from still frames and captions

Tests to add:

- Unit: AudioPlan, VoiceProfile, and SceneAudioCue schema validation
- Integration: animatic plan assembly and export from approved scenes
- Component: Animatic Review page

Exit gate: all quality gates green; audio and animatic artifacts validate and export. When green, proceed to Phase 3.

### Phase 3 — WanGP MCP

Build tasks:

- Add TypeScript WanGP MCP client wrapper and a parity mock client behind a feature flag
- Add model discovery
- Add schema/default settings retrieval
- Add settings manifest generation
- Add job submission and polling

Tests to add:

- Unit: model-router selection and settings-manifest building from schema defaults
- Integration: discovery → schema → manifest using the mock client
- E2E: Generation Console shows models and jobs against the mock client

Exit gate: all quality gates green against the mock client (a live WanGP server is optional and flag-gated). When green, proceed to Phase 4.

### Phase 4 — Media generation

Build tasks:

- Generate keyframes
- Generate video segments
- Display media
- Add retry/regeneration
- Add QC Agent

Tests to add:

- Unit: frame-count derivation and QCResult evaluation rules
- Integration: scene attempt lifecycle (submit → poll → store → QC) with the mock client
- E2E: approve scene → mock generate → display media

Exit gate: all quality gates green; the scene attempt lifecycle is reproducible with mocks. When green, proceed to Phase 5.

### Phase 5 — Assembly and Deepy assist

Build tasks:

- Add ffmpeg assembly
- Add final trim
- Add Deepy helper actions
- Add scene-level media inspection
- Add final export package

Tests to add:

- Unit: ffmpeg command/args builder and final-trim math
- Integration: assembly plan from approved attempts with a mock ffmpeg adapter
- Smoke: rough-cut assembly on sample clips prints pass

Exit gate: all quality gates green; a rough cut and export package are produced end-to-end with mocks. When green, proceed to Phase 6.

### Phase 6 — Hardening and release

Build tasks:

- Add multi-stage Dockerfile and docker-compose (app + PostgreSQL with a healthcheck)
- Verify `/health` endpoints, structured telemetry coverage, and feature-flag defaults
- Produce a "what was built vs stubbed" summary: implemented blocks, mocked integrations, active feature flags, and the steps to repoint each mock at a real system

Tests to add:

- Full regression sweep across all layers: typecheck, lint, unit, integration, component, E2E, smoke
- Container boots in demo mode and passes `/health`

Exit gate: the entire suite is green in a clean container in demo mode. Release candidate ready.

## 22. Recommended first build prompt for VS Code/Codex/OpenClaw

```text
Build the MVP for StoryForgeAI according to docs/video-storyboard-spec.md and use generic-build-spec.md as the governing architecture.

Start with a local-first Next.js App Router application using TypeScript strict, React, Tailwind CSS, Zod, Prisma, and PostgreSQL. Do not create a FastAPI backend for the MVP. Keep business logic in a TypeScript service layer under lib/, keep route handlers thin, and use feature flags plus mock implementations for all external integrations.

Implement project creation, duration-to-20-second-scene calculation, storyboard JSON schemas, scene card UI, variant placeholders, Agentic Canvas placeholders, and export to storyboard.json/storyboard.md. Stub the agents first with deterministic test responses, then wire the agent orchestration interfaces so LLM calls can be added later.

Do not implement WanGP generation yet in the first pass. Create a clean TypeScript WanGP MCP client interface with mocked responses for list_models, get_model_schema, generate, get_job, and cancel_job. Include unit tests for duration segmentation, Zod schema validation, model-router selection, and storyboard export.

Follow the phased build approach in Section 21 and the phase completion policy in Section 20B. Build one phase at a time, run the quality gates in Section 20A after each phase (typecheck, lint, unit, integration, component, E2E, smoke), and when all gates for a phase are green, proceed automatically to the next phase without waiting for confirmation. If any gate fails, stop and fix it before moving on.
```

## 23. Recommended second build prompt for VS Code/Codex/OpenClaw

```text
Extend the MVP to connect to a live WanGP MCP server at WANGP_MCP_URL through the TypeScript WanGP MCP adapter. Implement wangp_list_models, wangp_get_model_schema, wangp_generate, wangp_get_job, and wangp_cancel_job. Add a Generation Console page that shows MCP connection status, available image/video models, submitted jobs, progress events, generated file paths, and structured errors. Preserve project state in PostgreSQL and generated media paths under the configured local project folder.
```

## 24. Recommended third build prompt for VS Code/Codex/OpenClaw

```text
Add the media generation pipeline. For each approved scene, generate a start-frame image, end-frame image, and 20-second video segment using WanGP settings generated from model defaults and schema. Use absolute file paths for all media inputs. Store every attempt under projects/<project-id>/scenes/<scene-id>/attempts/<attempt-id>. Add scene-level retry and approval. Add storyboard.md and generation-manifest.json export.
```

## 25. Notes on licensing and disclosure

WanGP documentation says integrations should clearly disclose that they use WanGP in the product UI and documentation. Add an About/Settings page with:

```text
This application integrates with WanGP/Wan2GP as a local media generation backend. WanGP is developed by DeepBeepMeep and is subject to its own license and terms.
```

Also review licenses for each model used inside WanGP, since individual models/checkpoints can have separate commercial-use restrictions.


## 26. Recommended fourth build prompt for Agentic Canvas extensions

```text
Extend StoryForgeAI with the Galleri5-inspired Agentic Canvas workflow. Add creative_mode to project intake, generate 3 creative variants before storyboard generation, add schemas and UI for WorldBible, DirectorialPlan, CinematographyPlan, ArtDirectionPlan, and AudioPlan, and add an Agentic Canvas page that shows each agent, its artifact, status, revision history, and regenerate action. Add a Variant Review page where the user selects one creative direction before storyboard generation. Preserve the existing WanGP MCP workflow and 20-second segment rule.
```

## 27. Galleri5 reference sources reviewed

- Galleri5 home / AI Studio overview: https://www.galleri5.com/
- Galleri5 AI Studio product page: https://www.galleri5.com/ai-studio
- Galleri5 AI Studio app page: https://aistudio.galleri5.com/
- Social Samosa coverage of Agentic Canvas: https://www.socialsamosa.com/industry-updates/collective-artists-expands-galleri5-ai-studio-agentic-canvas-12053370
- Economic Times coverage of Agentic Canvas: https://economictimes.indiatimes.com/industry/media/entertainment/collective-artists-network-expands-galleri5-ai-studio-with-agentic-canvas/articleshow/131855438.cms
