# StoryForgeAI — Architecture

This document describes the architecture of **StoryForgeAI**, a local-first,
TypeScript-first agentic creative studio for storyboard-driven video generation.

- **Style:** modular monolith (single Next.js App Router deployable) plus optional
  sidecar processes (WanGP MCP server, Deepy) reached over standard interfaces.
- **Guiding principle:** *every external integration is behind a feature flag and a
  swappable interface, so the app runs fully local with zero cloud dependencies and
  is "repointed" at real systems by configuration, not by rewriting logic.*

---

## 1. System context

```mermaid
flowchart TB
    user([Creator])

    subgraph app["StoryForgeAI (Next.js modular monolith)"]
        ui["UI surfaces"]
        api["API route handlers"]
        svc["Service layer"]
        data[("Project store")]
    end

    subgraph sidecars["Sidecars / external systems (all optional, flag-gated)"]
        openai["LLM provider<br/>(OpenAI)"]
        wangp["WanGP MCP server<br/>+ Deepy (Python)"]
        ffmpeg["ffmpeg"]
        pg[("PostgreSQL")]
    end

    user -->|HTTP| ui
    ui --> api --> svc
    svc --> data
    svc -.->|AI_PLANNING_ENABLED| openai
    svc -.->|WANGP_MCP_ENABLED| wangp
    svc -.->|native runner| ffmpeg
    data -.->|STORYFORGE_PERSISTENCE=prisma| pg

    classDef opt stroke-dasharray: 5 5;
    class openai,wangp,ffmpeg,pg opt;
```

Dashed edges are disabled by default; in demo mode each is replaced by a
deterministic in-process mock.

---

## 2. Layered architecture & module boundaries

Business logic lives only in the **service layer**. UI and route handlers stay
thin; integrations are always paired with a mock.

```mermaid
flowchart TD
    subgraph UI["UI components (app/, components/)"]
        pages["Pages: New Project, Storyboard,<br/>Agentic Canvas, Variant Review,<br/>Animatic, Generation Console, Assembly, About"]
    end

    subgraph API["API / route handlers (app/api/**)"]
        routes["Thin handlers:<br/>resolve → Zod validate → call service → JSON"]
    end

    subgraph SVC["Service layer (lib/services)"]
        psvc["project-service"]
        wsvc["wangp-service"]
        msvc["media-service"]
        asvc["assembly-service"]
    end

    subgraph CORE["Domain & adapters (lib/)"]
        agents["agents/ orchestrator + registry<br/>+ specialist agents"]
        llm["agents/llm provider<br/>(mock ↔ OpenAI)"]
        wangp["wangp/ client interface<br/>(mock ↔ live) + router + settings"]
        media["media/ ffmpeg builders<br/>+ runner (mock ↔ native)"]
        deepy["deepy/ assistant"]
        repo["db/ repository<br/>(in-memory ↔ Prisma)"]
        schemas["schemas/ Zod (trust boundaries)"]
        telemetry["telemetry/ structured logs"]
        config["config.ts feature flags"]
    end

    pages --> routes --> SVC
    psvc --> agents
    psvc --> repo
    wsvc --> wangp
    msvc --> wsvc
    msvc --> agents
    msvc --> repo
    asvc --> media
    asvc --> repo
    agents --> llm
    SVC --> schemas
    SVC --> telemetry
    CORE --> config
```

| Layer | Responsibility | Rule |
|---|---|---|
| UI components | Presentation, interaction | No data access, no business rules |
| API / route handlers | HTTP boundary, validation, delegation | Thin; validate then call a service |
| Service layer | All business logic and orchestration | Dependency-injected, testable |
| Adapters | External systems behind interfaces | Always paired with a mock |
| Cross-cutting | Config, schemas, telemetry | Imported everywhere; no upward deps |

---

## 3. Source layout

