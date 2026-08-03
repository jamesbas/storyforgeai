# Using LM Studio Models From an Application

A practical guide to driving local LLMs served by **LM Studio** from a production application.

This is written as a **portable pattern**, not as documentation of StoryForgeAI. StoryForgeAI is
used only as the worked example — every technique, failure mode and workaround below was learned by
running a real workload against a local model on a single consumer GPU. Where something is
StoryForge-specific it is called out as such so you can discard it.

**Audience:** an application developer wiring a local LLM into a product for the first time.

---

## 1. What LM Studio is

LM Studio is a desktop application for running open-weight LLMs locally. For an integrator, three
things matter:

1. **It is a model runner.** You download a model (GGUF or MLX), it loads it into VRAM/RAM and
   serves it.
2. **It exposes an OpenAI-compatible HTTP server.** Point any OpenAI SDK at
   `http://127.0.0.1:1234/v1` and most code "just works" without a rewrite.
3. **It is a GUI-first tool with a headless surface bolted on.** This is the root of most of the
   gotchas in §7 — the server reflects state a human may be changing underneath you.

**Why an app would target it:** zero per-token cost, no data leaving the machine, offline
operation, and free model swapping. **Why it might not suit you:** it is a *desktop* application,
not a service. It has no multi-tenancy, no authentication worth the name, and it assumes one user
on one machine. For a server deployment, prefer vLLM, Ollama in server mode, or llama.cpp's
`llama-server`.

The good news: if you integrate along the lines below, LM Studio, Ollama and llama.cpp are all
reachable through the same code path — only the base URL changes.

---

## 2. The three interfaces

This is the single most useful thing to know, and it is under-documented. LM Studio exposes
**three** separate control surfaces, and you will need all three for a serious integration.

| Interface | Endpoint / command | Use it for |
|---|---|---|
| OpenAI-compatible API | `http://<host>:1234/v1` | Inference: chat completions, embeddings |
| Native REST API | `http://<host>:1234/api/v0` | Introspection: which models exist, which are **loaded**, context sizes |
| `lms` CLI | `lms load`, `lms unload` | Lifecycle: loading and evicting models |

Two consequences worth internalising:

- **`/v1/models` is not enough.** It lists models but does not reliably tell you what is *resident
  in memory*. `/api/v0/models` returns a `state` field (`"loaded"` / `"not-loaded"`) plus
  `loaded_context_length` and `max_context_length`. If you need to know whether the GPU is
  currently occupied, this is the endpoint.
- **There is no HTTP endpoint to load or unload a model.** The `lms` CLI is the only interface that
  exposes it. If your app needs to manage GPU residency (§6), you are shelling out to a binary —
  plan for that in your security review.

Deriving one base from the other is trivial, since they share an origin:

```ts
// The configured OpenAI base URL ends in /v1; the native API is /api/v0 on the same origin.
function restBase(openAiBaseUrl: string): string | null {
  try {
    return new URL(openAiBaseUrl).origin;
  } catch {
    return null;
  }
}
```

---

## 3. Minimum viable integration

Treat LM Studio as "OpenAI with a different base URL". Do **not** write an LM Studio-specific
client.

```ts
const client = new OpenAI({
  // Local servers ignore the key, but the SDK rejects an empty string.
  apiKey: process.env.OPENAI_API_KEY || "local",
  baseURL: process.env.OPENAI_BASE_URL,   // e.g. http://127.0.0.1:1234/v1
  timeout: 240_000,                        // local inference is slow; see §7.6
  maxRetries: 1,
});
```

### Configuration surface

Keep every one of these an environment variable. A local-model integration needs far more tuning
than a hosted-API one, and the values are machine-specific.

| Variable | Purpose | Sensible default |
|---|---|---|
| `OPENAI_BASE_URL` | Points at LM Studio; **its presence is what marks the deployment "local"** | unset (= hosted) |
| `OPENAI_MODEL` | Model id exactly as LM Studio reports it | — |
| `OPENAI_API_KEY` | Ignored locally, required non-empty by the SDK | `local` |
| `OPENAI_MAX_TOKENS` | Completion budget — **reasoning models spend this on thinking** (§5) | 12000 |
| `OPENAI_TIMEOUT_MS` | Wall clock per request | 240000 |
| `OPENAI_TEMPERATURE` | Sampling | 0.7 |
| `OPENAI_RESPONSE_FORMAT` | Pin the JSON mode to skip negotiation (§4) | `auto` |
| `LMSTUDIO_CLI_PATH` | Path to `lms` if not on `PATH` | `lms` |

A useful trick: derive "am I talking to a local runtime?" from `OPENAI_BASE_URL` being set, rather
than adding a separate boolean. One less thing to get out of sync.

### Design the integration to be optional

