# StoryForge AI — Approach and Recommendations

## 1. Goal

Create a web application that accepts a single creative concept plus the desired final video duration, then orchestrates a set of agents to produce a complete storyboard package:

- Story outline and scene-by-scene storyboard
- Visual style guide and continuity bible
- 20-second scene plans
- Image prompts for each scene
- Start-frame and end-frame image prompts for each scene
- WanGP/Wan2GP-ready video generation prompts
- Generation settings manifests that can be submitted through the WanGP MCP server
- Review/QC notes and regeneration instructions

The application should not simply send one large prompt to a video model. It should generate a structured production plan first, then use that plan to drive image, video, audio, and post-processing steps.

## 2. Key feasibility finding

This is feasible, but the cleanest architecture is **not** to make WanGP or Deepy the entire storyboard planner. Instead:

1. Build your own web app and agent orchestration layer.
2. Use your own LLM-based agents to plan the story, storyboard, prompts, and continuity rules.
3. Use WanGP’s MCP server as the generation execution layer.
4. Use Deepy as a helpful media assistant for interactive/refinement workflows, clip inspection, transcription, frame extraction, simple multi-step media tasks, and optional offline batch work.

This separation matters because the storyboard/planning layer needs deterministic structured outputs, versioned project state, approval gates, and reproducible scene manifests. Deepy is powerful for operating WanGP, but it is better treated as a media-side assistant than as the authoritative application state manager.



## 2A. Galleri5 AI Studio / Agentic Canvas analysis and design implications

The Galleri5 AI Studio / Agentic Canvas reference changes the product framing in an important way. The goal should not be just a prompt generator for WanGP. The stronger product pattern is an **AI-native creative studio** where specialized agents behave like a small production team and guide the user from concept to finished media.

Publicly described Galleri5 capabilities include:

- AI Studio for films, shows, microdramas, social content, and ads.
- “Concept to final frame” production assistance.
- A self-serve end-to-end AI-native pipeline for creators.
- Agentic Canvas, described as a platform with 12 specialized AI agents collaborating across storytelling, writing, cinematography, art direction, world-building, critique, and production planning.
- Support for image, video, audio, voice, lip-sync, and multimodal generation through a unified creative workflow.
- A model orchestration layer for managing many AI models and creative workflows at production scale.
- A “create once, scale everywhere” concept for adapting core creative work into multiple output formats.
- Social/trends intelligence for understanding audience interest, spotting trends, and optimizing content.

### What was already covered in the original approach

The first approach already covered several core Galleri5-like capabilities:

| Galleri5-style capability | Already covered? | Notes |
|---|---:|---|
| Concept-to-storyboard workflow | Yes | Intake, story architect, storyboard, prompts, generation manifest. |
| Multi-agent production workflow | Mostly | Existing approach defined agents, but not all as creative crew roles. |
| Storyboard creation | Yes | One scene per 20-second segment. |
| Image and video prompt generation | Yes | Start frame, end frame, and 20-second video prompts. |
| Generation backend orchestration | Yes | WanGP MCP server and settings agent. |
| QC / critique | Yes | QC/Critic Agent already included. |
| Human approval gates | Yes | Storyboard, keyframe, segment, and final approval workflow. |
| Project state/versioning | Yes | Canonical app-owned state and scene attempts. |

### Capabilities that were missing or under-specified

The original version was technically solid, but it did not fully capture the broader Galleri5 product pattern. The following should be added:

1. **Agentic Canvas / creative team UX**
   - The UI should show not just scene cards, but the “creative crew” working on the project.
   - Each agent should have a visible role, output, confidence/QC status, and revision history.
   - The user should be able to branch, compare, and approve different creative directions.

2. **World-building as a first-class artifact**
   - Add a World Bible separate from the Visual Bible.
   - This should cover story universe, rules, recurring locations, character relationships, lore, motifs, visual anchors, and constraints.
   - This is especially important for episodic content, microdramas, fictional universes, and recurring AI characters.

3. **Director, Cinematographer, and Art Director agents as explicit agents**
   - The original “Visual Bible Agent” and “Video Prompt Agent” covered parts of this, but Galleri5’s framing suggests the product should make those creative roles explicit.
   - This will make the workflow easier to understand and will produce better separation of responsibilities.

4. **Creative variant exploration**
   - Galleri5 emphasizes testing many ideas rather than one.
   - The app should support generating multiple story directions, art directions, or scene prompt variants before committing.
   - The user should be able to compare “Version A / Version B / Version C” at the concept, scene, or final-cut level.

