# App-wide LM Studio system prompt overrides

## Decision

This feature is feasible. StoryForgeAI calls LM Studio through its
OpenAI-compatible chat-completions API and already sends a `system` role message
on every planning request. LM Studio documents `system` messages for both
`/v1/chat/completions` and `/api/v0/chat/completions`.

There is an important boundary: StoryForgeAI's existing system text is an
operational contract, not just a model persona. It carries artifact-specific
instructions, continuity rules, and the schema hint needed for valid structured
output. A user setting cannot replace that text without making otherwise valid
work fall back to deterministic builders.

For this feature, "override" therefore means an app-wide user instruction layer
that takes precedence over the creative behavior of the built-in agent prompt,
while the built-in artifact and output requirements remain mandatory. With no
custom prompts saved, StoryForgeAI sends exactly the same system messages it
sends today. It does not remove its built-in system message in an attempt to
recover a separate default configured in LM Studio.

## User contract

- Settings offers three optional prompts, one per workflow:
  - **Agentic Canvas** for Variant Explorer, World Builder, Director,
    Cinematographer, and Art Director calls, including follow-up calls that fill
    missing plan segments.
  - **Storyboard** for Intake Producer, Story Architect, Visual Bible, and
    Storyboard Artist calls, including segment-gap follow-ups. These agents write
    the brief, arc, continuity guide and scene cards, and are told not to write
    render prompts.
  - **Render prompts** for the Image Prompt and Video Prompt agents, including
    the acceptance-gate retry. These are the only agents whose output reaches an
    image or video model.
- The scopes are separate because the workflows want contradictory instructions:
  a keyframe rule handed to a narrative agent makes it answer with a render
  prompt instead of the scene card it was asked for.
- The set is all-or-nothing. All three must contain non-whitespace text to enable
  custom prompting. Clearing all three disables it. A partial set is a validation
  error and does not modify the saved settings.
- The setting is app-wide and affects future model calls for every project. It
  does not rewrite already generated artifacts or prompts.
- Concept enhancement/reading, audio direction, and QC are outside these three
  workflows and retain their existing system prompts.
- Prompt text is never written to telemetry or execution provenance.

## Prompt precedence

For a scoped call, the provider constructs one system message in this order:

1. A short marker stating that the following custom instructions govern
   creative behavior but cannot relax the artifact/output contract.
2. The matching custom prompt.
3. The existing built-in agent system prompt and its runtime directives.
4. The existing generated schema hint.

The custom text comes first so it frames behavior, while the built-in contract
comes last so requirements such as exact JSON keys, scene continuity, and
required fields remain closest to generation. Conflicts about output shape,
required fields, safety checks, or artifact scope are resolved in favor of the
built-in contract.

## Data and API design

- Add a versioned `system-prompt-settings.json` beside the existing app-wide
  generation defaults under `STORYFORGE_DATA_DIR`.
- Shape: `version`, optional `agenticCanvas`, `storyboard` and `renderPrompts`,
  and `updatedAt`. The schema refines the set so every value is present or every
  value is absent, trims saved values, and applies a finite per-prompt character
  limit.
- Reads are fail-soft: a missing, corrupt, or outdated file behaves as disabled.
  A file saved before a scope was added therefore reads as disabled rather than
  as a partial policy.
- Writes are serialized and replace every scope atomically from the caller's
  point of view.
- Add `GET` and `PUT /api/settings/system-prompts`. Responses use `no-store`.
  `PUT` accepts the complete editable set, not a partial patch, so two browser
  writes cannot produce a half-configured state.

## Application design

- Extend model generation options with an explicit prompt scope:
  `agentic_canvas | storyboard | render_prompts`.
- Resolve and compose the saved prompt centrally in the OpenAI-compatible
  provider immediately before the existing schema hint is appended.
- Unscoped calls and disabled settings preserve the current system text exactly.
- Pass the Canvas scope at Canvas agent and Canvas segment-gap call sites.
- Pass the Storyboard scope through intake, story planning, the visual bible, the
  storyboard batch writer, and the story-plan segment-gap calls.
- Pass the render scope at the image prompt call, its gate retry, and the video
  prompt call.
- Add a Settings section with three text areas, one Save action, one Clear
  action, a shared status region, character counts, and copy that names the
  agents each scope reaches. Because a prompt written for the wrong scope
  degrades output without failing, the panel also warns about the common misuse
  patterns and links to the Help section covering them.

## Validation and tests

- Schema/service tests: fresh install, round trip of every scope, whitespace
  trimming, partial-set rejection, all-empty clearing, length bounds, and
  corrupt-file fallback.
- Provider composition tests: disabled settings preserve the original prompt;
  each scope receives only its matching prompt; the built-in prompt and schema
  hint remain present; unscoped calls receive no custom text.
- Agent routing tests: representative Canvas, Storyboard, render-prompt, retry,
  and segment-gap calls carry the intended scope.
- Component tests: load, complete save, partial-set client validation, clear,
  busy, success, and server failure states.
- Run `npx vitest run`, `npm run typecheck`, and `npm run lint`. Do not run a
  production build while a generation is active.

## Release and documentation

This is user-visible behavior. Before shipping, bump the app version by `0.01`,
add the same user-facing row to README and CHANGELOG, keep five README rows, and
document the three scopes and the fact that built-in artifact contracts remain in
force.