The single most important architectural decision: **make the LLM path fail to `null`, and have a
deterministic fallback behind it.**

```ts
export interface PlanningProvider {
  readonly name: string;
  generateJson<T>(system: string, user: string, schema: ZodType<T>): Promise<T | null>;
}
```

Every failure — SDK missing, server down, malformed JSON, schema mismatch — returns `null`, and the
caller falls back to a deterministic code path. A local LLM is a machine on your desk that someone
may have closed. Treating it as an *enhancement* rather than a *dependency* is what keeps the
product usable.

Loading the SDK through a guarded dynamic import means a missing package degrades instead of
crashing the process:

```ts
const specifier = "openai";               // non-literal defeats bundler static analysis
const mod = await import(/* webpackIgnore: true */ specifier).catch(() => null);
const Ctor = mod?.default ?? mod?.OpenAI;
if (!Ctor) return fail("sdk_missing");
```

---

## 4. Getting structured output — the hard part

If you need JSON back, this section is where the work is. Small local models are dramatically worse
at this than hosted frontier models, and the failures are quiet.

### 4.1 Negotiate the response format, best-first

`response_format` support is inconsistent across servers *and* across model runtimes within LM
Studio. Notably, **LM Studio accepts `json_schema` and `text` but rejects `json_object`** — the
exact mode most OpenAI example code reaches for.

Use a preference ladder and step down on rejection:

```ts
const FORMAT_LADDER = ["json_schema", "json_object", "text"] as const;
```

- **`json_schema`** constrains generation to your exact shape. This is *the* thing that makes small
  local models reliable — without it they return plausible JSON with the wrong keys.
- **`json_object`** merely asks for valid JSON of any shape.
- **`text`** is the universal fallback; you parse it yourself (§4.3).

Detect a format rejection from the error message and cache the outcome **once per process** so you
pay the probe cost a single time:

```ts
function isResponseFormatRejection(message: string): boolean {
  return /response_format|json_schema|response format/i.test(message);
}
```

Expose the setting so operators can pin the known-good rung and skip the wasted first call.

> **Subtle failure worth guarding.** A server can *accept* `json_schema` and still return **empty
> content** under it — common with reasoning models. The request succeeds, `finish_reason` is
> `"stop"`, and the content is `""`. Treat "accepted but produced nothing" as a reason to step down
> the ladder too, otherwise every call for the rest of the process silently returns nothing.

Also note not every schema converts to JSON Schema. Records, unions and defaults often fail
conversion; fall through to the next rung rather than erroring.

### 4.2 Spell out the schema in the prompt

A prompt that says *"return JSON matching the CreativeBrief schema"* is meaningless to a model that
has never seen your codebase. This is the highest-yield fix available: **append a rendered key list
to the system prompt.** In StoryForge, the same model that consistently failed validation produced
conforming output immediately once the keys were spelled out.

Generate the hint from your schema so it cannot drift from the validator. Two lessons from doing
this badly first:

- **Don't count arrays as a nesting level.** Charging arrays a depth level made
  `scenes[].dialogue[]` render as a bare `object`, so the model never learned the inner keys and
  omitted them entirely. Only count *object* nesting.
- **Render numeric constraints.** A model emitted `trimAtEndSeconds: 0` to mean "no trim" against a
  `.positive().optional()` field, because the hint only said `number`. Stating `>= 1` prevented it.

The hint is a lossy prompt aid, not a specification — you still validate against the real schema.

### 4.3 Parse defensively

Even in JSON mode, expect prose wrappers, fenced code blocks and inline reasoning. A recovery
routine that handles all three:

```ts
export function extractJsonObject(content: string): unknown | null {
  // 1. Strip inline reasoning some models emit into `content` rather than `reasoning_content`.
  const withoutThinking = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const trimmed = withoutThinking || content.trim();

  // 2. Prefer a fenced block if present, else the whole string.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = [fenced?.[1], trimmed].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 3. Last resort: slice from the first { to the last }.
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* next */ }
      }
    }
  }
  return null;
}
```

### 4.4 Validate, and log *why* it failed

Always validate the parsed object against your real schema. A model that answers in the wrong shape
is the failure mode most likely to look like success.

Log a distinct reason per failure — this taxonomy pays for itself the first time you debug a
model swap:

| Reason | Meaning | Usual fix |
|---|---|---|
| `sdk_missing` | Client library absent | Install it |
| `request_failed` | Transport/server error | Check LM Studio is up |
| `format_unsupported` | Server rejected `response_format` | Automatic — steps down the ladder |
| `format_produced_no_content` | Format accepted, nothing returned | Automatic — steps down |
| `empty_response` | No content at all | Raise `max_tokens` (§5) |
| `unparseable_json` | Content was not JSON | Check `finish_reason` (§5) |
| `schema_mismatch` | Valid JSON, wrong shape | Improve the schema hint (§4.2) |