5. **Audio, voice, narration, and lip-sync as first-class workflow tracks**
   - The original approach had narration/music/SFX fields but treated them as secondary.
   - The updated approach should include an Audio Director Agent, Voice Agent, Lip-Sync Agent, and track-level export plan.
   - This matters if the system will create ads, microdramas, talking characters, explainers, or social clips.

6. **Animatics / previsualization stage**
   - Before expensive video generation, the app should create an animatic: ordered keyframes, temporary narration, timing, captions, and rough transitions.
   - This gives the user a low-cost preview of story pacing before WanGP spends time generating final video segments.

7. **Create once, scale everywhere**
   - Add platform derivative generation: YouTube 16:9, Shorts/Reels/TikTok 9:16, square social cuts, thumbnails, captions, title/description copy, and campaign stills.
   - The core storyboard should become a reusable source asset for multiple output packages.

8. **Brand/campaign mode**
   - Galleri5 covers brand videos, ads, and campaign films.
   - Add optional brand inputs: product, CTA, value proposition, target buyer, brand voice, required disclaimers, logo/reference assets, and campaign objective.

9. **Trend/audience intelligence hook**
   - Galleri5 has a Social & Trends Intelligence product. This does not need to be in the MVP, but the architecture should reserve a slot for a Trend/Audience Agent.
   - The agent could optionally ingest user-provided trend notes, social references, target platform data, or external research to influence story angles, hooks, pacing, and packaging.

10. **Model registry and routing layer**
    - The original approach used WanGP model discovery, which is good.
    - Galleri5’s “hundreds of models” framing suggests the app should formalize this as a Model Router with capability tags, cost/latency/VRAM profile, quality ranking, and task suitability.

## 2B. Updated product principle

The updated product principle should be:

> Build a local-first Agentic Creative Studio for storyboard-driven video generation. The app should behave like a compact AI production team: writer, director, world-builder, art director, cinematographer, prompt engineer, producer, critic, audio director, and distribution strategist. WanGP remains the local generation engine. Deepy remains a useful media assistant. The web app owns project state, creative decisions, versions, approvals, and exports.

This produces a stronger and more durable design than a simple storyboard generator.

## 2C. Updated technology-stack decision

Use a **TypeScript-first application architecture** for StoryForge AI, with WanGP/Deepy running as a Python-based sidecar media engine.

The previous FastAPI-first recommendation should be replaced with this stack:

| Layer | Recommended choice | Reason |
|---|---|---|
| Primary app | **Next.js App Router** | Matches the user's existing TypeScript application workflow and supports server-first UI, API routes, and co-located app logic. |
| Language | **TypeScript strict** | One shared type system for UI, route handlers, services, schemas, tests, and agent outputs. |
| UI | **React + Tailwind CSS / shadcn-style components** | Best fit for storyboard canvas, agent status boards, scene cards, asset galleries, and review workflows. |
| Validation | **Zod** | Validate intake, storyboard JSON, scene manifests, WanGP job payloads, and generated artifacts at every boundary. |
| Persistence | **Prisma + PostgreSQL** | Store projects, creative variants, agent artifacts, scene attempts, job state, generated paths, approvals, and exports. |
| Agent orchestration | **TypeScript service layer under `lib/agents/`** | Keeps planning, review, versioning, and LLM calls in the same modular-monolith architecture as the web app. |
| MCP integration | **TypeScript MCP client adapter** | The app talks to WanGP through a swappable interface and can run with mocked MCP responses during prototype development. |
| Media assembly | **ffmpeg via Node subprocess wrapper first** | Keeps MVP simple; add a Python worker only if direct Python media manipulation becomes necessary. |
| WanGP / Deepy runtime | **Python sidecar process** | WanGP is Python-native; treat it as the local generation runtime, not the primary application backend. |
| Optional Python service | **Only if needed later** | Add FastAPI only if MCP is insufficient, direct WanGP Python API integration is required, or custom Python media processing becomes substantial. |

The architectural principle is:

```text
StoryForge AI should be a TypeScript/Next.js product that delegates generation to WanGP/Deepy.
WanGP/Deepy should not own product state, storyboard state, approval state, or user workflow state.
```

This aligns with the reusable build-spec pattern: modular monolith first, sidecar processes only for external/protocol boundaries, feature-flagged integrations, mockable connectors, and durable structured outputs.

## 3. What WanGP gives you