```mermaid
flowchart LR
    root["storyforge-ai/"]
    root --> app["app/ (routes + api)"]
    root --> comp["components/ (by surface)"]
    root --> lib["lib/"]
    root --> prisma["prisma/"]
    root --> scripts["scripts/ (smoke)"]
    root --> tests["tests/ (Vitest)"]
    root --> e2e["e2e/ (Playwright)"]
    root --> docs["docs/"]

    lib --> l1["config.ts · types.ts"]
    lib --> l2["schemas/"]
    lib --> l3["agents/ + agents/llm"]
    lib --> l4["services/"]
    lib --> l5["wangp/"]
    lib --> l6["media/"]
    lib --> l7["deepy/"]
    lib --> l8["db/ · telemetry/ · export/"]
```

---

## 4. Storyboard planning flow

Creating a project persists a record; generating a storyboard runs the agent
pipeline and validates the assembled snapshot against Zod before storing it.

```mermaid
sequenceDiagram
    autonumber
    actor U as Creator
    participant UI as New Project UI
    participant API as /api/projects
    participant PS as project-service
    participant OR as orchestrator
    participant AG as agents (mock ↔ LLM)
    participant DB as repository

    U->>UI: concept + duration + options
    UI->>API: POST /api/projects
    API->>PS: createProject(body)
    PS->>PS: Zod validate + computeSegmentation (20s)
    PS->>DB: store ProjectRecord (status=draft)
    API-->>UI: 201 { project }

    U->>UI: Generate storyboard
    UI->>API: POST /api/projects/{id}/generate-storyboard
    API->>PS: generateStoryboard(id)
    PS->>OR: runStoryboardOrchestrator(project, {selectedVariant})
    OR->>AG: intake → story → visual bible → storyboard → image/video prompts
    AG-->>OR: artifacts (deterministic or LLM, same shape)
    OR->>OR: storyboardSnapshotSchema.parse(...)
    OR-->>PS: StoryboardSnapshot
    PS->>DB: update (status=storyboard_ready)
    API-->>UI: ProjectRecord (scenes + prompts)
```

### Agent orchestration

Every agent has a **deterministic mock builder** and an optional **LLM path** that
must emit the same artifact shape (deterministic/AI parity). A misconfigured or
disabled provider degrades to the mock — it never breaks the request.

```mermaid
flowchart LR
    P["Project"] --> I["Intake Producer<br/>→ CreativeBrief"]
    I --> V["Variant Explorer<br/>→ 3 directions"]
    V -->|select one| S["Story Architect<br/>→ StoryPlan (1 beat/segment)"]
    S --> WB["World Builder<br/>→ WorldBible"]
    S --> DIR["Director<br/>→ DirectorialPlan"]
    S --> ART["Art Director<br/>→ ArtDirectionPlan"]
    S --> CIN["Cinematographer<br/>→ CinematographyPlan"]
    S --> VB["Visual Bible"]
    VB --> SB["Storyboard Artist<br/>→ SceneDraft[]"]
    SB --> IP["Image Prompt Agent"]
    SB --> VP["Video Prompt Agent"]
    IP --> SC["Scene[] (+prompts)"]
    VP --> SC
    SB --> AUD["Audio Director<br/>→ AudioPlan"]
    SC --> AN["Animatic plan"]
    SC --> QC["Creative Critic / QC"]

    classDef mvp fill:#1f2937,stroke:#6366f1,color:#e5e7eb;
    class I,S,VB,SB,IP,VP mvp;
```

---

## 5. WanGP media generation

Media generation is **discovery-first**: list models → pick one that supports start
frames → fetch schema/default settings → override only validated fields → submit →
poll. Each call produces a new **attempt** (retry/regeneration), then QC runs.

```mermaid
sequenceDiagram
    autonumber
    participant UI as Storyboard UI
    participant API as /scenes/{id}/generate
    participant MS as media-service
    participant WS as wangp-service
    participant WC as WangpClient (mock ↔ live)
    participant QC as QC agent
    participant DB as repository

    UI->>API: POST generate (scene)
    API->>MS: generateSceneMedia(project, scene)
    MS->>WS: buildImageManifest(start) / (end)
    WS->>WC: listModels("image") → getModelSchema → buildSettingsManifest
    MS->>WS: runToCompletion(start) / (end)
    WS->>WC: generate → getJob (poll → completed)
    MS->>WS: buildVideoManifest(imageStart, imageEnd)
    WS->>WC: generate → getJob (poll → completed)
    MS->>QC: qcAgent(scene, attempt)
    QC-->>MS: QCResult (pass/fail, severity, issues)
    MS->>DB: append attempt, set scene status
    API-->>UI: ProjectRecord (attempt + media paths + QC)
```

