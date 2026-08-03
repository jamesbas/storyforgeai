# LoRA Support in StoryForgeAI — Research & Implementation Plan

**Status:** Implemented. Phases 1–3 are built, tested and verified against the live server;
§12 records what shipped and how the plan was corrected during the build.
**Research basis:** the `jamesbas/easynediacreator` repository, the local LoRA store, and — as of
2026-07-27 — the **live, running** WanGP MCP server. All open questions from the first draft have
now been answered empirically; §4.4–§4.7 record the results, and one of them affects renders you
were producing before this landed (§4.5).

---

## 1. What was asked

> Add the ability to select one or more LoRAs for scenes. The LoRA selector should filter the
> available LoRAs based on what model is selected for the image generator and video generator.
> Selectable per scene, but also provide a way to select one or more LoRAs for the entire
> storyboard's video generation. Once selected, they should be sent to the Wan2GP MCP server with
> the media generation instructions.

Decomposed into five capabilities:

| # | Capability | Notes |
|---|---|---|
| C1 | **Discover** which LoRAs exist | Not currently possible over MCP — see §2 |
| C2 | **Filter** them by the selected model | Image and video models are pinned independently, so two separate catalogs |
| C3 | **Select** at storyboard scope | Applies to every scene's generation |
| C4 | **Override/extend** at scene scope | Per-scene selection |
| C5 | **Transmit** to WanGP with the generation call | `activated_loras` + `loras_multipliers` |

---

## 2. The blocking finding: the MCP server exposes no LoRA API

This is the single most important constraint, and it reshapes the whole design.

The WanGP MCP server at `http://100.71.40.31:7866/mcp` advertises **11 tools**:

```
wangp_list_models          wangp_get_model_metadata      wangp_get_model_schema
wangp_list_model_defs      wangp_get_model_availability  wangp_generate
wangp_get_model            wangp_list_model_availability wangp_get_job
wangp_get_default_settings wangp_cancel_job
```

None of them return a LoRA inventory. This was confirmed independently twice:

1. Our own `npm run wangp:refs -- --tools` probe against the live server.
2. EasyMediaCreator reached the same conclusion and documented it in `lora-classifier.md`:
   > *"The inspected WanGP MCP server, version 1.10.1, does not expose a LoRA inventory or LoRA
   > metadata tool."*

   They went further and filed an upstream request (`wan2gp-mcp-lora-need.md`) asking for a
   `wangp_list_loras(model_type)` tool. It has not landed.

**Re-verified 2026-07-27 against the running server** — still exactly 11 tools, still no LoRA
discovery. This is not an artefact of the server having been offline.

**Consequence:** discovery must come from the **filesystem**, with MCP tools used opportunistically
if they ever appear. There is no way around this for v1.

---

## 3. What EasyMediaCreator does

Reviewed the relevant modules in `jamesbas/easynediacreator`.

### 3.1 Discovery — MCP first, filesystem fallback

`lib/wan-gp/live-client.ts`:

```ts
async listLoras(modelType: string) {
  const candidates = ["wangp_list_lora_presets", "wangp_list_loras", "wangp_get_loras"];
  const toolName = candidates.find(c => this.toolNames?.has(c)) ?? await this.findTool(candidates);
  if (!toolName) {
    if (!this.loraRoot) {
      return { supported: false, loras: [],
               reason: "WanGP does not expose LoRA discovery and WANGP_LORA_ROOT is not configured." };
    }
    const metadata = record(await this.call("wangp_get_model_metadata", { model_type: modelType }));
    return listLocalLoras(this.loraRoot, { metadata });
  }
  ...
}
```

The shape is deliberately future-proof: the day the server ships a LoRA tool, the fallback becomes
dead code rather than requiring a rewrite. Worth copying wholesale.

### 3.2 Model → directory mapping

`lib/wan-gp/local-lora-catalog.ts` — this *is* the filter (C2):