---

## 5. Reasoning models change the arithmetic

Reasoning models (Qwen3, DeepSeek-R1 and similar) are common in LM Studio and they break an
assumption baked into most OpenAI-era code:

> **`max_tokens` is spent on thinking before a single character of content is emitted.**

Practical consequences:

- **A budget that is "obviously generous" for the answer can still truncate it.** The model may burn
  8000 tokens reasoning and have nothing left. Default high — 12000 is reasonable — since an unused
  ceiling costs nothing.
- **An empty reply is ambiguous.** `finish_reason: "length"` means the budget ran out; anything else
  means the model genuinely returned nothing. Log `finish_reason` on every failure or you will be
  guessing.
- **Reasoning may arrive in either of two places.** Some servers split it into a
  `message.reasoning_content` field; others inline it into `content` as a `<think>` block. Handle
  both (§4.3), and log `reasoning_content.length` — a large value with empty content is the
  signature of an exhausted budget.

```ts
if (!content) {
  return fail("empty_response", {
    finishReason: choice?.finish_reason ?? "unknown",
    reasoningChars: choice?.message?.reasoning_content?.length ?? 0,
    ...(choice?.finish_reason === "length"
      ? { hint: "raise OPENAI_MAX_TOKENS; reasoning tokens count toward it" }
      : {}),
  });
}
```

Truncated JSON and garbage JSON look identical in a 200-character sample but need opposite fixes.
`finish_reason` is what distinguishes them — surface it.

---

## 6. GPU lifecycle — the gotcha nobody warns you about

**If your application also uses the GPU for anything else, read this section before designing.**

LM Studio keeps a model resident long after your request finishes — the default idle TTL is on the
order of an hour. On a single consumer GPU, that means any other GPU workload starts with the card
already full.

StoryForge hit this hard: planning uses an LLM, generation uses diffusion models via a separate
server, and a 16 GB card cannot hold both. Overlapping them does not fail cleanly — the diffusion
runtime thrashes swapping models through what little VRAM remains, and jobs die partway through
with CUDA faults rather than refusing up front.

**Pattern: evict before the other workload starts.**

```ts
async function freeGpuForBatch(): Promise<void> {
  try {
    const status = await getRuntimeStatus();
    if (!status.reachable || status.loadedModels.length === 0) return;
    await lms(["unload", "--all"]);
  } catch {
    // Best effort. If LM Studio is unreachable the batch still runs.
  }
}
```

Points worth copying:

- **Best-effort, never fatal.** Failing to free the GPU should not abort the work.
- **Check before acting.** If nothing is loaded, do nothing.
- **Make it configurable.** Some users manage residency themselves; give them a flag.
- **Surface manual controls.** A Load/Unload button pair plus a live "what's resident" readout saves
  enormous confusion on a shared machine.

### Shelling out safely

Because `lms` is a CLI, this is the one place your app executes a binary. Two rules:

```ts
// execFile, NOT exec: arguments go as an array with no shell, so nothing here
// can become shell injection.
const { stdout, stderr } = await execFileAsync(cliPath, args, {
  timeout: 600_000,   // loading a large model off disk is genuinely slow
  windowsHide: true,
});
```

1. **`execFile`, never `exec`.** No shell means no injection surface.
2. **Never take the model id from a request.** Read it from configuration. Otherwise your
   "load model" endpoint is an arbitrary-file-load primitive.

Detect a missing CLI specifically and say so, rather than surfacing a raw `ENOENT`:

```ts
if (/ENOENT/.test(message)) {
  throw new ValidationError(
    "Could not find the LM Studio CLI (`lms`). Install it with LM Studio, or set LMSTUDIO_CLI_PATH.",
  );
}
```

---

## 7. Gotchas

### 7.1 The loaded context window is not the model's context window

LM Studio loads a model at a context length chosen in its UI, which is **usually far below what the
model supports** — a 128k model routinely loads at 4k. Your prompt plus `max_tokens` must fit inside
the *loaded* value, not the advertised one.

`/api/v0/models` reports both:

```json
{ "id": "...", "state": "loaded", "loaded_context_length": 4096, "max_context_length": 131072 }
```

If you build long prompts, check this at startup and warn loudly. It is the most common cause of
"it worked yesterday" reports after someone reloads a model with different settings.

### 7.2 Measure prompt size without paying for generation

Send the real prompt with `max_tokens: 1` and read `usage.prompt_tokens`. Near-instant, and it tells
you exactly how much of the window each prompt consumes and what completion budget is left.

```ts
const body = await res.json();
const promptTokens = body.usage?.prompt_tokens;
```

### 7.3 `max_tokens` reserves nothing

It is a ceiling, not an allocation. Setting it to 12000 does not guarantee 12000 tokens are
available inside the context window — if the prompt already fills the window, the call fails
regardless. Size it against *observed* completion lengths, not headroom.