### WanGP job lifecycle

```mermaid
stateDiagram-v2
    [*] --> submitted
    submitted --> running: poll
    running --> completed: poll (files ready)
    submitted --> cancelled: cancel
    running --> cancelled: cancel
    running --> failed: error
    completed --> [*]
    failed --> [*]
    cancelled --> [*]
```

### Scene status lifecycle

```mermaid
stateDiagram-v2
    [*] --> planned
    planned --> generating: generate media
    generating --> generated: QC passed
    generating --> needs_review: QC flagged
    needs_review --> generating: regenerate
    generated --> approved: approve attempt
    approved --> [*]
```

---

## 6. Assembly & export

```mermaid
sequenceDiagram
    autonumber
    participant UI as Assembly UI
    participant API as /assemble
    participant AS as assembly-service
    participant FC as buildFinalCutPlan
    participant FF as FfmpegRunner (mock ↔ native)
    participant DB as repository

    UI->>API: POST assemble
    API->>AS: assembleRoughCut(project)
    AS->>FC: build plan from approved clips
    FC-->>AS: FinalCutPlan (clips, total, trim)
    AS->>FF: concat(clips, rough-cut.mp4)
    FF-->>AS: roughCutPath
    AS->>DB: store assembly (status=assembled)
    API-->>UI: ProjectRecord
    UI->>UI: Export package (storyboard.json/.md,<br/>generation-manifest, animatic-plan, final-cut-plan)
```

---

## 7. Data model

The `ProjectRecord` is the aggregate persisted per project. Enum-like fields are
`String` in the DB, constrained by union types in `lib/types.ts` (single source of
truth), not native DB enums.

```mermaid
classDiagram
    class ProjectRecord {
        Project project
        CreativeVariant[] variants
        string selectedVariantId
        WorldBible worldBible
        DirectorialPlan directorialPlan
        CinematographyPlan cinematographyPlan
        ArtDirectionPlan artDirectionPlan
        StoryboardSnapshot storyboard
        AudioPlan audioPlan
        AnimaticPlan animaticPlan
        Map~sceneId, SceneAttempt[]~ attempts
        Assembly assembly
        HistoryEntry[] history
    }
    class Project {
        string id
        string concept
        number requestedDurationSeconds
        number segmentCount
        number finalTrimSeconds
        ProjectStatus status
    }
    class StoryboardSnapshot {
        CreativeBrief brief
        VisualBible visualBible
        Scene[] scenes
    }
    class Scene {
        string id
        number sceneNumber
        number targetDurationSeconds
        number trimAtEndSeconds
        SceneStatus status
        ScenePrompts prompts
    }
    class ScenePrompts {
        string startFramePrompt
        string endFramePrompt
        string videoPrompt20s
    }
    class SceneAttempt {
        string id
        number attemptNumber
        string startImagePath
        string endImagePath
        string videoPath
        QCResult qcResult
        boolean approved
    }
    class QCResult {
        boolean passed
        number score
        string severity
    }
    class Assembly {
        FinalCutPlan plan
        string roughCutPath
    }

    ProjectRecord --> Project
    ProjectRecord --> StoryboardSnapshot
    ProjectRecord --> Assembly
    StoryboardSnapshot --> Scene
    Scene --> ScenePrompts
    ProjectRecord --> SceneAttempt
    SceneAttempt --> QCResult
```

### Project status lifecycle

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> storyboard_ready: generate storyboard
    storyboard_ready --> generating: generate scene media
    generating --> needs_review: QC flagged
    needs_review --> generating: regenerate
    generating --> assembled: assemble rough cut
    assembled --> [*]
    draft --> failed
    generating --> failed