```ts
export function getLoraDirectoryName(schema) {
  const modelDef = object(schema.model_def);
  const metadata = object(schema.metadata);
  const capabilities = object(metadata.capabilities);
  if (modelDef.no_lora === true || capabilities.lora === false) return undefined;

  const family = String(metadata.family ?? modelDef.family ?? "").toLowerCase();
  const baseModelType = String(
    metadata.base_model_type ?? modelDef.base_model_type ?? schema.model_type ?? "").toLowerCase();

  if (family === "qwen") return "qwen";
  if (family === "ltx2") return "ltx2";
  if (family === "flux" || family === "flux2") {
    if (baseModelType.includes("flux2_klein_9b")) return "flux2_klein_9b";
    if (baseModelType.includes("flux2_klein_4b")) return "flux2_klein_4b";
    return baseModelType.includes("flux2") ? "flux2" : "flux";
  }
  return undefined;
}
```

`listLocalLoras()` then:
- guards containment with `path.dirname(directory) === root`,
- returns **immediate** `.safetensors` / `.sft` **filenames only** (no recursion, never absolute paths),
- treats `ENOENT` as a *supported but empty* catalog rather than an error.

Note the mapping is a hand-maintained allowlist covering four families. It returns `undefined` —
meaning "LoRAs unsupported" — for everything else. We will need to extend it (§5.2).

### 3.3 Transmission

`lib/wan-gp/settings-builder.ts`:

```ts
export function applyLoraSettings(target, schema, defaults, modelType, loras) {
  const required = loras.length > 0;
  setDiscoveredSetting(target, schema, defaults, modelType,
    ["activated_loras"], loras.map(l => l.name), required);
  setDiscoveredSetting(target, schema, defaults, modelType,
    ["loras_multipliers"], loras.map(l => `${l.strength}`).join(" "), required);
}
```

- `activated_loras` — array of bare filenames.
- `loras_multipliers` — space-separated strengths, **aligned by index**.
- Phase syntax exists for high/low-noise pairs: `"1;0 0;1 0.8"`. Out of scope for v1.

The `required` flag is important — it forces an error if the field can't be set, rather than
silently dropping the LoRAs. See §5.5, this is a trap we have already been bitten by.

### 3.4 Validation

`lib/services/lora-service.ts`:

```ts
export function validateModelLoras(selected, catalog) {
  if (!selected.length) return [];
  if (!catalog.supported) throw new Error(catalog.reason ?? "...");
  const available = new Map(catalog.loras.map(n => [n.toLocaleLowerCase(), n]));
  return selected.map(lora => {
    const canonicalName = available.get(lora.name.toLocaleLowerCase());
    if (!canonicalName) throw new Error(`LoRA '${lora.name}' is not available for the selected model...`);
    return { ...lora, name: canonicalName };
  });
}
```

