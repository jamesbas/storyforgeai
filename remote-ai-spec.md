# Remote (Cloud) AI Models — Feasibility Assessment

Assessment date: 2026-09-20
Assessed against: StoryForgeAI `APP_VERSION` 2.51
Status: **Assessment only — no code has been changed.**

---

## 1. Summary and verdict

The request is to let a user choose **local** or **cloud** generation independently for
three areas — LLM (agentic canvas + prompt generation), image generation, and video
generation — so a project can mix them freely.

**Verdict: feasible, but the three areas are nowhere near equal in cost.**

| Area | Verdict | Effort | Why |
| --- | --- | --- | --- |
| **LLM** | Already 90% there | **Small** (~2–3 days) | The provider already speaks OpenAI chat-completions and already accepts an arbitrary `OPENAI_BASE_URL`. Pointing it at OpenAI/OpenRouter/Groq works *today* by editing `.env.local`. What is missing is per-area routing and UI, not protocol work. |
| **Image** | Feasible, real work | **Large** (~2–3 weeks) | The whole manifest pipeline is built on WanGP schema discovery and local filesystem paths. A cloud adapter must synthesise a schema and move bytes in both directions. |
| **Video** | Feasible, hardest | **Large** (~2–3 weeks, overlapping image) | Everything in the image row, plus long-running async jobs, audio-bearing output, start/end-frame conditioning that most cloud APIs do not offer, and per-clip costs measured in dollars. |

The single biggest risk is **not technical** — see §5. It is that this application has
first-class support for explicit adult content, and every mainstream cloud provider
forbids it.

### The one-line architectural answer