WanGP is a strong fit as the local generation backend because it already provides:

- A web interface for generating and managing outputs
- Model support across video, image, audio, and TTS workflows
- A generation queue
- Headless mode
- A Python API
- An MCP server for agents
- Reusable settings/templates
- Prompt enhancement and media prep/post-processing tools
- Galleries for generated media
- Deepy, a local low-VRAM assistant

The most relevant capabilities for this project are:

- **MCP server**: lets an external agent or app discover models, fetch model schemas/default settings, start jobs, poll jobs, and cancel jobs.
- **Python API**: useful if you ever build a WanGP plugin or run an in-process integration.
- **Model discovery**: lets your app select image, image-to-video, text-to-video, audio, and post-processing models based on actual installed capabilities.
- **Start/end/reference image support**: important for storyboard-driven video where scene continuity is controlled through keyframes.
- **Sliding-window prompt support**: useful for longer scenes or multi-beat scene prompts.
- **Post-processing**: useful for upscaling, frame interpolation, audio remuxing, and final polish.

## 4. What Deepy gives you

Deepy can be useful in the broader workflow because it can:

- Generate images, edit images, generate video, generate talking videos, and generate speech/audio
- Inspect images and video frames
- Read local media details such as duration, dimensions, FPS, frame count, and audio tracks
- Extract images, video clips, and audio clips
- Transcribe audio/video
- Mute videos, replace audio, resize/crop media, and merge videos
- Answer WanGP-specific usage questions by searching bundled docs
- Run from the WanGP web UI or CLI

However, Deepy also has important constraints:

- It depends on Deepy being enabled in WanGP and on a supported Qwen3.5VL prompt-enhancer mode.
- It relies heavily on predefined template settings for generation tools.
- It can override only some settings directly: width, height, frame count, FPS, inference steps, LoRAs, and related basics.
- For application-grade repeatability, your own app should store the canonical storyboard, prompts, settings, generated paths, QC results, and revision history outside of Deepy.

### Recommendation on Deepy’s role

Use Deepy as an **optional helper layer**, not the core orchestrator.

Best-fit Deepy use cases:

- “Inspect this scene output and tell me if it matches the storyboard.”
- “Extract the best frame from this video as the next scene’s start frame.”
- “Transcribe this generated narration.”
- “Merge these clips for a rough preview.”
- “Use the selected image as the start frame for a short video.”
- “Regenerate this scene using the same image but different motion.”

Do not make Deepy the only source of truth for the storyboard. The web app should own the project state and invoke WanGP MCP directly for repeatable generation.

## 5. Recommended system architecture

```text
User Concept + Duration
        |
        v
Next.js / TypeScript Web App
        |
        +--> Intake UI
        +--> Agentic Canvas UI
        +--> Storyboard Review UI
        +--> Generation Console UI
        +--> Asset Gallery / Export UI
        |
        v
TypeScript Service Layer
        |
        +--> Project Orchestrator
        +--> Agent Registry
        +--> Zod Schema Validation
        +--> Approval / Versioning Services
        +--> WanGP MCP Adapter
        +--> Media Assembly Adapter
        |
        +--> Intake Producer Agent
        +--> Concept Expander Agent
        +--> Story Architect Agent
        +--> World Builder Agent
        +--> Director Agent
        +--> Art Director Agent
        +--> Cinematographer Agent
        +--> Storyboard Agent
        +--> Scene Prompt Agent
        +--> Keyframe Prompt Agent
        +--> WanGP Settings Agent
        +--> QC / Critic Agent
        +--> Assembly / Export Agent
        |
        v
Prisma + PostgreSQL + Local Media Storage
        |
        v
WanGP MCP Server Sidecar
        |
        +--> WanGP Python runtime
        +--> Deepy optional assistant workflows
        +--> Image model jobs
        +--> Image edit jobs
        +--> Image-to-video / text-to-video jobs
        +--> Audio / TTS jobs
        +--> Upscale / remux / post-processing jobs
        |
        v
Generated Images, Videos, Audio, Final Cut
```

Primary rule: **the TypeScript app owns project state and orchestration; the Python sidecar owns media generation execution.**


## 6. Duration and scene segmentation rule

The user should enter a target final video duration in seconds or minutes.

Recommended default rule:

```text
segment_duration_seconds = 20
segment_count = ceil(requested_duration_seconds / 20)
planned_duration_seconds = segment_count * 20
optional_final_trim_seconds = planned_duration_seconds - requested_duration_seconds
```

Examples:

| Requested length | Scene count | Generated duration | Final action |
|---:|---:|---:|---|
| 20 sec | 1 | 20 sec | no trim |
| 60 sec | 3 | 60 sec | no trim |
| 90 sec | 5 | 100 sec | trim final 10 sec or tell user rounded length |
| 2 min | 6 | 120 sec | no trim |
| 5 min | 15 | 300 sec | no trim |

I recommend generating all video prompts as 20-second scene prompts even when the final video target is not an exact multiple of 20 seconds. The assembly layer can either trim the final segment or ask the user whether to keep the rounded-up duration.

## 7. Initial screen design recommendation

The initial screen should behave like a “creative brief + production plan” form.

### Required inputs

- Video concept / idea
- Desired final duration
- Format/aspect ratio: 16:9, 9:16, 1:1, custom
- Output style: cinematic, Pixar-like cartoon, documentary, anime, photorealistic, product demo, podcast promo, educational explainer, etc.
- Tone: serious, playful, dramatic, inspirational, creepy, high-energy, calm
- Audience
- Narration needed: yes/no
- Dialogue needed: yes/no
- Music/SFX needed: yes/no
- Character consistency required: yes/no
- Reference images or brand assets: optional
- Target model preference: automatic, Wan, LTX, Hunyuan, Flux/Qwen for images, etc.

### Generated preview on the initial screen

After the user submits the brief, the app should display:

- Story title
- One-paragraph synopsis
- Total target duration
- Scene count
- Scene cards, one per 20-second segment
- For each scene card:
  - scene number
  - timestamp range
  - scene goal
  - visual description
  - camera movement
  - character/action notes
  - start-frame prompt
  - end-frame prompt
  - video prompt
  - negative prompt
  - selected model/settings
  - status: planned, ready, generating, generated, needs review, approved

The user should be able to approve all scenes or edit a specific scene before generation.

## 8. Agent roles

### 8.1 Intake Agent

Normalizes the user’s raw idea into a structured creative brief. It asks clarifying questions only when essential; otherwise it fills defaults.

Output:

- creative brief JSON
- target duration
- aspect ratio
- style/tone/audience
- generation constraints

### 8.2 Story Architect Agent

Turns the brief into a complete narrative arc sized to the target duration.

Output:

- title
- logline
- story synopsis
- beginning/middle/end beats
- scene count
- target emotional progression

### 8.3 Visual Bible Agent

Creates consistency rules for visual continuity.

Output:

- art direction
- color palette
- lighting rules
- character descriptions
- wardrobe/props
- location rules
- camera/lens style
- negative style rules

### 8.4 Storyboard Agent

Creates one scene per 20-second segment.

Output:

- scene cards
- scene purpose
- timestamp range
- primary visual action
- audio/narration/action notes
- transition into next scene

### 8.5 Image Prompt Agent

Creates image prompts for each scene’s starting frame and ending frame.

Output:

- start frame prompt
- end frame prompt
- image negative prompt
- optional reference prompt
- image model candidate

### 8.6 Video Prompt Agent

Creates WanGP-ready video prompts focused on motion, camera movement, action, and scene evolution.

Output:

- 20-second video prompt
- motion prompt
- camera prompt
- constraints to preserve identity/composition
- negative prompt
- recommended fps/frame count

### 8.7 WanGP Settings Agent

Queries the WanGP MCP server to discover installed models, choose the best model for each task, fetch default settings, and create valid settings JSON.

Output:

- image generation settings
- image-to-video settings
- text-to-video settings when no start image is used
- post-processing settings
- job manifest

### 8.8 WanGP Execution Agent

Submits jobs to WanGP MCP and tracks status.

Output:

- job IDs
- progress events
- generated file paths
- structured errors

### 8.9 QC / Critic Agent

Reviews generated media against the storyboard and identifies issues.

Output:

- pass/fail
- mismatch notes
- prompt improvement recommendations
- regeneration priority

### 8.10 Assembly Agent

Combines approved scene clips into the final rough cut or final render.

Output:

- ordered clip list
- transition plan
- audio/narration plan
- final export path



### 8.11 World Builder Agent

Creates the story universe and continuity rules that go beyond visual style.

Output:

- world premise
- lore/rules
- location hierarchy
- character relationships
- recurring motifs
- continuity anchors
- forbidden contradictions

### 8.12 Director Agent

Owns the creative interpretation of the project and turns the script/storyboard into a coherent directorial plan.

Output:

- creative thesis
- pacing philosophy
- performance direction
- emotional arc
- scene-level directorial intent
- approval notes for other agents

### 8.13 Cinematographer Agent

Defines shot language and camera grammar.

Output:

- shot types
- lens/framing guidance
- camera movement rules
- lighting approach
- depth of field and composition notes
- continuity requirements across adjacent shots

### 8.14 Art Director Agent

Creates visual design and set/prop direction.

Output:

- production design brief
- wardrobe/props/set dressing
- color and texture rules
- graphic/text-on-screen rules
- brand/product placement rules when applicable

### 8.15 Audio Director Agent

Plans the sound layer as a first-class component.

Output:

- narration strategy
- dialogue requirements
- music direction
- SFX list
- ambient sound bed
- per-scene audio timing

### 8.16 Voice and Lip-Sync Agent

Used when scenes require talking characters, avatars, hosts, or dialogue.

Output:

- voice character profile
- speech script
- timing map
- lip-sync generation settings
- mouth-movement QC notes

### 8.17 Variant Explorer Agent

Creates multiple creative directions before generation.

Output:

- 2-5 concept variants
- story structure variants
- art direction variants
- hook/opening variants
- recommendation with rationale

### 8.18 Platform Repurposing Agent

Implements the “create once, scale everywhere” workflow.

Output:

- YouTube cut plan
- Shorts/Reels/TikTok cut plan
- square social cut plan
- thumbnail prompts
- title/description/caption variants
- safe-area and caption placement rules

### 8.19 Trend / Audience Agent optional

Optional non-MVP agent for campaign and social content.

Output:

- target audience insight
- platform trend notes
- recommended hook style
- pacing guidance
- creative risks
- packaging recommendations

## 9. Generation strategy

### MVP generation strategy

For each 20-second segment:

1. Generate or select a start image.
2. Generate or select an end image.
3. Use the start image, end image, and video prompt to generate a 20-second video segment where supported.
4. If end-image conditioning is not supported by the selected model, use the end image as a QC target and transition target rather than hard conditioning.
5. Store all prompts, settings, and generated paths.
6. Run QC.
7. Allow scene-level regeneration.

### More advanced strategy

Use continuity chaining:

1. Generate scene 1 start and end frames.
2. Generate scene 1 video.
3. Extract the last good frame from scene 1.
4. Use that extracted frame as the start frame for scene 2.
5. Generate scene 2 end frame.
6. Generate scene 2 video.
7. Repeat until final scene.

This approach can improve continuity more than generating every scene independently.

## 10. WanGP integration recommendation

Use the MCP server as the default integration point for your VS Code/web app workflow.

Recommended local launch pattern:

```bash
python wgp.py --mcp --config <config_dir> --output-dir <output_dir> \
  --mcp-transport streamable-http --mcp-host 127.0.0.1 --mcp-port 7866
```

The web app backend should connect to:

```text
http://127.0.0.1:7866/mcp
```

Use stdio transport only for local agent clients that directly spawn the process. For a web app, streamable HTTP is easier to manage.

## 11. Recommended VS Code workflow

Use a repo structure similar to your reusable TypeScript application blueprint:

```text
storyforge-ai/
  app/                         # Next.js App Router UI + route handlers
    layout.tsx
    page.tsx
    storyboard/
    agentic-canvas/
    generation-console/
    api/
      projects/route.ts
      agents/route.ts
      wangp/route.ts
      exports/route.ts
  components/
    shell/
    storyboard/
    agentic-canvas/
    generation-console/
    asset-gallery/
  lib/
    config.ts                  # feature flags + env parsing
    types.ts                   # shared union types
    db/                        # Prisma client + queries
    agents/                    # TypeScript orchestrator + agent registry
    schemas/                   # Zod schemas for all structured artifacts
    wangp/                     # MCP client adapter + mock implementation
    media/                     # ffmpeg wrapper + path utilities
    telemetry/
  prisma/
    schema.prisma
    seed.ts
  projects/                    # local generated media/artifacts in dev mode
  mcp/                         # optional local tool/protocol utilities if needed
  scripts/
  tests/
  e2e/
  docs/
    video-storyboard-approach.md
    video-storyboard-spec.md
  .vscode/
    mcp.json                   # MCP config for local WanGP server
```

Use GitHub Copilot/Codex/OpenClaw inside VS Code to implement the app against the specification file. The MCP config should expose the WanGP MCP server to the coding agent, while the app runtime should use its own `WANGP_MCP_URL` configuration through the TypeScript WanGP adapter.