Case-insensitive match that canonicalises back to the on-disk spelling. Zod schema rejects `/`, `\`,
`.` and `..` in names; strength is `.min(-10).max(10).default(1)`.

### 3.5 Acceleration-preset classifier — recommend scoping OUT

There is a substantial subsystem (`lib/wan-gp/lora-classifier/`) that parses WanGP profile JSONs
from `WANGP_PROFILES_ROOT` to detect Lightning / CausVid / distill recipes and their required step
counts, CFG, solver and multipliers. It is genuinely useful but it is a feature in its own right,
and it interacts with our step/CFG defaults. **Recommend deferring to a later phase.**

---

## 4. Environment reality check

I verified the actual machine rather than assuming. Findings:

### 4.1 The LoRA store exists and is populated

`C:\pinokio\api\wan.git\app\loras` exists, containing **42 family subdirectories** and no files at
the root — exactly the layout EasyMedia's mapper expects:

```
ace_step  chatterbox  flux  flux2  flux2_klein_4b  flux2_klein_9b  hidream_o1
hunyuan  hunyuan_1_5  hunyuan_i2v  ideogram4  k5_lite_i2v  k5_pro_t2v  krea2
longcat  ltx2  ltxv  magi_human  old_ltx2_22B  qwen  wan  wan_1.3B  wan_5B
wan_i2v  z_image  ... (42 total)
```

### 4.2 Both of your pinned models have LoRAs installed

| Pinned model | `.env.local` | Directory | Installed |
|---|---|---|---|
| Image | `flux2_klein_9b` | `loras/flux2_klein_9b` | yes, multiple `.safetensors` (~158–316 MB) |
| Video | `ltx2_22B_distilled_1_1` | `loras/ltx2` | yes, multiple (~192 MB–1.2 GB) |

`loras/flux2` is empty, and `loras/qwen` is populated. So the feature has real content to show on
day one — this is not a speculative build.

### 4.3 A metadata sidecar store exists — and it is essentially mandatory

`C:\pinokio\api\wan.git\app\loras_metadata\<family>\<name>.json` holds Civitai-style records:

```json
{
  "id": 2831523, "modelId": 2519268,
  "name": "V2",
  "nsfwLevel": 60,
  "trainedWords": [],
  "trainingDetails": { "params": { "ecosystem": "flux2klein", "networkDim": 32, ... } }
}
```

This matters more than it first appears. Many installed LoRAs have **opaque filenames** —
`2GQ3Z0DP0SC5B3SB6Q40MJG3V0.safetensors`, `BPQ73613R42K2MCCXJKAH3YR00.safetensors`. A picker
showing only filenames would be unusable. The sidecar gives us:

- `name` — a human-readable label,
- `trainedWords` — **trigger words**, which frequently must appear in the prompt for a LoRA to
  activate at all. This is a real correctness issue, not a nicety.
- `trainingDetails.params.ecosystem` (e.g. `"flux2klein"`) — a second, independent compatibility
  signal to cross-check the directory mapping.
- `nsfwLevel` — available if we ever want UI sorting/filtering.

Note `loras_metadata` is keyed slightly differently from `loras` (it has both `ltx2` and
`ltx2_22B`), so lookup must be tolerant of a miss and degrade to the raw filename.

### 4.4 Live verification — model identity and LoRA fields

With the server running, both pinned models were dumped. Results:

| Field | `flux2_klein_9b` (image) | `ltx2_22B_distilled_1_1` (video) |
|---|---|---|
| `family` | `flux2` | `ltx2` |
| `base_model_type` | `flux2_klein_9b` | `ltx2_22B` |
| `architecture` | `flux2_klein_9b` | `ltx2_22B` |
| `capabilities.lora` | `true` | `true` |
| `activated_loras` | `[]` (declared) | **2 entries** (declared) |
| `loras_multipliers` | `""` (declared) | `"1"` (declared) |
| → resolved directory | `loras/flux2_klein_9b` | `loras/ltx2` |

Three things follow:

1. **EasyMedia's mapper works unmodified for both models.** `family: "flux2"` +
   `base_model_type: "flux2_klein_9b"` hits their `flux2_klein_9b` branch; `family: "ltx2"` hits
   their `ltx2` branch. The longest-prefix fallback I proposed as insurance is no longer required
   for correctness, though it remains cheap coverage for the other 38 directories.
2. **`activated_loras` and `loras_multipliers` are genuinely declared** in both the schema and the
   defaults for both models, so `setIf` will not silently drop them here (§5.5).
3. **Open question 4 is settled:** `ltx2_22B_distilled_1_1` maps to `loras/ltx2`, *not*
   `old_ltx2_22B`, despite `base_model_type` being `ltx2_22B`. The `family` field is the correct
   key; `base_model_type` would have produced the wrong directory here. Worth noting, because it is
   the one case where the two disagree.

**Open question 3 is also settled.** Both LoRAs currently active on the video model —
`LTX-2-Image2Vid-Adapter.safetensors` and an NSFW helper LoRA — exist as files in `loras/ltx2`.
WanGP therefore takes **bare filenames resolved relative to the family directory**, exactly as
EasyMedia assumed. No paths.

### 4.5 Critical finding: `activated_loras` is mutable WanGP UI state

The video model returned two already-active LoRAs. I traced where they come from, because the
answer changes the design.

WanGP persists per-model settings to `app/settings/<model_type>_settings.json`. That file for the
pinned video model contains the saved prompt, `num_inference_steps: 8`, and the same two
`activated_loras`. The MCP server's schema and defaults are simply **reflecting the user's
last-used WanGP UI state**.

Two consequences, and the second is the important one:

- **Overwriting `activated_loras` is safe.** These are not model requirements. The genuine system
  LoRAs for this distilled model (`ltx2_lora_distilled_1_1`, `ltx2_lora_hdr`, `ltx2_lora_id`, …)
  are declared separately in the model definition as HuggingFace URLs and are loaded independently
  of `activated_loras`. We cannot clobber the distillation by writing this field. My first draft
  worried we might; that concern is now disproved.

- **StoryForge renders are currently non-deterministic, today, before this feature exists.**
  Because StoryForge never sets `activated_loras`, every video generation silently inherits
  whatever LoRAs happen to be selected in the WanGP UI. Right now that is two LoRAs StoryForge
  knows nothing about. The same project rendered tomorrow, after someone touches the WanGP UI,
  will produce different output with no visible cause.

  This reframes the feature. It is not only additive — it also **closes an existing reproducibility
  hole**. Recommendation: StoryForge should **always set `activated_loras` explicitly, including to
  `[]` when nothing is selected**, so a project fully determines its own render. That should
  arguably ship in Phase 1 even before any UI exists.

  Worth flagging as a behaviour change: the first render after this lands may look different from
  recent ones, because those were picking up UI-selected LoRAs by accident.

### 4.6 `loras_multipliers` is a mini-DSL, not a number

Surveying the saved settings files across models reveals three delimiters in active use:

```
1                       single value
.40  .85                leading-dot decimals are accepted
0.5;1                   ';' separates phases within one LoRA (high/low-noise experts)
0;0.8 0.4;0             ' ' separates LoRAs, ';' separates phases
1|                      '|' separates step-range values (time-varying strength)
1;1|0.35;0 0;0.75       all three combined
```

Also notable: the pinned video model has **two** activated LoRAs but a multiplier string of just
`"1"`. WanGP tolerates a short multiplier list rather than erroring, so strict index alignment is
*not* enforced server-side.

For v1, emitting one plain number per LoRA is valid and safe. But the plan should record that a
single `strength: number` per LoRA is a **lossy simplification** of what WanGP accepts, and that
round-tripping a hand-written multiplier string through our UI would silently discard phase and
step information. If we ever read existing settings back, preserve the raw string.

### 4.7 `.lset` files are LoRA presets — exclude them from the picker

The `loras/ltx2` directory contains `.lset` files paired with many `.safetensors` (e.g.
`beej.lset` / `beej.safetensors`), plus a stray `.json`. These are WanGP **LoRA preset** files —
which is what the unimplemented `wangp_list_lora_presets` tool name refers to.

They must **not** appear as selectable LoRAs. EasyMedia's `.safetensors` / `.sft` extension
allowlist already excludes them correctly. They are, however, a second local metadata source worth
mining later for trigger words and suggested multipliers.

### 4.8 Filesystem access — confirmed

The LoRA store, the metadata sidecars and the WanGP settings directory are all readable on this
machine, and their contents match what the MCP server reports. App and WanGP share a filesystem;
the Tailscale address is just how the HTTP endpoint is reached. Filesystem discovery is viable.

---

## 5. Proposed design

### 5.1 What StoryForge already has

Pleasingly, a lot of the groundwork is already in place — some of it seemingly laid in
anticipation:

| Asset | Location | State |
|---|---|---|
| `WANGP_LORA_ROOT` config | `lib/config.ts` → `config.wangp.loraRoot` | present, **unused** |
| `activated_loras`, `loras_multipliers` aliases | `lib/wangp/mcp/aliases.ts` | already in `CANONICAL_ALIASES` |
| LoRA tool names | `lib/wangp/mcp/transport.ts` → `ALLOWED_TOOLS` | already allowlisted |
| `findTool(candidates)` | `lib/wangp/mcp/transport.ts` | complete, purpose-built for optional tools |
| `supportsLora` capability | `lib/wangp/model-router.ts` → `toCapability()` | exposed |
| `metadata.supportsLora` | `wangpModelSchema`, read in `normalize.ts:281` | **broken — see below** |

> **Corrected during implementation.** `metadata.supportsLora` was always `undefined`. `normalize.ts`
> read `supports_lora` / `supportsLora` / `loras`, and the live payload publishes none of them — the
> real flag is `capabilities.lora`. Any plan step that "gates on `supportsLora`" would have gated on
> nothing. Fixed in `normalize.ts`, which now also carries `family` and `baseModelType`.
>
> Relatedly, `WangpModelSchema` is only `{ modelType, defaultSettings, fields }` — it has no family
> information at all, so EasyMedia's `getLoraDirectoryName(schema)` could not work against it. The
> catalog keys off `WangpModel.metadata` instead. Usefully, `wangp_list_models` already returns
> `family`, `base_model_type` and `capabilities` per entry, so **no extra MCP call is needed** —
> EasyMedia's per-model `wangp_get_model_metadata` round-trip is avoidable.

Genuinely new work is therefore narrower than it looks: a catalog service, schema fields, two
manifest overrides, an API route, and UI.

### 5.2 Discovery service — `lib/wangp/lora-catalog.ts`

Port EasyMedia's mapper with three changes:

1. **Broaden the family map.** Their allowlist covers four families; the disk has 42 directories.
   Cover at minimum `wan`, `wan_i2v`, `hunyuan`, `ltxv`, `qwen`, `z_image`, `krea2`.
2. **Prefer `family`, then fall back to the disk listing.** Live dumps confirm `family` is the
   reliable key and that `base_model_type` can disagree with it (§4.4: `ltx2_22B` → `loras/ltx2`).
   Use `family` first; if it is absent or unmapped, match `model_type` against the **actual
   directory listing by longest prefix**. Deriving candidates from disk rather than a hardcoded
   table means new families need no code change.
3. **Enrich from `loras_metadata`.** Sidecar lookup for display name, trigger words and ecosystem;
   silently degrade to the bare filename on miss.

Returns a discriminated result — `{ supported: true, loras: [...] }` or
`{ supported: false, reason }` — so the UI can explain *why* the picker is empty (model has
`no_lora`, root not configured, directory absent) instead of showing a blank list.

**Caching:** in-memory, keyed by model type, ~60 s TTL, plus an explicit refresh. Directory reads
are cheap but happen per scene during a batch, so caching matters there.

### 5.3 Data model

Follow the existing `characterWardrobe` precedent: **store scene overrides as a project-level map
keyed by scene id, not as a field on `sceneSchema`.**

Rationale — `sceneSchema` is agent-generated (the Storyboard Agent emits `sceneDraft`s). Adding a
user-authored field there means either teaching agents to emit it or carrying it as optional dead
weight through regeneration. A sibling map avoids polluting agent output entirely, and mirrors a
pattern already proven in this codebase.

```ts
// lib/schemas/lora.ts (new)
export const loraSelectionSchema = z.object({
  name: z.string().min(1).max(255)
    .refine(n => !n.includes("/") && !n.includes("\\"), "no path separators")
    .refine(n => n !== "." && n !== ".." && !n.startsWith("."), "invalid name"),
  strength: z.number().min(-10).max(10).default(1),
});

