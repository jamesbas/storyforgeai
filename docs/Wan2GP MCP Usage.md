# Using the Wan2GP MCP Server From an Application

A practical guide to driving local image, video and audio generation through the **Wan2GP (WanGP)
MCP server**.

This is written as a **portable pattern**, not as documentation of StoryForgeAI. StoryForgeAI is the
worked example — every technique, failure mode and workaround below came from running a real
workload against a live WanGP install on a single consumer GPU. Where something is
StoryForge-specific it is flagged so you can discard it.

**Audience:** a developer integrating local diffusion-model generation into an application for the
first time.

---

## 1. What Wan2GP is, and what the MCP server adds

**Wan2GP** (usually "WanGP") is a local generation application that runs open-weight image, video
and audio diffusion models on consumer hardware, with aggressive memory optimisation so large video
models fit on ordinary GPUs. It ships a web UI and bundles a very large model catalogue — a typical
install advertises **~200 models** spanning Wan, LTX-2, Flux, Qwen, Hunyuan, ACE-Step and others.

The **MCP server** wraps that engine in [Model Context Protocol](https://modelcontextprotocol.io)
tools, reachable over Streamable HTTP. For an integrator that means:

- No REST contract to learn per model — you call a handful of generic tools.
- Model capabilities are **discovered at runtime**, not hardcoded.
- One transport handles image, video and audio alike.

**Why target it:** free local generation, no per-image cost, no data leaving the machine, and a
catalogue you can extend by dropping in weights. **Why it might not suit you:** it is a
single-session desktop-oriented application (§8.3), it has no authentication, and job throughput is
one at a time. It is not a multi-tenant service and should not be exposed to untrusted callers.

Two framing points that shape everything downstream:

1. **WanGP is discovery-driven, not contract-driven.** Two models rarely accept the same field
   names. Your integration is mostly a *negotiation layer*, not a client.
2. **The MCP surface lags the engine.** Several capabilities the WanGP UI exposes have no MCP tool
   at all — LoRAs being the significant one (§9).

---

## 2. The tool surface

A current server (v1.10.x) advertises **11 tools**. Enumerate them at startup rather than trusting
this list:

| Tool | Purpose |
|---|---|
| `wangp_list_models` | Catalogue with capabilities and availability |
| `wangp_list_model_defs` | Raw model definitions |
| `wangp_get_model` | One model's entry |
| `wangp_get_model_metadata` | Capability metadata for one model |
| `wangp_get_model_availability` | Whether weights are installed |
| `wangp_list_model_availability` | Availability across the catalogue |
| `wangp_get_model_schema` | Settings schema for one model |
| `wangp_get_default_settings` | Default settings payload for one model |
| `wangp_generate` | Submit a job |
| `wangp_get_job` | Poll a job |
| `wangp_cancel_job` | Cancel a job |

**What is *not* there is as important as what is.** There is no tool to list LoRAs, no tool to list
outputs, and no tool to report queue depth. Plan for §9 accordingly.

Design your client so an optional tool can be adopted the day it appears:

```ts
/** Resolve the first advertised tool from a candidate list, or undefined. */
async findTool(candidates: string[]): Promise<string | undefined> {
  if (!this.toolNames) {
    const client = await this.connect();
    this.toolNames = new Set((await client.listTools()).tools.map((t) => t.name));
  }
  return candidates.find((c) => this.toolNames?.has(c));
}
```

---

## 3. Connecting

Standard MCP client over Streamable HTTP. Endpoint looks like `http://<host>:7866/mcp`.

```ts
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import(
  "@modelcontextprotocol/sdk/client/streamableHttp.js"
);
const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
```

Three things worth building in from the start.

### 3.1 Lazy, single-flight connect

Connections are expensive and callers are concurrent. Cache the promise, not just the client, so
ten simultaneous callers produce one connection.

### 3.2 A hard tool allow-list

This is your security boundary. If a tool name can ever originate from data, an allow-list is what
stops it reaching an arbitrary tool:

```ts
export const ALLOWED_TOOLS = new Set([
  "wangp_list_models", "wangp_get_model_metadata", "wangp_get_model_schema",
  "wangp_get_default_settings", "wangp_generate", "wangp_get_job", "wangp_cancel_job",
  /* optional, may not be advertised: */ "wangp_list_loras",
]);

if (!ALLOWED_TOOLS.has(toolName)) throw new Error(`WanGP tool ${toolName} is not allowed.`);
```

### 3.3 Result unwrapping

WanGP returns results in **two different shapes**, and single values come wrapped. Normalise once,
centrally:

```ts
// Preferred: structuredContent. Single-value results arrive as { result: ... }.
function unwrapStructuredContent(value: unknown): unknown {
  const source = asRecord(value);
  if (source && Object.keys(source).length === 1 && "result" in source) return source.result;
  return value;
}

// Fallback: text content items whose text is JSON.
function parseTextContent(content: { type: string; text?: string }[]): unknown {
  const texts = content.filter((i) => i.type === "text" && i.text).map((i) => i.text!);
  if (!texts.length) throw new Error("WanGP tool returned no structured data.");
  const values = texts.map((t) => JSON.parse(t));
  return values.length === 1 ? values[0] : values;
}
```

Also honour `isError`: the failure detail is in the text content items, not the transport error.

---

## 4. Discovery: choosing a model

`wangp_list_models` returns entries with far more than a name. A live payload carries:

```
model_type, family, family_label, base_model_type, finetune,
main_output, outputs, inputs, media_inputs, capabilities,
setting_values, name, availability
```

### 4.1 `main_output` lies — read `outputs`

**This one bites early.** LTX-2 reports `main_output: "image"` while its `outputs` array contains
`video` and `audio`. Filtering the catalogue on `main_output` classifies a flagship video model as
an image model and hides it entirely.

```ts
function outputsOf(model) {
  return model.metadata.outputs?.length ? model.metadata.outputs : [model.metadata.mainOutput];
}
const produces = (model, kind) => outputsOf(model).includes(kind);
```

### 4.2 Availability: the expensive silent failure

`availability` is `available`, `partial` or `missing`.

> **WanGP will happily accept a job for a model it does not have, and download the weights first.**
> That can be tens of gigabytes, and the MCP side reports **no download progress** — the job simply
> appears to hang for a very long time.

Default your model lists to installed-only, and if you ever select a `missing` model, log it loudly:

```ts
...(availability === "missing"
  ? { warning: "weights_not_installed_wangp_will_download_first" }
  : {})
```

### 4.3 Pin models; don't trust automatic ranking

With ~200 models and no quality ranking, automatic selection cannot distinguish a general
text-to-image model from an inpainting, avatar or control variant with a similar name. Let operators
**pin** an explicit model, and treat automatic selection as a fallback. Log which model was chosen
and whether it came from a pin — a silent substitution is very hard to debug from output alone.

### 4.4 Capabilities live on metadata, not the schema

`wangp_get_model_schema` returns settings, not capabilities. Capability flags — `media_inputs`,
`capabilities.lora`, `family`, `base_model_type` — come from `wangp_list_models` /
`wangp_get_model_metadata`. Merge the two before deciding what a model can do.

Usefully, `wangp_list_models` already includes `family`, `base_model_type` and `capabilities` per
entry, so a per-model metadata round-trip is usually avoidable.

---

## 5. The generation model: settings manifests

This is the biggest conceptual difference from a typical image API. **You do not pass parameters.
You pass a complete settings dictionary.**

The working pattern:

```
1. wangp_get_default_settings(model_type)   -> the full default payload
2. wangp_get_model_schema(model_type)       -> which fields exist, and their bounds
3. copy the defaults verbatim
4. override ONLY the fields the schema declares
5. wangp_generate({ source: settings, wait: false })
```

Copying the defaults matters: WanGP expects a complete payload, and fields you omit are not
defaulted for you.

### 5.1 Only write fields the model declares — and know when that hides a bug

```ts
const fieldNames = new Set(schema.fields.map((f) => f.name));
const setIf = (name: string, value: unknown) => {
  if (fieldNames.has(name) && value !== undefined) settings[name] = value;
};
```

This helper is necessary, and it is also **the single most dangerous line in the integration.**

> A `setIf` on a field the model does not declare is a **silent no-op**. The job runs, output
> appears, and the feature you thought you enabled simply did not happen.

StoryForge lost time to this three separate times — with reference images, with prompt-type letters,
and with LoRAs. The discipline that fixes it:

- For anything **optional and cosmetic**, `setIf` is fine.
- For anything **the user explicitly asked for**, check the capability first and **raise** if it is
  absent. A refusal is recoverable; a plausible-looking wrong render is not.

### 5.2 Validate against published bounds

Schemas publish `allowed` choice lists and `min`/`max`/`step` for numerics. Clamp to them. Frame
count in particular is fiddly: many video models want a multiple-of-8 plus one.

```ts
export function frameCountForFps(fps: number, seconds: number): number {
  return Math.ceil((fps * seconds) / 8) * 8 + 1;
}
```

Frame count and frame rate are **independent controls**, and not all models expose both. Some models
have `video_length` but no fps field whatsoever. Deriving length only when an fps field existed left
every clip at the model's default duration — an easy bug to ship.

### 5.3 Disable the prompt enhancer

WanGP can rewrite your prompt with its own local LLM before generating, and **several models ship
with it enabled** (LTX-2 22B defaults to `"T"`). That silently discards the prompt your application
carefully constructed.

```ts
if (fieldNames.has("prompt_enhancer")) settings.prompt_enhancer = "";
```

---

## 6. Field-name drift, and the canonical alias layer

Different models express the same concept under different keys:

| Concept | Observed keys |
|---|---|
| Frame rate | `force_fps`, `fps`, `frames_per_second`, `frame_rate` |
| Clip length | `video_length`, `num_frames`, `frame_num` |
| Start frame | `image_start`, `start_image`, `start_frame`, `input_image`, `image` |
| Source clip | `video_source`, `source_video`, `input_video` |
| Steps | `num_inference_steps`, `steps` |
| Guidance | `guidance_scale`, `cfg_scale` |

**Do not scatter this across your codebase.** Define one canonical vocabulary, list the aliases per
concept, and resolve them against the keys a model actually exposes:

```ts
export const CANONICAL_ALIASES = {
  force_fps:   ["force_fps", "fps", "frames_per_second", "frame_rate"],
  video_length:["video_length", "num_frames", "frame_num"],
  image_start: ["image_start", "start_image", "start_frame", "input_image", "image"],
  video_source:["video_source", "source_video", "input_video"],
  activated_loras: ["activated_loras"],
  loras_multipliers: ["loras_multipliers"],
  // …
} as const;

/** canonical -> the real key on this model; omitted when unsupported. */
export function resolveFieldMap(keys: ReadonlySet<string>): FieldMap { /* … */ }
```

The rest of the application speaks only canonical names. Rename to the model's real keys immediately
before `wangp_generate`, and rename discovered defaults the other way when normalising a schema.
**Model and version drift then lives in exactly one table.** A canonical name being *absent* from the
map is also how you detect an unsupported capability — cleaner than probing.

---

## 7. Media inputs: keyframes, references, continuation

The trickiest area, and the least discoverable.

### 7.1 Media inputs are not in the default settings

`image_refs` and `video_source` generally do **not** appear in `wangp_get_default_settings`. They are
advertised through the `media_inputs` capability map instead:

```
media_inputs.image.start      -> image_start
media_inputs.image.end        -> image_end
media_inputs.image.reference  -> image_refs
media_inputs.image.control    -> image_guide
media_inputs.image.mask       -> image_mask
media_inputs.video.continue   -> video_source
```

If you derive your field list only from published defaults, these capabilities are invisible.
Synthesise the field entries from the capability flags.

### 7.2 The prompt-type letter codes

Two fields carry letter sets that **activate** media inputs. Passing the media without the letter is
ignored; passing the letter without the media fails the job.

**`image_prompt_type`** — LTX-2 publishes `allowed: "TSEVL"`:

| Letter | Meaning |
|---|---|
| `S` | start image |
| `E` | end image |
| `SE` | start + end keyframes |
| `V` | continue from a source video |
| `L` | continue from the last generated video |

**`video_prompt_type`** — carries the *reference image* group (`letters_filter: "KI"`):

| Value | Meaning |
|---|---|
| `""` | no references |
| `"KI"` | first reference is the main subject / landscape, others may follow |
| `"I"` | references are people / objects — the one for character identity |

Three counter-intuitive facts:

1. **Reference images are activated by `video_prompt_type`, even on pure image models.** Image models
   publish `image_prompt_type.allowed = ""` (text only) while the reference group hangs off
   `video_prompt_type`.
2. **Set these fields explicitly; never append to the default.** Flux 2 Klein ships `"MV"`
  (mask + video guide) — keeping that makes WanGP demand images you are not sending. LTX-2 ships
  `"SE"`, so source-video continuation without an endpoint must overwrite it with `"V"`; when an
  end image is supplied too, use the combined letter set `"EV"`.
3. **Continuation replaces the start image, not necessarily every keyframe.** A source video and
  an end image are composable as `"EV"`, letting the prior clip provide the opening state while
  the end image supplies the destination.

### 7.3 Paths are opened by the WanGP process

`image_refs`, `image_start` and `video_source` take **absolute paths readable by WanGP**, not
uploads. Good news: a bad path fails the job immediately with `[Errno 2]` rather than silently
rendering the wrong thing. Bad news: if WanGP is on another machine, these paths must be valid
*there*.

---

## 8. Job lifecycle

### 8.1 Submit and poll

```ts
const raw = await call("wangp_generate", { source: settings, wait: false });
const jobId = raw?.job_id ?? raw?.jobId ?? raw?.id;
```

Use `wait: false` and poll. Generation takes **minutes**; a synchronous wait ties up a request
thread for the duration. StoryForge polls every 3 s with a 600-attempt ceiling — a 30-minute budget
per job.

### 8.2 Job status is an event log, not a status field

`wangp_get_job` returns an **event log plus a terminal result**, not a tidy status string. You derive
status yourself:

```ts
if (typeof source.done === "boolean") {
  if (!source.done) {
    // WanGP does not always emit a "started" event, but any progress report
    // means it is under way — otherwise a job at 68% still reads as "submitted".
    const started =
      events.some((e) => e?.kind === "started") ||
      (progressFromEvent ?? 0) > 0 ||
      events.some((e) => e?.kind === "progress" || e?.kind === "stream");
    status = started ? "running" : "submitted";
  } else if (result?.cancelled === true) status = "cancelled";
  else status = result?.success === true ? "completed" : "failed";
} else {
  // Older/alternate builds emit a flat { status, progress }.
  status = coerceStatus(source.status) ?? (generatedFiles.length ? "completed" : "running");
}
```

Accept both shapes. Output paths arrive as `result.generated_files`, with `generated_files` and
`outputPaths` seen as alternates.

### 8.3 WanGP runs exactly one job at a time

Submitting while a job is running fails with *"session already has a generation in progress"*.
Serialise every submission through a single chain:

```ts
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const previous = queue.current ?? Promise.resolve();
  // Swallow the predecessor's failure so one bad job cannot poison the queue.
  const run = previous.catch(() => undefined).then(task);
  queue.current = run.catch(() => undefined);
  return run;
}
```

**This only protects one process.** A second instance of your app — or a human using the WanGP web
UI — can still take the session out from under you. Detect the condition explicitly and surface a
comprehensible message rather than a raw error:

```ts
export function isSessionBusyError(err: unknown): boolean {
  return /generation in progress/i.test(err instanceof Error ? err.message : String(err));
}
```

### 8.4 Transient GPU faults are normal

CUDA errors and out-of-memory failures happen mid-batch, especially when models are being swapped.
Classify them and retry with a settle delay so VRAM is released between attempts. Distinguish them
from permanent failures (bad settings, missing file), which retrying will never fix.

If anything else on the machine competes for the GPU — a local LLM, for instance — evict it before a
long generation run. Overlapping them does not fail cleanly; WanGP thrashes and dies partway through.

---

## 9. LoRAs

### 9.1 There is no LoRA tool

**The MCP server exposes no LoRA inventory or metadata tool.** Verified against v1.10.1 and
re-confirmed on a running server: 11 tools, none LoRA-related. The WanGP UI manages LoRAs, but that
capability is not surfaced over MCP.

So discovery must read the filesystem. Structure it so an upstream tool can take over later without
a rewrite: try the tool names first, fall back to disk.

```ts
const candidates = ["wangp_list_lora_presets", "wangp_list_loras", "wangp_get_loras"];
const toolName = await findTool(candidates);
if (!toolName) return listLocalLoras(loraRoot, identity);   // filesystem fallback
```

### 9.2 Directory layout, and how to map a model to it

WanGP stores LoRAs per family under `loras/<directory>/`, with a sibling `loras_metadata/`. A
typical install has ~42 family directories (`flux2_klein_9b`, `ltx2`, `qwen`, `wan_i2v`, …).

Mapping a model to its directory is not obvious. **Test candidates against the real on-disk listing**
rather than hardcoding a family table:

```ts
// Specific first, then general. base_model_type is more precise — flux2_klein_9b
// has its own folder that family "flux2" would miss — but it is not always a real
// directory: a model reporting base_model_type "ltx2_22B" has no such folder,
// while its family "ltx2" does. An "old_ltx2_22B" folder exists and is the wrong
// answer, so testing against disk is what gets this right.
const candidates = [identity.baseModelType, identity.family, identity.modelType];
for (const candidate of candidates) {
  const hit = directoriesOnDisk.get(candidate?.toLocaleLowerCase());
  if (hit) return hit;
}
```

`family` is generally the correct routing key; `base_model_type` can disagree with it.

Filter to `.safetensors` and `.sft`, immediate children only. **`.lset` files are LoRA *presets*, not
weights** — that is what the unimplemented `wangp_list_lora_presets` refers to — and must not appear
in a picker.

### 9.3 Filenames are frequently unusable — read the sidecars

Many installed LoRAs have opaque names like `2GQ3Z0DP0SC5B3SB6Q40MJG3V0.safetensors`. The sidecar at
`loras_metadata/<family>/<name>.json` is a Civitai-style record:

```json
{ "name": "Portrait Booster V2", "trainedWords": ["pbv2"],
  "trainingDetails": { "params": { "ecosystem": "flux2klein" } } }
```

- `name` — a human-readable label. Without this a picker is unusable.
- `trainedWords` — **trigger words**. Many LoRAs do nothing unless one appears in the prompt, so this
  is a correctness concern, not a nicety.
- `trainingDetails.params.ecosystem` — an independent compatibility cross-check.

Degrade to the bare filename when a sidecar is missing or malformed.

### 9.4 Sending LoRAs

Two fields, matched **by index**:

```ts
settings.activated_loras   = loras.map((l) => l.name);              // bare filenames
settings.loras_multipliers = loras.map((l) => l.strength).join(" "); // "1 0.35"
```

`activated_loras` takes **bare filenames**, resolved by WanGP relative to the family directory —
never paths.

### 9.5 `loras_multipliers` is a mini-DSL

A single number per LoRA is valid but lossy. Real installs use three delimiters:

```
1                    single value
.40  .85             leading-dot decimals are accepted
0.5;1                ';' separates phases within one LoRA (high/low-noise experts)
0;0.8 0.4;0          ' ' separates LoRAs, ';' separates phases
1|                   '|' separates step-range values (time-varying strength)
1;1|0.35;0 0;0.75    all three combined
```

WanGP tolerates a **shorter** multiplier list than the LoRA list, so index alignment is not enforced
server-side — but emit aligned values anyway. If you ever read an existing multiplier string back,
preserve it verbatim; round-tripping it through a numeric UI silently discards phase and step
information.

### 9.6 The determinism trap

> **`activated_loras` in the published defaults is WanGP's *saved UI state*.**

WanGP persists per-model settings to `settings/<model_type>_settings.json`, and the MCP server
reflects those back as defaults. If a human last selected two LoRAs in the WanGP window, your
"default" settings contain them — and copying defaults verbatim (§5) inherits them.

The result is genuinely non-deterministic rendering: the same job produces different output
depending on what someone last clicked in another application, with nothing in your logs to explain
it.

**Always write `activated_loras` explicitly, including as an empty array when nothing is selected.**
Write `loras_multipliers` alongside it, or a stale multiplier string will mis-weight a fresh stack.

Reassuringly, this is safe to overwrite: genuine *system* LoRAs (a distilled model's own
acceleration LoRA, HDR or control adapters) are declared separately in the model definition as
download URLs and load independently of `activated_loras`.

### 9.7 It is not only the LoRAs

`activated_loras` is the most-discussed instance, but it is not a special case — **every** field in
the published defaults is saved UI state. Two more cost real time:

- **`batch_size`.** A `2` left over from a previous session turned ten queued jobs into twenty-one
  output files and doubled the wall clock of an unattended run. Every job succeeded; the count was
  simply wrong.
- **`num_inference_steps`.** Returned as `4` — correct for the Lightning LoRA selected in the window
  when those settings were saved, and a smeared mess once the client stripped that LoRA out per
  §9.6. The output was plausible rather than absent, which sent the investigation into prompt
  construction instead.

Treat the published defaults as **a starting point contaminated by another process**, not as
defaults. Pin every field that is genuinely yours — at minimum `batch_size`, `repeat_generation`,
`num_inference_steps` and `activated_loras`.

---

## 10. Output files and path security

Generated files come back as **absolute paths on the WanGP host**, not bytes. Two consequences:

- **Same machine:** you can serve them, but they live outside your web root. Every path that reaches
  a streaming route must be proven to sit inside an approved root — with **both** a lexical check
  and a symlink-resolved (`realpath`) check, so neither `../` traversal nor a symlink escape gets
  through.
- **Different machines:** you need a share, and the paths WanGP reports must be translatable to
  something your app can read.

```ts
export function isPathInsideRoot(candidate: string, approvedRoot: string): boolean {
  const root = path.resolve(approvedRoot);
  const relative = path.relative(root, path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
```

Make the WanGP output directory an explicit config value. Never derive an approved root from a path
the server handed you.

---

## 11. Gotchas, condensed

| # | Gotcha | Consequence |
|---|---|---|
| 1 | `main_output` misclassifies multi-output models | LTX-2 looks like an image model; read `outputs` |
| 2 | Uninstalled models are accepted and downloaded | Job hangs for tens of GB with no progress |
| 3 | `setIf` on an undeclared field is a silent no-op | Feature quietly does nothing; output looks fine |
| 4 | Media inputs absent from default settings | `image_refs` / `video_source` invisible unless derived from `media_inputs` |
| 5 | Prompt-type letters must be **set**, not appended | Model demands images you never sent |
| 6 | References activate via `video_prompt_type` | Even on pure image models |
| 7 | `prompt_enhancer` defaults on for some models | Your prompt is silently rewritten |
| 8 | One generation session, globally | Concurrent submits fail; the web UI can steal it |
| 9 | Job status is an event log | No status string to read; derive it |
| 10 | No LoRA tools exist | Filesystem discovery is mandatory |
| 11 | `activated_loras` defaults are saved UI state | Non-deterministic renders unless written explicitly |
| 11a | So are `batch_size` and `num_inference_steps` | Duplicate output files; a 4-step render with no Lightning LoRA |
| 12 | `.lset` files are presets, not weights | Must be excluded from LoRA listings |
| 13 | LoRA filenames are often opaque hashes | Sidecar metadata is effectively required |
| 14 | Outputs are host paths, not bytes | Containment checks required before serving |
| 15 | `family` and `base_model_type` can disagree | Routes LoRA lookups to the wrong folder |
| 16 | Frame count and fps are independent | Some models have length but no fps field |

---

## 12. Integration checklist

- [ ] MCP client with lazy single-flight connect and a hard tool allow-list
- [ ] Result unwrapping handles `structuredContent`, `{ result: … }` and text-JSON
- [ ] `findTool()` in place so optional tools can be adopted without a rewrite
- [ ] Catalogue filtered on `outputs`, not `main_output`
- [ ] Model lists default to installed-only; `missing` selections logged loudly
- [ ] Explicit model pinning supported; chosen model and pin status logged
- [ ] Capability metadata merged with the settings schema before deciding anything
- [ ] Defaults copied verbatim; only declared fields overridden
- [ ] Capability checked and an error raised for anything the user explicitly requested
- [ ] Canonical field vocabulary with an alias table; renaming confined to one place
- [ ] Media-input fields synthesised from `media_inputs` flags
- [ ] Prompt-type letters set explicitly, never appended
- [ ] `prompt_enhancer` disabled
- [ ] Numeric values clamped to published bounds; frame counts aligned
- [ ] Submissions serialised; "generation in progress" detected and explained
- [ ] Polling with a sane interval and a hard attempt ceiling
- [ ] Job status derived from the event log, with the flat shape accepted too
- [ ] Transient CUDA/OOM faults retried with a settle delay
- [ ] LoRA discovery via filesystem, with an MCP-first fallback path
- [ ] LoRA directory resolved against the real on-disk listing
- [ ] `.safetensors` / `.sft` only; `.lset` excluded; no recursion
- [ ] LoRA names validated as bare filenames; no separators or dot segments
- [ ] Sidecar metadata read for labels and trigger words
- [ ] `activated_loras` written on **every** job, empty when nothing is selected
- [ ] `loras_multipliers` written alongside, index-aligned
- [ ] Output paths validated against approved roots, lexically and via `realpath`

---

## 13. Summary

The Wan2GP MCP server gives you a genuinely capable local generation engine behind a small, generic
tool surface. The transport is easy. The difficulty is that **WanGP is discovery-driven**: with ~200
models and no shared field contract, your integration is mostly a negotiation layer.

Five things decide whether the result is dependable:

1. **Discover, never assume.** Field names, capabilities and media inputs vary per model. Centralise
   the drift in one alias table.
2. **Silent no-ops are the enemy.** Writing an undeclared field does nothing and still produces
   output. Anything the user explicitly asked for must be capability-checked and refused loudly.
3. **Media inputs need their activation letter.** The media alone is ignored; the letter alone fails
   the job; and the default letter usually has to be replaced rather than extended.
4. **Respect the single session.** One job at a time, globally — including humans at the web UI.
   Serialise, and degrade gracefully when you lose the race.
5. **LoRAs are off-contract.** No MCP tool, filesystem discovery, opaque filenames needing sidecars,
   a multiplier mini-DSL, and defaults that leak another application's UI state into your renders.

Get those right and WanGP is a solid generation backend. Skip them and it will appear to work while
quietly rendering something other than what you asked for — which is far harder to notice than an
outright failure.
