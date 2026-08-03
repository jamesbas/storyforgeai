# Wan2GP MCP Server — issues encountered

Findings from building [StoryForgeAI](https://github.com/jamesbas/storyforgeai), an
MCP client that drives Wan2GP for multi-scene video production.

This is the **problems** list. The companion document,
[Wan2GP MCP Usage.md](Wan2GP%20MCP%20Usage.md), is the how-to guide and covers the
same server from the other direction — what to do rather than what went wrong.

Everything here was found against a live server over several weeks of integration.
None of it is a complaint: WanGP does the hard part, and most of these are the
kind of thing that is only visible from outside. They are written up in the hope
they are useful to the maintainers and to anyone else building a client.

**Severity** is from an integrator's point of view:

| | Meaning |
|---|---|
| **High** | Produces wrong output that looks correct. No error, no log line. |
| **Medium** | Costs real time to diagnose, but fails visibly or is inert. |
| **Low** | Surprising, documented nowhere, cheap to work around once known. |

---

## 1. Published defaults are saved UI state

**Severity: High.** The single most expensive class of problem in this list, and
it caught me three separate times before I understood the shape of it.

WanGP persists per-model settings to `settings/<model_type>_settings.json`, and
`wangp_get_default_settings` reflects those back. A client must copy the defaults,
because the server wants a complete payload — so it silently inherits whatever a
human last clicked in the WanGP window.

The failure is total silence. The job succeeds, output appears, and nothing in
either system's logs explains why the render differs from the last one.

### 1a. `activated_loras`

My renders were quietly picking up two LoRAs I had never selected in my own
application. Same job, different output, depending on what someone last did in
another program.

**Workaround:** always write `activated_loras` explicitly, including as an empty
array. Write `loras_multipliers` alongside it, or a stale multiplier string
mis-weights a fresh stack.

Worth recording that this is safe to overwrite: a distilled model's own
acceleration LoRA and any HDR or control adapters are declared separately in the
model definition as download URLs, and load independently.

### 1b. `batch_size` — and it is not only the LoRAs

This is the part I missed for longest, because I had "fixed" the problem by
special-casing LoRAs and assumed the field was special.

A `batch_size: 2` left over from a previous session turned ten queued jobs into
**twenty-one output files** and doubled the wall clock of an unattended batch
run. Every job succeeded. The count was simply wrong.

### 1c. `num_inference_steps`

The worst of the three, because the output was plausible rather than absent.

`num_inference_steps` came back as **4** — entirely correct for the Lightning
LoRA that had been selected in the window when those settings were saved. My
client then stripped that LoRA out per 1a, and rendered a 4-step job without it.
The result was a smeared mess that looked like a bad seed or a bad prompt, and I
went looking for the fault in my prompt construction.

**Workaround for the class:** treat the published defaults as a *starting point
contaminated by another process*, not as defaults. Pin every field that is
genuinely yours — at minimum `batch_size`, `repeat_generation`,
`num_inference_steps` and `activated_loras`.

**Possible server-side fix:** separate "model defaults" from "last used settings"
in the tool surface, or flag which returned fields came from persisted UI state.
A client currently has no way to tell the difference.

---

## 2. `setIf` on an undeclared field is a silent no-op

**Severity: High.**

Writing a field the model does not declare does nothing, reports nothing, and
produces a successful job. The feature you believe you enabled simply did not
happen, and the output looks fine.

I lost time to this three times over: with reference images, with prompt-type
letters, and with LoRAs.

**Workaround:** for anything cosmetic, silently skipping is fine. For anything
the *user explicitly asked for*, check the capability first and raise. A refusal
is recoverable; a plausible-looking wrong render is not — you do not know to go
looking for it.

---

## 3. `main_output` misclassifies multi-output models

**Severity: Medium.**

LTX-2 reports `main_output: "image"` while its `outputs` array contains video.
Any client filtering a catalogue on `main_output` hides a flagship video model
completely — and does so without error, so it presents as "that model isn't
available on this server".

**Workaround:** read `outputs`, not `main_output`.

---

## 4. There is no LoRA discovery tool

**Severity: Medium.**

Eleven tools are advertised and none of them list LoRAs, so discovery has to read
the `loras/` folder from the filesystem. That forces a client into the same host
as the server, or into a shared mount, for information the server already has.

Mapping a model to its folder is not obvious either:

- `family` is the right key; `base_model_type` can disagree with it.
- There are decoy folders. The distilled LTX-2 model reports `ltx2_22B`, which is
  not a directory, while `old_ltx2_22B` is.
- `.lset` files are presets, not weights, and must be excluded from listings.
- Filenames are frequently opaque hashes, so the `loras_metadata` sidecars are
  effectively required to show anything a human can choose from.

**Suggested fix:** a `wangp_list_loras(model_type)` tool would remove the need
for filesystem access entirely. I would happily delete my fallback code for it.

---

## 5. Media inputs are absent from the published defaults

**Severity: Medium.**

`image_refs` and `video_source` are advertised through `media_inputs` capability
flags rather than appearing in the default settings. A client that derives its
field list from defaults alone — the obvious implementation — never sees them,
and reference images silently never take effect. This compounds directly with
issue 2.

---

## 6. Reference images activate via `video_prompt_type`, even on pure image models

**Severity: Low**, once known — but genuinely counter-intuitive, and enforced in
both directions:

- references without the letter are ignored, silently;
- the letter without references fails the job.

The letters must be **set**, not appended, or the model demands images that were
never sent.

---

## 7. `prompt_enhancer` defaults on for some models

**Severity: Low.**

LTX-2 22B ships with `"T"`, which silently rewrites a carefully constructed
prompt. For a client whose entire purpose is prompt construction this is
directly counterproductive, and there is nothing in the output to indicate the
prompt was changed.

**Workaround:** write it off explicitly.

---

## 8. Job status is an event log, not a status field

**Severity: Low.**

There is no status string to read; the state has to be derived from the event
log. Reasonable once understood, but it is the sort of thing every client will
reimplement slightly differently.

Related: WanGP runs exactly one generation session globally. Concurrent submits
fail, and the web UI can take the session from an API client mid-run — worth
knowing before building an unattended batch queue on top of it.

---

## Summary for a maintainer

If only one thing on this list were addressed, I would pick **issue 1**. The
others cost me hours; that one produced confidently wrong output three times in
three different ways, and in each case the logs on both sides said everything had
worked.

The common thread across issues 1, 2, 3 and 5 is the same: **the failure mode is
silence.** A wrong LoRA stack, an ignored field, a hidden model, a dropped
reference image — none of them raise, and all of them yield output that looks
entirely plausible. Errors are cheap to handle. It is the successes that lie
which are expensive.