export const loraSelectionSetSchema = z.object({
  image: z.array(loraSelectionSchema).max(8).default([]),
  video: z.array(loraSelectionSchema).max(8).default([]),
});
```

```ts
// lib/schemas/project.ts (extend)
loras?: LoraSelectionSet;                                   // C3 — storyboard-wide
sceneLoras?: Record<string, {                               // C4 — per scene
  mode: "inherit" | "override";
  image: LoraSelection[];
  video: LoraSelection[];
}>;
```

Split by `image` / `video` because the two models are pinned independently and their catalogs are
disjoint. The request specifically called out storyboard-wide selection *for video*; providing the
image side too costs nothing and is more consistent.

**Resolution for v1: `inherit` (default) or `override` (replaces wholesale).** An `extend` mode
that merges storyboard + scene LoRAs is tempting — a global look LoRA plus a per-scene action LoRA
is a natural pattern — but merging risks silently exceeding sane LoRA counts and stacking
conflicting weights. Recommend shipping inherit/override, then adding `extend` once there is real
usage to judge it against.

**Caveat to handle:** if scene IDs are not stable across storyboard regeneration, `sceneLoras` will
accumulate orphans. Prune on storyboard write.

### 5.4 Selection → manifest

Extend `ManifestOverrides` in `lib/wangp/settings.ts` with `loras?: LoraSelection[]`, and thread it
through `buildImageManifest` / `buildVideoManifest` in `lib/services/wangp-service.ts`.

> **Corrected during implementation.** An earlier draft placed reconciliation in
> `lib/services/media-service.ts`, on the assumption that it knows the resolved model. It does not:
> the manifest builders resolve the model themselves and may *substitute* the project's pin —
> `buildImageManifest` swaps in a reference-capable model when a scene pins characters. Validating
> against the pin would therefore check the wrong model. Reconciliation happens **inside** the
> builders, after `resolveModel`.

```
project.loras + project.sceneLoras[sceneId]
        → resolveSceneLoras(project, sceneId, kind)     [media-service]
        → buildImageManifest / buildVideoManifest
        → resolveModel(...)                             [the model actually used]
        → reconcileLoras(selection, catalogForModel(model))
        → ManifestOverrides.loras
        → activated_loras / loras_multipliers