Do **not** introduce a FastAPI backend in the MVP. Add a Python API worker only if the direct MCP integration cannot support a required media-generation or media-processing workflow.


## 12. Major risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Model capability mismatch | Generated settings fail | Always call `wangp_list_models` and `wangp_get_model_schema` before building settings. |
| Long-duration continuity drift | Characters/locations change over scenes | Use a visual bible, reference images, extracted end frames, and scene chaining. |
| Deepy template limitations | Deepy may not use the exact desired model/settings | Use direct MCP calls for production jobs; use Deepy for assistant/refinement tasks. |
| GPU/VRAM limits | Slow generation or failures | Keep MVP to low-resolution drafts first; support queues; expose profile/attention settings. |
| Non-multiple duration requests | Runtime mismatch | Generate 20-second segments and trim final output, or round up with user notice. |
| Prompt inconsistency | Weak or incoherent outputs | Store reusable prompt templates and run a prompt QA agent before generation. |
| File path problems on Windows | MCP jobs cannot find assets | Use absolute paths and normalize paths in the backend. |
| Regeneration chaos | User loses track of versions | Store every scene attempt with prompt/settings/media paths and mark an approved attempt. |

## 13. MVP recommendation

Build the MVP in four milestones.

### Milestone 1 — Storyboard planner only

- Intake form
- Duration-to-scenes calculation
- Storyboard JSON generation
- Scene cards in UI
- Edit/approve scene cards
- Export storyboard package as JSON/Markdown

### Milestone 2 — WanGP discovery and settings

- Connect to WanGP MCP
- List available models
- Fetch model schema/default settings
- Generate valid settings manifests
- Save manifests per scene

### Milestone 3 — Image and video generation

- Generate start/end images
- Generate 20-second scene videos
- Poll job status
- Store generated paths
- Display outputs in scene cards

### Milestone 4 — QC and assembly

- QC agent review per scene
- Regenerate selected scene
- Extract final frame for continuity
- Assemble clips with ffmpeg
- Export final video and production package

## 14. Recommended operating model

Use a human-in-the-loop workflow first:

1. User submits concept and duration.
2. App generates storyboard and prompts.
3. User approves or edits storyboard.
4. App generates keyframes.
5. User approves keyframes.
6. App generates video segments.
7. QC agent flags issues.
8. User approves/regenerates scenes.
9. App assembles final video.

After that is reliable, add a “fully automatic” mode.

## 15. Bottom-line recommendation

Proceed with this architecture.

The concept is feasible, but the durable design is a **TypeScript-first project-based storyboard orchestrator** that uses WanGP as the generation engine and Deepy as an assistant/refinement capability. The Next.js application should own all structured state, scene versioning, prompts, settings, generated media paths, approvals, exports, and user workflow. WanGP MCP should be used for reliable model discovery and generation execution. Deepy should be integrated later as an optional “Ask Deepy about this scene” capability or as a batch helper for media inspection, extraction, transcription, merging, and regeneration guidance.

The final architecture recommendation is: **Next.js + TypeScript + Zod + Prisma/PostgreSQL as the main app, with WanGP/Deepy as a Python MCP sidecar.**

## Sources reviewed

### Galleri5 AI Studio / Agentic Canvas references

- Galleri5 home / AI Studio overview: https://www.galleri5.com/
- Galleri5 AI Studio product page: https://www.galleri5.com/ai-studio
- Galleri5 AI Studio app page: https://aistudio.galleri5.com/
- Social Samosa coverage of Agentic Canvas: https://www.socialsamosa.com/industry-updates/collective-artists-expands-galleri5-ai-studio-agentic-canvas-12053370
- Economic Times coverage of Agentic Canvas: https://economictimes.indiatimes.com/industry/media/entertainment/collective-artists-network-expands-galleri5-ai-studio-with-agentic-canvas/articleshow/131855438.cms


- WanGP repository: https://github.com/deepbeepmeep/Wan2GP/
- WanGP API documentation: https://github.com/deepbeepmeep/Wan2GP/blob/main/docs/API.md
- WanGP prompt documentation: https://github.com/deepbeepmeep/Wan2GP/blob/main/docs/PROMPTS.md
- Deepy documentation: https://github.com/deepbeepmeep/Wan2GP/blob/main/docs/DEEPY.md
- WanGP agent skill: https://github.com/deepbeepmeep/Wan2GP/blob/main/wangp-agent/SKILL.md