The codebase has an unusually clean seam for this. `WangpClient`
([lib/wangp/client.ts](./lib/wangp/client.ts)) is an interface with exactly two
implementations, selected by a single factory
([lib/wangp/factory.ts](./lib/wangp/factory.ts#L13)), and `getWangpClient()` is called
in only **four** files. Implementing cloud backends *as additional `WangpClient`
implementations* — rather than as a parallel pipeline — is what keeps this project
from becoming a rewrite.

---

## 2. Requirements, as agreed

These were confirmed with the operator before this assessment was written, and the
design below assumes them.

| # | Decision |
| --- | --- |
| R-1 | **Providers:** aggregator first (fal.ai or Replicate — one adapter, many models), with direct first-party APIs (OpenAI Images, Google Veo, Runway, Luma, Kling) as later adapters. |
| R-2 | **Cloud LLM scope:** OpenAI-compatible endpoints only (OpenAI, OpenRouter, Azure OpenAI, Groq). No native Anthropic or Gemini adapters. |
| R-3 | **Audio is not a fourth area.** Audio arrives as part of the video model's output (as LTX-2 does today). A cloud video model that returns a silent clip is therefore a **regression**, not a neutral trade — see RISK-7. |
| R-4 | **Secrets:** API keys live in `.env.local` only. The settings page selects providers and models but **never stores a secret**. |
| R-5 | **Scope of choice:** app-wide default in Settings, overridable per project — matching how model pins already work. |
| R-6 | **Unsupported features:** when a cloud backend is selected, WanGP-only features (LoRA stacks, face swap, step counts, spatial upsampling, sliding windows) are **hidden with a clear explanation**, and continue to work fully on local. |

---

## 3. What the code does today

### 3.1 The LLM path is already provider-agnostic

`getPlanningProvider()`
([lib/agents/llm/provider.ts:468](./lib/agents/llm/provider.ts#L468)) returns a provider
when two conditions hold:

- `config.flags.aiPlanning` is true (`AI_PLANNING_ENABLED`), and
- at least one of `config.openai.apiKey` / `config.openai.baseUrl` is set.

The provider it builds is OpenAI-compatible, loading the `openai` npm SDK through a
guarded dynamic import, and it already names itself `"openai"` or `"openai-compatible"`
depending on whether a base URL is present. **That means cloud LLM already works** —
set `OPENAI_API_KEY` and leave `OPENAI_BASE_URL` empty and the app talks to OpenAI.

What exists and helps:

- **Provenance already records the provider.** `ProviderResult<T>` carries
  `provider`, `model` and `format`
  ([lib/agents/llm/provider.ts:13](./lib/agents/llm/provider.ts#L13)), and
  `executeArtifact()` writes all three onto the artifact
  ([lib/agents/provenance.ts:76](./lib/agents/provenance.ts#L76)). An artifact can
  already say which cloud model produced it, with no schema change.
- **A response-format negotiation ladder** (`json_schema` → `json_object` → `text`)
  already exists to cope with servers of differing capability
  ([lib/agents/llm/provider.ts:176](./lib/agents/llm/provider.ts#L176)). Cloud APIs sit
  at the *capable* end of that ladder, so this is a problem that solves itself.
- **Centralised system-prompt injection** via `resolveSystemPrompt()`
  ([lib/agents/llm/system-prompt.ts](./lib/agents/llm/system-prompt.ts)) with three
  scopes: `agenticCanvas`, `storyboard`, `renderPrompts`.

What exists and hurts:

- **One provider per process.** ~12 agent modules reach the provider (intake, story
  architect, visual bible, storyboard, prompt agents, QC, concept reader/enhancer/
  fidelity, audio agents, segment gaps, canvas agents) and all of them get the same
  configuration. There is no per-area routing, so "cloud for canvas, local for prompt
  generation" is not expressible today.
- **Local-only assumptions baked in:**
  - `enqueuePlanning()` serialises *all* planning calls when a base URL is set
    ([lib/agents/llm/provider.ts:452](./lib/agents/llm/provider.ts#L452)), because a
    local server handles one request at a time. Against a cloud API this is pure
    latency — an agentic canvas run that could fan out runs strictly sequentially.
  - `apiKey: config.openai.apiKey || "local"` — a placeholder key for local servers
    that ignore it.
  - Defaults tuned for local: `OPENAI_MAX_TOKENS` 12,000 and `OPENAI_TIMEOUT_MS`
    240,000 (4 minutes). Generous locally; expensive and slow to fail in the cloud.
  - `maxRetries: 1`, and **no rate-limit or cost handling anywhere**.
- **LM Studio VRAM lifecycle.** `llm-runtime-service.ts` shells out to the `lms` CLI to
  load/unload the planning model so the LLM and the diffusion model do not fight over
  the GPU, and `LLM_UNLOAD_BEFORE_BATCH` evicts it before a batch run. `config.llmRuntime.enabled`
  is already gated on `OPENAI_BASE_URL` being set ([lib/config.ts:193](./lib/config.ts#L193)),
  so it half-disables itself for cloud — but the logic needs to become explicitly
  backend-aware, and there is a genuine **win** here: with a cloud LLM there is no VRAM
  contention at all, so the unload/reload dance disappears and batch runs get faster.

### 3.2 The media path is deeply WanGP-shaped

`WangpClient` ([lib/wangp/client.ts](./lib/wangp/client.ts)) is small and clean:

```ts
listModels(mainOutput?: "image" | "video" | "audio"): Promise<WangpModel[]>;
getModelSchema(modelType: string): Promise<WangpModelSchema>;
generate(settings: Record<string, unknown>): Promise<WangpJob>;
getJob(jobId: string): Promise<WangpJob>;
cancelJob(jobId: string): Promise<WangpJob>;
health(): Promise<boolean>;
```

But what sits *above* it assumes WanGP's semantics throughout. `buildVideoManifest()`
([lib/services/wangp-service.ts:483](./lib/services/wangp-service.ts#L483)) and
`buildImageManifest()` ([lib/services/wangp-service.ts:825](./lib/services/wangp-service.ts#L825))
both follow the same discovery-first recipe: list models → pick one → **fetch its
schema** → override only fields the schema declares
(`buildSettingsManifest`, [lib/wangp/settings.ts:209](./lib/wangp/settings.ts#L209)).

Five structural facts drive the whole design below.

**Fact 1 — everything is a local filesystem path, in both directions.**

Outputs: `WangpJob.generatedFiles` is `z.array(z.string())`
([lib/schemas/wangp.ts:94](./lib/schemas/wangp.ts#L94)) and consumers index it
directly and treat the result as a path on disk:

```ts
const job = await runToCompletion(manifest.settings);
const rendered = job.generatedFiles[0];          // media-service.ts:759-760
```

Inputs are the same, and are opened *by the WanGP process itself*. From
[lib/wangp/settings.ts:24](./lib/wangp/settings.ts#L24):

> Reference images for identity conditioning (WanGP `image_refs`). **Absolute paths
> readable by the WanGP process.** Verified against a live server: WanGP opens each
> path and fails the job with `[Errno 2]` if it is [missing].

and for `video_source` ([settings.ts:48](./lib/wangp/settings.ts#L48)): "Absolute path
readable by the WanGP process; it is ffprobed on submission."

A cloud API can do neither. It needs **uploaded bytes or a public URL** going in, and it
returns a **signed HTTPS URL** coming out. This is the single largest piece of new work.

**Fact 2 — served media must sit inside an approved root.**
`approvedMediaRoots()` returns `[config.dataDir, config.wangp.outputDir]`
([lib/media/path-policy.ts:36](./lib/media/path-policy.ts#L36)), and every streaming
route proves containment both lexically and through `realpath`. Downloaded cloud output
must therefore land **inside `config.dataDir`**, or the UI will refuse to display it.
Handled correctly, this needs no policy change at all — which is the desirable outcome,
since the policy is a security control.

**Fact 3 — schema discovery has no cloud equivalent.** The following all read the WanGP
model schema and would have nothing to read for a cloud model: allowed resolutions
(`resolutionFor`, [wangp-service.ts:639](./lib/services/wangp-service.ts#L639)), step
counts (`stepsFor`, [:668](./lib/services/wangp-service.ts#L668)), whether a negative
prompt is accepted (`declaresNegativePrompt`, [:207](./lib/services/wangp-service.ts#L207)),
LoRA capability, reference-image capacity (`referenceImageCapacity`,
[model-router.ts:51](./lib/wangp/model-router.ts#L51)), and model-family routing for
H3/MiniMax, LTX-2, Flux, Qwen and Krea.

**Fact 4 — a global single-job queue.** `enqueue()`
([wangp-service.ts:727](./lib/services/wangp-service.ts#L727)) serialises every
submission because "WanGP holds a single generation session". A cloud provider has no
such limit and can render scenes in parallel — a **large latency win**, but only if the
queue is made backend-aware rather than global.

**Fact 5 — the capability schema already anticipated this.**
`modelCapabilitySchema` has `provider: z.enum(["wangp", "external"])`
([lib/schemas/wangp.ts:102](./lib/schemas/wangp.ts#L102)). The concept of a non-WanGP
provider was designed for, even if nothing implements it.

### 3.3 There is a proven pattern for runtime-editable settings

Two features already do exactly what R-4/R-5 need, and they share one shape:

| Layer | Generation defaults | System prompts |
| --- | --- | --- |
| Schema | [lib/schemas/generation-defaults.ts](./lib/schemas/generation-defaults.ts) | `lib/schemas/system-prompt-settings.ts` |
| Store | [lib/db/generation-defaults-store.ts](./lib/db/generation-defaults-store.ts) | `lib/db/system-prompt-settings-store.ts` |
| Service | `lib/services/generation-defaults-service.ts` | `lib/services/system-prompt-settings-service.ts` |
| Route | `app/api/settings/generation-defaults/route.ts` | `app/api/settings/system-prompts/route.ts` |
| UI | [components/settings/generation-defaults.tsx](./components/settings/generation-defaults.tsx) | `components/settings/system-prompt-settings.tsx` |

Each is a single versioned JSON file under the data directory, read through a
never-throws `get()` that falls back to an empty record, and written under a global
promise lock so concurrent route handlers cannot clobber each other. The settings page
([app/settings/page.tsx](./app/settings/page.tsx)) is simply a stack of
`<CollapsibleSection>` components.

**The new remote-AI settings section should be a fourth instance of this exact pattern.**
No new infrastructure is required.

---

## 4. Feasibility by area

### 4.1 LLM — small

Work required:

1. Introduce per-area backend selection (see §6.3). The provider factory becomes
   `getPlanningProvider(area)` where area is roughly the existing system-prompt scopes.
2. Add a second set of connection settings so local and cloud can be configured
   *simultaneously* — today there is one `OPENAI_*` block, and mixing requires editing
   env and restarting. This is the only real code change: a `resolveLlmConnection(area)`
   returning `{ apiKey, baseUrl, model, visionModel, … }`.
3. Make `enqueuePlanning()` conditional on the resolved connection being local.
4. Make `llmRuntime.enabled` conditional on *any* area still resolving to local.
5. Add cost-awareness: retry-with-backoff on HTTP 429, and surface token usage.

Nothing about the prompts, the schemas, the JSON-extraction fallbacks, the vision
pathway or the provenance recording has to change. This is genuinely the easy one.

### 4.2 Image — large

Beyond the shared adapter work in §6.4, image-specific issues:

- **Reference images are the app's identity mechanism.** `image_refs` carries the
  character library's photographs, and `buildImageManifest` *throws* when references are
  requested but the model cannot take them
  ([wangp-service.ts:862](./lib/services/wangp-service.ts#L862)). A cloud image model
  must support reference/identity input or the character library silently stops working.
  Aggregator-hosted Flux Kontext / Qwen Image Edit endpoints do; plain text-to-image
  endpoints do not. **The adapter must declare this capability honestly** so the existing
  guard keeps firing.
- **Face swap is a second WanGP round-trip** on every keyframe
  ([face-swap-service.ts](./lib/services/face-swap-service.ts)) using a matched set of
  Qwen/Krea checkpoints and LoRA pairs. Per R-6 this is hidden for cloud image backends.
  Note the interaction: a project whose characters rely on face swap for likeness will
  look *worse* on cloud, not merely different.
- **`END_FRAME_REFERENCES_START_FRAME`** (on by default) renders the end frame with the
  start frame as a reference to hold wardrobe steady. This needs the cloud model to
  accept an arbitrary image reference, not just a character portrait.

### 4.3 Video — large, and the riskiest

- **Start/end-frame conditioning is the core of the storyboard model.** StoryForge
  renders two keyframes and asks the video model to move between them. Many cloud video
  APIs offer first-frame only; fewer offer last-frame; `continue_video` (used for
  `continue_video` continuity) is rarer still. **A cloud video adapter that supports only
  a first frame changes what the product is** — scenes stop landing on their designed end
  frame. This must be surfaced in the UI, not discovered in the output.
- **Audio (R-3).** Today LTX-2 returns a video *with* an audio track, and
  `videoModelsWithAudio()` ([model-router.ts:175](./lib/wangp/model-router.ts#L175))
  exists to find such models. A cloud model returning silent video breaks the operator's
  actual workflow. The adapter's capability descriptor must carry `supportsAudioOutput`
  and the UI must warn when a selected cloud video model lacks it.
- **Duration and clip length.** `DEFAULT_SEGMENT_SECONDS` is 20; most cloud video APIs
  cap at 5–10 seconds per generation. A 20-second segment may need stitching, or the
  segment length must be clamped per backend — the latter is far simpler and should be
  a hard constraint published by the adapter.
- **Cost.** Sliding-window 20-second clips across an 18-scene project is a large number
  of cloud video seconds. A pre-flight cost estimate is not a nicety here; see RISK-5.

---

## 5. The dominant risk: content policy

This deserves its own section because it can invalidate the feature for this
application's primary use case regardless of how well the code is written.

StoryForge has **deliberate, first-class support for explicit adult content**:

- [lib/agents/explicitness.ts](./lib/agents/explicitness.ts) detects explicit projects
  and scenes and injects `explicitnessDirective()` telling the model that "this project
  is made for adults and its sexual content is meant to be shown rather than" implied.
- There is an `/api/projects/[projectId]/undressed-scenes` route, wardrobe authority
  logic, and tests (`explicit-prompts.test.ts`, `garment-authority.test.ts`).

Every provider named in R-1 — OpenAI, Google, Runway, Luma, Kling, and both fal.ai and
Replicate for hosted endpoints — prohibits sexual content in their usage policies.
Consequences:

1. **Requests will be refused**, often after being billed, and often with an unhelpful
   error. Refusals will also come from the *LLM* side: a cloud LLM will decline to write
   the prompts, which means the agentic canvas fails rather than the renderer.
2. **Account termination is a real outcome**, not a theoretical one.
3. The failure is **silent-ish and confusing**: a moderation refusal surfaces as a failed
   job, and the operator will reasonably read that as a bug.

**This does not block the feature** — plenty of projects are not explicit, and cloud
backends are genuinely attractive for those. But the design must:

- **Detect the conflict up front.** `isExplicitProject()` already exists. If a project is
  explicit and a cloud backend is selected, say so plainly *before* the first paid call.
- **Classify moderation refusals distinctly** from transient errors, so the UI can say
  "the provider refused this content" rather than "generation failed", and so the retry
  logic does not burn money re-submitting something that will never be accepted.
- **Never silently fall back to local**, because a fallback would mask the refusal and
  make the cause invisible.

---

## 6. Proposed design

### 6.1 Naming

Avoid the word "mode". `generationMode` already exists on the project and means
something else entirely — `storyboard_only` / `keyframes_only` / `full_auto`
([lib/schemas/project.ts:66](./lib/schemas/project.ts#L66), with a dedicated
`tests/generation-mode.test.ts`). Reusing it would be actively confusing.

Proposed vocabulary: each of the three areas has a **backend**, whose **location** is
`local` or `cloud`.

```ts
export const AI_AREAS = ["llm", "image", "video"] as const;
export const BACKEND_LOCATIONS = ["local", "cloud"] as const;
```

### 6.2 Settings: a fourth instance of the established pattern

New files, mirroring §3.3 exactly:

- `lib/schemas/remote-ai-settings.ts`
- `lib/db/remote-ai-settings-store.ts` → `<dataDir>/library/remote-ai-settings.json`
- `lib/services/remote-ai-settings-service.ts`
- `app/api/settings/remote-ai/route.ts` (GET/PUT)
- `components/settings/remote-ai-settings.tsx`, added to
  [app/settings/page.tsx](./app/settings/page.tsx)

Sketch of the schema — note that **no field holds a secret** (R-4):

```ts
export const remoteAiSettingsSchema = z.object({
  version: z.literal(1),
  llm:   z.object({ location: z.enum(BACKEND_LOCATIONS).default("local"),
                    provider: z.string().optional(),   // "openai" | "openrouter" | …
                    model: z.string().optional() }),
  image: z.object({ location: z.enum(BACKEND_LOCATIONS).default("local"),
                    provider: z.string().optional(),   // "fal" | "replicate" | …
                    model: z.string().optional() }),
  video: z.object({ location: z.enum(BACKEND_LOCATIONS).default("local"),
                    provider: z.string().optional(),
                    model: z.string().optional() }),
  updatedAt: z.string(),
});
```

**Credential status, not credentials.** The GET route additionally returns a derived,
read-only `credentials: { openai: boolean; fal: boolean; replicate: boolean }` computed
from `process.env`, so the UI can grey out a provider and say *"set `FAL_KEY` in
.env.local to enable this"* without ever transmitting the key. This is what makes R-4
usable rather than merely safe.

Env additions (`.env.example` documentation only — all optional, all defaulting to
local so an empty environment still boots in the current mode):

```
# Cloud media aggregator (choose one to start)
FAL_KEY=
REPLICATE_API_TOKEN=
# Cloud LLM — OPENAI_API_KEY already exists; leave OPENAI_BASE_URL empty for OpenAI
CLOUD_LLM_MODEL=gpt-4o
```

### 6.3 Per-project override (R-5)

Add an optional `backends` object to the project schema, exactly parallel to how
`imageModel` / `videoModel` pins already work:

```ts
backends: z.object({
  llm:   z.enum(BACKEND_LOCATIONS).optional(),
  image: z.enum(BACKEND_LOCATIONS).optional(),
  video: z.enum(BACKEND_LOCATIONS).optional(),
}).optional(),
```

Resolution order, per area: **project override → app-wide setting → `local`.**

One deliberate difference from `generationDefaults`: those are copied onto a project at
creation and never consulted again, so a settings change cannot disturb work in flight.
Backend location should behave the same way for a project **mid-render**, but must
remain *editable* on the project afterwards — switching an existing project from local to
cloud is an obvious thing to want. Recommendation: treat it as a live per-project field
(like `imageModel`), and refuse to change it while that project has a queue running.

### 6.4 Media: implement `WangpClient`, do not fork the pipeline

This is the central recommendation. Add:

```
lib/media-backends/
  types.ts            # BackendCapabilities descriptor
  cloud-client.ts     # implements WangpClient
  localize.ts         # download outputs into dataDir; upload/encode inputs
  providers/fal.ts
  providers/replicate.ts
```

`getWangpClient()` ([factory.ts:13](./lib/wangp/factory.ts#L13)) grows from a
two-way choice into a resolver keyed by area and location. Because `setWangpClient()`
already exists for test injection and `getWangpClient()` appears in only four files, the
blast radius stays small.

The cloud client satisfies the interface by **synthesising** what WanGP would have
discovered (addressing Fact 3):

- `listModels()` returns a **curated, hand-maintained catalogue** of cloud models, shaped
  as `WangpModel` with honest `metadata` — `mainOutput`, `inputs`,
  `mediaInputs.image.{start,end,reference}`, `mediaInputs.audio.output`,
  `supportsLora: false`, `availability: "available"`. Curated rather than discovered
  because aggregator catalogues are thousands of endpoints deep with no quality signal —
  the same problem the code already documents for WanGP's ~200 models, only worse.
- `getModelSchema()` returns a **synthetic `WangpModelSchema`** declaring only fields the
  cloud endpoint genuinely accepts. This is the elegant part: because
  `buildSettingsManifest()` only ever sets fields the schema declares
  ([settings.ts:209](./lib/wangp/settings.ts#L209)), simply *omitting* `num_inference_steps`,
  `activated_loras` and `spatial_upsampling` from the synthetic schema makes the entire
  upstream pipeline stop sending them — **with no changes to the manifest builders at all.**
- `generate()` / `getJob()` / `cancelJob()` map onto the provider's submit/poll/cancel,
  preserving the existing `submitted | running | completed | failed | cancelled` states so
  `runToCompletion()` ([wangp-service.ts:760](./lib/services/wangp-service.ts#L760)) and
  the durable-task machinery (SPEC-008) work unchanged.

**The localisation layer (Fact 1) is the real work.** Two directions:

- *Inbound to the provider:* `image_start`, `image_end`, `image_refs` and `video_source`
  arrive as absolute local paths. The adapter reads each file and uploads it (fal and
  Replicate both accept data URIs or offer an upload endpoint), substituting the returned
  URL. `lib/media/data-url.ts` already exists and helps.
- *Outbound from the provider:* the job completes with a signed HTTPS URL. The adapter
  **must download it into `config.dataDir`** before returning, so that
  `generatedFiles[0]` is a local path exactly as every caller expects, and so
  `assertPathInsideRoots()` passes (Fact 2). Signed URLs also expire, so downloading
  immediately is correctness, not just convention.

This is what preserves the ~59 test files that touch the WanGP contract.

### 6.5 Hiding unsupported features (R-6)

The synthetic schema handles the *backend* half automatically, as described above. The
*UI* half needs the capability descriptor exposed through the existing models API so
components can react. Affected surfaces: the LoRA selector in
[generation-defaults.tsx](./components/settings/generation-defaults.tsx), the per-project
settings screen, the face-swap toggle in the character library, and step-count inputs.

Pattern: hide the control and render one sentence explaining why — "LoRAs are a local
WanGP feature; this project's image backend is set to cloud." Per R-6 the local
experience is untouched.

### 6.6 Concurrency

Make `enqueue()` ([wangp-service.ts:727](./lib/services/wangp-service.ts#L727)) apply
only when the resolved backend is local. Cloud jobs should run with a bounded
concurrency limit (start at 2–3) rather than either strict serialisation or unbounded
fan-out, which would hit rate limits and make cost spikes hard to predict.

---

## 7. Risks

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| RISK-1 | **Content policy refusals** for explicit projects (§5) | **Critical** | Pre-flight warning using `isExplicitProject()`; classify moderation refusals distinctly; never auto-fall-back to local. |
| RISK-2 | Cloud video model returns **no audio track** (R-3) | High | `supportsAudioOutput` in the capability descriptor; warn at selection time. |
| RISK-3 | **No end-frame conditioning** on most cloud video APIs | High | Publish `mediaInputs.image.end` honestly; warn that scenes will not land on their end frame. |
| RISK-4 | **Identity/likeness regression** — no LoRAs, no face swap, weaker reference support | High | Require reference-capable cloud image models for projects using the character library; let the existing `buildImageManifest` guard throw. |
| RISK-5 | **Runaway cost** — an 18-scene batch of 20s clips | High | Pre-flight estimate before a batch; bounded concurrency; hard per-run spend ceiling. |
| RISK-6 | **Signed URLs expire** before download | Medium | Download inside the adapter immediately on completion, before returning the job. |
| RISK-7 | 20s `DEFAULT_SEGMENT_SECONDS` exceeds cloud per-clip caps | Medium | Publish a max duration per backend and clamp, with a visible notice. |
| RISK-8 | **Privacy posture change** — this is a local-first, loopback-bound app (SPEC-007A-lite); cloud means story content and character photographs leave the machine | Medium | State it plainly in the settings UI and Help. Inbound policy is unaffected; outbound egress is currently unrestricted. |
| RISK-9 | Secret leakage into logs/provenance | Medium | Keys only from `process.env`; assert no key is written to `remote-ai-settings.json`, telemetry or provenance. |
| RISK-10 | Curated cloud catalogue goes stale as providers change endpoints | Low | Version the catalogue; fail loudly on an unknown model id rather than guessing. |

---

## 8. Suggested phasing

| Phase | Scope | Effort | Delivers |
| --- | --- | --- | --- |
| **0** | Settings plumbing: schema, store, service, route, settings section, per-project override, `.env.example` docs. Wire it to *nothing* yet. | ~3 days | The UI and persistence, independently testable. |
| **1** | **Cloud LLM** (R-2): per-area connection resolution, local-only enqueue, runtime-control gating, 429 backoff. | ~3 days | Highest value per unit of effort — the agentic canvas stops competing with the GPU. |
| **2** | **Cloud image** via one aggregator (R-1): capability descriptor, synthetic schema, localisation layer, feature hiding. | ~1.5 weeks | The hard architecture, on the cheaper and faster-to-iterate medium. |
| **3** | **Cloud video** on the same adapter: async polling, duration clamping, audio/end-frame warnings, cost pre-flight. | ~1.5 weeks | Completes the three areas. |
| **4** | Direct first-party adapters (R-1, later) as additional providers behind the same interface. | per provider | Veo / Runway / Luma / Kling. |

Phase 1 is independently shippable and worth doing on its own merits.

## 9. Test strategy

The existing suite is the asset that makes this safe — 156 test files, ~59 of which touch
the WanGP contract, plus `npx vitest run`, `npm run typecheck` and `npm run lint` as the
gate.

- **Regression, not rewrite:** every existing test must pass unchanged with all three
  areas defaulting to `local`. That is the contract that proves the seam held.
- A `MockCloudClient` mirroring `MockWangpClient`, injected via the existing
  `setWangpClient()`.
- New coverage: resolution order (project → app-wide → local); synthetic schema *omits*
  LoRA/step/upsampling fields; localisation writes inside `dataDir` and survives
  `assertPathInsideRoots()`; moderation refusal classified distinctly from transient
  failure; **a test asserting no API key ever reaches the settings JSON or telemetry.**

## 10. Open questions

1. **fal.ai or Replicate first?** R-1 says aggregator-first but not which. fal is
   generally faster and more video-focused; Replicate has a broader catalogue and simpler
   file handling.
2. **Cost ceiling behaviour** — should a batch hard-stop at a spend limit, or warn and
   continue?
3. **Mid-project switching** — §6.3 proposes refusing a backend change while a queue is
   running. Is that the behaviour you want, or should it apply from the next scene?
4. **Mixed-backend provenance** — should the UI visibly badge which scenes were rendered
   locally versus in the cloud? The provenance data already supports it.

## 11. Files this would touch

**New:** `lib/schemas/remote-ai-settings.ts`, `lib/db/remote-ai-settings-store.ts`,
`lib/services/remote-ai-settings-service.ts`, `app/api/settings/remote-ai/route.ts`,
`components/settings/remote-ai-settings.tsx`, `lib/media-backends/*`.

**Modified:** [lib/config.ts](./lib/config.ts) (cloud credential blocks),
[lib/wangp/factory.ts](./lib/wangp/factory.ts) (backend resolution),
[lib/agents/llm/provider.ts](./lib/agents/llm/provider.ts) (per-area connection,
conditional queue), [lib/services/llm-runtime-service.ts](./lib/services/llm-runtime-service.ts)
(gate on local), [lib/services/wangp-service.ts](./lib/services/wangp-service.ts)
(conditional `enqueue`), [lib/schemas/project.ts](./lib/schemas/project.ts) (`backends`),
[app/settings/page.tsx](./app/settings/page.tsx), the settings/character-library
components for feature hiding, `app/help/page.tsx`, `.env.example`, and — per the repo's
release-log rule — `README.md`, `CHANGELOG.md` and `lib/version.ts`.

**Explicitly unchanged:** the manifest builders, all prompt construction, the media
prompt composer, `path-policy.ts`, and the durable-task machinery. If any of these need
edits, the adapter seam has been drawn in the wrong place.