```

### 5.5 The `setIf` trap — must not be repeated

`buildSettingsManifest` uses `setIf(name, value)`, which **only writes fields the model schema
declares and silently no-ops otherwise**. We have already lost time to this with `image_refs` and
`video_prompt_type`.

Live dumps confirm both pinned models *do* declare `activated_loras` and `loras_multipliers`
(§4.4), so the immediate risk is lower than feared. It remains a real hazard for the other ~200
models: if a schema omits the field, a silent no-op means generation runs *without* the LoRAs and
looks superficially fine — the worst failure mode, because the user sees output and assumes it
worked.

**Mitigation:** mirror EasyMedia's `required` flag. When the selection is non-empty, an inability to
set the field must raise, not pass. Gate on `capabilities.lora` in the UI so this is unreachable in
normal use, and treat the raise as a backstop.

### 5.6 API

- `GET /api/wangp/loras?model=<model_type>` → catalog for one model (enriched, filenames only).
- Selections persist through the existing project update route; no new write endpoint needed.

Must send `Cache-Control: no-store` — we lost time previously to browser heuristic caching serving
stale status.

### 5.7 UI

- **Storyboard-wide** — a LoRA panel in `components/storyboard/storyboard-view.tsx` (alongside the
  existing Planning-model / Scene-continuity / Batch-generation panels), or in
  `components/settings/project-settings.tsx` next to the model pins. The settings page is the
  better home: it already owns model pinning, and the catalog depends on the pinned model, so the
  two belong together.
- **Per-scene** — a compact selector on the scene card: an "Inherit / Override" toggle plus the
  picker, collapsed by default so it doesn't clutter the storyboard.
- Each row: display name (from sidecar) with filename as secondary text, a strength input
  (default 1.0), and trigger words shown as a hint when present.
- When a model has no LoRA support or an empty directory, show the catalog's `reason` rather than
  an empty box.

---

## 6. Interactions and edge cases

| Scenario | Handling |
|---|---|
| **Model substituted at runtime.** `selectImageModel(..., { requireReferenceImages })` can pick a different model than the pin when a scene needs reference images — invalidating the LoRA selection. | Highest-risk interaction. Recommend: **pre-flight validation at enqueue** across all scenes (fail fast, before a long batch starts), and at runtime, if substitution occurs, **drop incompatible LoRAs and record a warning on the scene** rather than failing generation outright. Failing scene 7 of 20 because of a LoRA mismatch is worse than proceeding without it, provided the warning is visible. |
| **User re-pins a model in settings.** | Existing selections become stale. Validate on save and clear/flag non-matching entries immediately, while the user is in context to fix it. |
| **Trigger words.** | Phase 2: offer to append `trainedWords` to the scene prompt. Do not inject silently — it changes the prompt the user wrote. |
| **Character reference images.** | Orthogonal; `image_refs` and `activated_loras` are independent fields. No conflict expected, but a character LoRA plus a reference image of a different person will fight. Worth a UI note. |
| **Batch queue.** | Resolution must occur per scene inside the queue, not once at enqueue, since scenes may override. |
| **LoRA count.** | Cap at 8. VRAM is already tight at 16 GB and stacked LoRAs add up. |
| **`loras_multipliers` alignment.** | Emit index-aligned with `activated_loras`. WanGP tolerates a short list (§4.6) but we should not rely on that. Any filtering must drop from both arrays together — an easy off-by-one that would silently mis-weight every LoRA after the removed one. |
| **Inherited WanGP UI state (§4.5).** | Always write `activated_loras` explicitly, even when empty, so projects are reproducible and do not absorb whatever is selected in the WanGP UI. |
| **`.lset` presets (§4.7).** | Excluded by the extension allowlist. Do not offer them as LoRAs. |

---

## 7. Security

The design deliberately keeps a filesystem read behind an HTTP API, so the boundary needs care:

- **Filenames only.** Absolute paths never cross to the client.
- **Zod rejects** path separators and `.` / `..` segments on the way in.
- **Containment check** — `path.resolve` the target directory and verify its parent is exactly the
  configured root before reading.
- **No recursion** — immediate children only, extension-allowlisted to `.safetensors` / `.sft`.
- **Read-only** — the service never writes, moves or deletes in the LoRA store.
- **Model type is not a path component.** The mapper resolves it to a known directory name; the raw
  `model_type` string from a request must never be concatenated into a path.
- Selections are validated against the catalog server-side at generation time, so a crafted request
  cannot activate an arbitrary file.

---

## 8. Open questions

The first draft listed five. Four are now closed against the live server:

| # | Question | Status |
|---|---|---|
| 1 | Does metadata expose `family` / `base_model_type`? | **Resolved** — both, for both models (§4.4). `family` is the correct key. |
| 2 | Do app and WanGP share a filesystem? | **Resolved** — yes (§4.8). |
| 3 | Bare filenames or paths in `activated_loras`? | **Resolved** — bare filenames, relative to the family directory (§4.4). |
| 4 | `loras/ltx2` or `loras/old_ltx2_22B`? | **Resolved** — `loras/ltx2` (§4.4). |
| 5 | Should `WANGP_LORA_ROOT` default to the Pinokio path? | **Still open** — a judgement call, not a fact. |

Remaining questions, both design choices rather than unknowns:

- **Q5:** default `WANGP_LORA_ROOT` to the discovered Pinokio path, or keep `""` and require
  explicit configuration? Defaulting makes the feature work out of the box here; keeping it empty
  avoids baking in a machine-specific path. Suggest keeping `""` in code and setting it in
  `.env.local`.
- **Q6 (new):** should the UI surface LoRAs currently active in the WanGP UI as a starting
  selection, or ignore them entirely? Showing them once, as an import, may ease the transition
  described in §4.5 — but ongoing sync would reintroduce the non-determinism we are trying to fix.

No blocking unknowns remain. Phase 1 can begin.

---

## 9. Suggested phasing

**Phase 1 — Discovery, plumbing, and determinism fix**
Catalog service with mapper, fallback and metadata enrichment; `GET /api/wangp/loras`; schemas;
config wiring. Unit tests with a fixture directory tree. No UI.

Also in Phase 1, and independently valuable: **always write `activated_loras` explicitly** (empty
when nothing is selected) so renders stop inheriting WanGP UI state (§4.5).

> **Corrected during implementation.** Shipping the determinism fix *alone* would strip the two
> LoRAs currently in effect with no UI to put them back — a regression window between phases.
> Phases 1 and 2 were therefore built and released together, so anything the fix clears can be
> re-selected immediately.

**Phase 2 — Storyboard-wide selection (C3)**
Project schema fields, settings-page panel, manifest injection, pre-flight validation. Delivers the
headline request end to end.

**Phase 3 — Per-scene selection (C4)**
`sceneLoras` map, inherit/override toggle, scene-card UI, per-scene resolution in the batch queue.

**Phase 4 — Quality of life**
Trigger-word suggestion, orphan pruning, strength presets, `extend` merge mode if warranted.

**Deferred** — acceleration-preset classifier (§3.5), phase-syntax multipliers for high/low-noise
pairs.

---

## 10. Test plan

- **Mapper** — family/base-model combinations, `no_lora`, `capabilities.lora === false`, unknown
  families, longest-prefix fallback.
- **Catalog** — fixture directory: extension filtering, no recursion, `ENOENT` → supported-empty,
  containment rejection, metadata enrichment hit and miss.
- **Validation** — case-insensitive canonicalisation, unknown name rejection, separator rejection,
  empty selection short-circuit.
- **Manifest** — `activated_loras` / `loras_multipliers` index alignment; **explicit test that a
  non-empty selection against a schema lacking the field raises rather than no-ops** (§5.5); and
  that an *empty* selection still writes `activated_loras: []` rather than omitting it (§4.5).
- **Resolution** — inherit vs override; orphaned `sceneLoras` entries ignored.
- **Catalog exclusions** — `.lset` and `.json` siblings never appear in results (§4.7).
- **Live** — one manual generation with a known LoRA at strength 1.0 vs 0.0, confirming visible
  difference. This is the only way to prove the wire format is actually correct; unit tests can
  only prove we sent what we intended.

Existing suite is 258 tests / 32 files; `tests/setup.ts` pins `WANGP_MCP_ENABLED=false`, so catalog
tests must use a fixture root and not touch the real store.

---

## 11. Summary

The request is achievable and most of the WanGP-side plumbing already exists in this repo. The one
genuine obstacle is that **the MCP server has no LoRA discovery API** — re-confirmed against the
running server — so v1 must read the filesystem via `WANGP_LORA_ROOT`, structured as
EasyMediaCreator did so that an upstream MCP tool can take over later without a rewrite.

Four findings to carry into implementation:

- **Renders are already non-deterministic (§4.5).** StoryForge never sets `activated_loras`, so
  every video generation silently inherits whatever is selected in the WanGP UI — currently two
  LoRAs. Setting the field explicitly is a small fix with value independent of the rest of this
  feature, and it should land first.
- **Metadata enrichment is not optional (§4.3).** Many installed LoRAs have opaque hash-like
  filenames; a picker without `loras_metadata` lookup would be unusable, and `trainedWords` affects
  whether a LoRA activates at all.
- **`family` is the correct routing key (§4.4)**, not `base_model_type` — they disagree for the
  pinned video model, and `base_model_type` gives the wrong directory.
- **The `setIf` silent no-op remains the main correctness risk (§5.5)** for models beyond the two
  pinned ones. Without a `required` flag, selected LoRAs can vanish and still produce plausible
  output — a failure the user would not notice.

All blocking unknowns are resolved. Recommended first step is Phase 1, leading with the
determinism fix.

---

## 12. What shipped

Phases 1–3 are implemented, plus the orphan pruning from Phase 4. Verified against the live server:
286 tests pass (28 new), typecheck and lint clean.

**New files**

| File | Role |
|---|---|
| `lib/schemas/lora.ts` | Selection, override and catalog types; filename safety rules |
| `lib/wangp/lora-catalog.ts` | Directory resolution, weight listing, sidecar enrichment, caching |
| `lib/services/lora-service.ts` | Scene resolution, strict validation, lenient reconciliation, pruning |
| `app/api/wangp/loras/route.ts` | `GET` catalog by `model`, or by `projectId` + `kind` |
| `components/settings/lora-selector.tsx` | Reusable picker with strength, trigger words, refresh |
| `components/storyboard/scene-lora-panel.tsx` | Per-scene inherit/override panel |
| `tests/lora.test.ts` | 28 tests over mapping, listing, safety, resolution and manifest writing |

**Changed** — `normalize.ts` (`capabilities.lora`, `family`, `baseModelType`), `schemas/wangp.ts`,
`config.ts` (`loraMetadataRoot`), `wangp/settings.ts` (`applyLoras`), `services/wangp-service.ts`,
`services/media-service.ts`, `services/project-service.ts`, `schemas/project.ts`, `schemas/intake.ts`,
`telemetry/index.ts` (`lora.dropped`), plus the settings and storyboard views.

**Deviations from the plan**, all recorded inline above: the reconciliation point moved into the
manifest builders (§5.4); the `supportsLora` bug had to be fixed first and the catalog keys off
`WangpModel.metadata` rather than `WangpModelSchema` (§5.1); Phases 1 and 2 shipped together to
avoid a regression window (§9). Directory resolution is data-driven — candidates are tested against
the real on-disk listing rather than a hardcoded family table — which covers all 42 folders instead
of EasyMedia's four.

**Live verification**

```
flux2_klein_9b          -> loras/flux2_klein_9b   43 installed, 36 labelled, 26 with triggers
ltx2_22B_distilled_1_1  -> loras/ltx2             52 installed, 39 labelled, 16 with triggers
video manifest, 1 selected at 0.8  -> activated_loras ["beej.safetensors"], multipliers "0.8"
video manifest, none selected      -> activated_loras [], multipliers ""   (determinism fix)
```

The sidecar lookup earns its place: `2GQ3Z0DP0SC5B3SB6Q40MJG3V0.safetensors` renders as "V2".

**Still outstanding** — the one live generation that proves the wire format end to end (§10):
render a scene with a known LoRA at strength 1.0 and again at 0.0 and confirm the output differs.
Everything up to the submitted payload is verified; only WanGP's interpretation of it is taken on
trust. Phase 4's trigger-word injection and the acceleration-preset classifier (§3.5) remain
deferred.