```

---

## 8. Configuration, flags & mock strategy

A single `lib/config.ts` reads `process.env` once and exposes a typed object with a
`bool()` helper. Every integration defaults off/local so the app boots with an empty
environment.

```mermaid
flowchart LR
    env[".env / process.env"] --> config["lib/config.ts (typed)"]
    config --> flags{"feature flags"}

    flags -->|AI_PLANNING_ENABLED| llm["getPlanningProvider()<br/>null → mock builders"]
    flags -->|WANGP_MCP_ENABLED| wangp["getWangpClient()<br/>MockWangpClient (default)"]
    flags -->|native| ffmpeg["getFfmpegRunner()<br/>MockFfmpegRunner (default)"]
    flags -->|DEEPY_ASSIST_ENABLED| deepy["runDeepy()<br/>simulated when off"]
    flags -->|STORYFORGE_PERSISTENCE| repo["repository<br/>InMemory (default) ↔ Prisma"]
```

| Interface | Mock (default) | Live (flag-gated) |
|---|---|---|
| `PlanningProvider` | deterministic builders | OpenAI adapter (`AI_PLANNING_ENABLED`) |
| `WangpClient` | `MockWangpClient` | MCP client (`WANGP_MCP_ENABLED`) |
| `FfmpegRunner` | `MockFfmpegRunner` | native subprocess |
| `ProjectRepository` | in-memory | Prisma/Postgres (`STORYFORGE_PERSISTENCE=prisma`) |
| Deepy | simulated responses | live Deepy (`DEEPY_ASSIST_ENABLED`) |

---

## 9. Cross-cutting concerns

- **Validation** — Zod at every trust boundary (request bodies, external payloads,
  produced artifacts). Handlers return `{ error, details }` with the right status.
- **Telemetry** — structured JSON log lines with a named event taxonomy
  (`project.created`, `storyboard.generated`, `wangp.job.polled`, `scene.qc`,
  `assembly.completed`, …). Fire-and-forget; never throws into a request.
- **Health** — `GET /api/health` returns `200 ok`; used by the container healthcheck.
- **Null-tolerant adapters** — optional integrations return `null`/empty on failure
  and callers fall back; a misconfigured dependency degrades, never crashes.

---

## 10. Deployment

```mermaid
flowchart TB
    subgraph compose["docker-compose"]
        appc["app (Next.js standalone)<br/>node server.js · /api/health"]
        dbc[("db: postgres:16-alpine<br/>pg_isready healthcheck")]
    end
    appc -->|DATABASE_URL| dbc
    browser([Browser]) -->|:3000| appc
```

- Multi-stage `Dockerfile` (`deps` → `builder` → `runner`) emits a self-contained
  Next.js standalone image running as a non-root user with a `/api/health`
  healthcheck.
- Defaults to in-memory demo mode; set `STORYFORGE_PERSISTENCE=prisma` to use the
  bundled Postgres service.

---

## 11. Testing architecture

```mermaid
flowchart LR
    unit["Unit (Vitest)<br/>segmentation, schemas, router,<br/>settings, QC, export"]
    integ["Integration (Vitest + DI)<br/>orchestrator, canvas, media,<br/>assembly, wangp mock client"]
    comp["Component (Testing Library)<br/>forms, cards, canvas pages"]
    e2e["E2E (Playwright)<br/>storyboard, agentic canvas,<br/>generation console, media, assembly"]
    smoke["Smoke (tsx)<br/>full pipeline → assemble"]

    unit --> gate{{"Phase quality gate<br/>(all green ⇒ proceed)"}}
    integ --> gate
    comp --> gate
    e2e --> gate
    smoke --> gate
```

Every external dependency has an in-memory/mock implementation injected via DI, so
no test requires cloud credentials or a running WanGP server. Type-checking and lint
run as separate gates. See [BUILD-SUMMARY.md](BUILD-SUMMARY.md) for the
built-vs-stubbed breakdown.