### 7.4 State changes underneath you

A human can load, unload or swap models in the LM Studio window mid-session. Therefore:

- Never cache "which model is loaded". Fetch it, with `cache: "no-store"`.
- Always time-bound the status call — a hung desktop app must not hang your UI:
  `signal: AbortSignal.timeout(5000)`.
- Treat "unreachable" as a **normal state**, not an error. LM Studio is frequently just closed.

### 7.5 The model id must match exactly

`OPENAI_MODEL` must be the id LM Studio reports, not the Hugging Face repo name or the UI display
name. Read it from `/api/v0/models` and copy it verbatim. A mismatch usually surfaces as a
confusing 404 or a silent fallback to whatever is loaded.

### 7.6 Everything is slower than you think

A local model on a consumer GPU can take 30–120 s for a substantial structured response. Hosted-API
defaults (often 30–60 s) will time out constantly. Budget minutes, not seconds, and make the timeout
configurable. Also set `maxRetries: 1` — SDK auto-retries against a slow local server multiply an
already long wait.

### 7.7 The API key must be non-empty

Local servers ignore it, but the OpenAI SDK throws on an empty string. Pass a placeholder such as
`"local"`.

### 7.8 Concurrency is not free

LM Studio serves requests with limited parallelism. Firing ten concurrent structured-output calls at
one local model is usually *slower* than issuing them serially, and can exhaust VRAM. Serialise, or
cap concurrency low.

### 7.9 Small models drift on long outputs

The longer the requested JSON, the more likely a key is dropped or a type slips. Prefer several
small, well-scoped calls over one large one — each is individually validatable and individually
retryable.

---

## 8. Build diagnostics early

The highest-leverage investment in a local-LLM integration is a set of tiny CLI probes. Debugging
through the full application is painfully slow when each call takes a minute. StoryForge keeps four,
and they earn their place repeatedly:

| Script | Answers |
|---|---|
| `llm:probe` | Single call: is the provider configured, does it respond, does it satisfy a representative schema, how long did it take? |
| `llm:context` | How many tokens does each prompt consume against the *loaded* window, and what `max_tokens` fits? |
| `llm:bench` | Comparative latency/quality across candidate models |
| `prompts:check` | Renders the schema hints so you can eyeball what the model is actually told |

A probe that exercises **one representative schema** is worth far more than a "hello world" chat
call, because structured output is where local models fail.

---

## 9. Integration checklist

- [ ] Talk to LM Studio through an OpenAI-compatible client; only the base URL differs
- [ ] Presence of a base URL flags the deployment as "local"
- [ ] Provider returns `null` on any failure; a deterministic fallback sits behind it
- [ ] SDK loaded via guarded dynamic import
- [ ] Response-format ladder: `json_schema` → `json_object` → `text`, negotiated once, overridable
- [ ] Step down the ladder on *empty content*, not just explicit rejection
- [ ] Schema key hints appended to system prompts, generated from the schema itself
- [ ] Numeric constraints and array-element shapes rendered in the hint
- [ ] Defensive JSON extraction: `<think>` stripping, fence unwrapping, brace slicing
- [ ] Output validated against the real schema; distinct failure reasons logged
- [ ] `finish_reason` and reasoning length logged on every failure
- [ ] `max_tokens` set generously for reasoning models
- [ ] Timeouts in minutes; `maxRetries: 1`
- [ ] Non-empty placeholder API key
- [ ] Loaded context length checked against prompt size at startup
- [ ] Model residency read from `/api/v0/models`, never cached, time-bounded
- [ ] "Unreachable" handled as a normal state
- [ ] If sharing the GPU: evict via `lms unload --all` before the competing workload
- [ ] `execFile` not `exec`; model id from config, never from a request
- [ ] Diagnostic probe scripts exist before the integration is called done

---

## 10. Summary

Integrating LM Studio is *easy* at the transport layer — it is an OpenAI-compatible endpoint and
your existing SDK works unchanged. The real work is everywhere else:

1. **Structured output** is where small local models fail. The fix is threefold: constrain
   generation with `json_schema`, tell the model your keys explicitly, and parse defensively.
2. **Reasoning models** invalidate the usual `max_tokens` intuition — the budget is consumed before
   any content appears.
3. **The context window you get is not the one advertised**, because a human chose it in a GUI.
4. **GPU residency is your problem.** LM Studio holds the card, and if anything else in your stack
   needs it, you must evict deliberately through the CLI.
5. **Design for absence.** It is a desktop application on someone's machine. Assume it is closed,
   mid-swap or busy, and degrade cleanly every time.

Get those five right and a local model becomes a genuinely dependable component. Skip them and it
will appear to work in development, then fail quietly and inexplicably in front of a user.
