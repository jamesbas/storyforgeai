# Fibo 2.0 image prompts

StoryForge recognizes Wan2GP's `fibo2_dev` and `fibo2_edit_turbo` model families.
These are not interchangeable:

| Model | Intended input | Automatic sampling | Native frame size |
| --- | --- | --- | --- |
| Fibo 2.0 Dev | Text-to-image or reference editing | 30-50 steps, guidance 5 | Approximately 1 MP |
| Fibo 2.0 Edit Turbo | Reference editing; a source image is required | 4 steps, no classifier-free guidance | Approximately 1 MP |

An explicit project step override still wins. Dev's automatic step count stays
within 30-50 after applying the project's quality floor. Turbo uses four steps
regardless of saved Wan2GP UI state. Turbo is excluded from automatic text-only
selection; an explicit Turbo pin without a reference fails with an explanation
rather than submitting an unsupported text-to-image job.

## Writing and reviewing VGL

Select Fibo as the project's image model, then write or rewrite its **image
prompts**. Existing stored prompts are not migrated automatically.

The Image Prompt Agent first writes concrete visible states: subjects and
headcount, placement, materials, background, light direction, camera angle, and
one coherent style. Quality-tag piles such as "masterpiece, ultra-detailed, 8K"
are discouraged. Existing framing, wardrobe, cast and continuity checks run on
this prose before conversion.

The configured planning model then converts both approved frames into validated
Visual GenAI Language (VGL) JSON in one additional planning call per scene.
The JSON is saved in the normal start/end prompt fields, where it can be
inspected and edited. No new BRIA API, Gemini service, credentials, or converter
dependency is introduced. Whether the configured planner is local or hosted
still depends on the existing LLM connection.

Review the JSON before rendering:

- Are the intended subjects present exactly once in `objects`?
- Do their count, appearance, clothing, contact and spatial relationships match
  the scene? Conversion checks explicit headcounts and established cast names,
  but schema validation cannot prove semantic accuracy.
- Do `lighting`, `background_setting`, `aesthetics` and
  `photographic_characteristics` describe only facts the scene established?
- Is every intended visible string recorded exactly in `text_render`, with its
  placement and typography? A quoted name or spoken line is not automatically
  lettering. Inspect the actual image for misspellings.
- Has the converter invented a prop, omitted an essential detail or changed
  composition? Correct it before spending GPU time.

Locations are semantic descriptions, not invented pixel coordinates or bounding
boxes. Unknown sections can be omitted. StoryForge supports scene captions and
structured edits with `structured_caption` and `edit_instruction`.

If planning is disabled, or conversion fails validation, StoryForge saves the
supported short-caption form, `{"short_description":"the approved frame text"}`,
without inventing structured detail. A failed conversion is recorded as degraded
`image_vgl` provenance; it is not reported as a successful full conversion.

## Rendering and reference edits

Rendering uses the saved JSON rather than asking a converter to generate it
again. Legacy prose is wrapped as a supported short caption at the boundary.
Wan2GP's optional prompt enhancer is disabled so it cannot silently rewrite the
reviewed blueprint.

When references are actually supplied, a scene caption becomes a structured edit.
The instruction names only the ordered images sent to Wan2GP, `<image_1>` through
`<image_4>`. A leading scene frame supplies the composition; subsequent portraits
supply subject identities. With portraits alone, they supply the subjects for
the requested composition. Already-authored structured edit instructions are
preserved. Reference capacity is four in Wan2GP, even though the upstream
Diffusers pipeline documents five.

For a local edit, describe the desired result and a small, specific change.
Avoid a long inventory of everything to keep unchanged. Faces, lettering,
background details and unedited areas must still be checked; preservation is not
a pixel-identity guarantee. Wan2GP supports masked editing, but StoryForge's
storyboard keyframe path does not currently expose a mask editor.

Native sizes are `1024x1024`, `1424x800`, and `800x1424` for square, landscape and
portrait projects, on a 16-pixel grid. Fibo uses these near-trained sizes for all
quality presets instead of increasing native dimensions for High. A custom
aspect ratio is scaled to approximately one megapixel, and declared model size
choices are still respected. Establish composition first and upscale separately.
BRIA's hosted 4 MP settings are not local Wan2GP inference recommendations.

Dev can use negative conditioning, including an intact JSON negative caption.
An empty negative leaves Wan2GP to choose its released mode-specific default.
Turbo ignores negative prompts and CFG; StoryForge folds supported exclusions
into positive constraints inside the caption rather than corrupting the JSON.

Bulk append/prepend adds text inside `short_description`, not after the closing
JSON brace. Review corresponding structured fields for contradictions; adding
new lettering this way also needs an explicit `text_render` entry.
Simplification must retain valid VGL, object count and exact lettering entries.
When rendering on another image family, saved VGL is flattened back to prose.

## Controlled comparisons

Keep the seed fixed and change one attribute at a time. Once the scene is right,
vary seeds for alternatives. The saved generation manifest contains the actual
submitted JSON, seed, dimensions, steps, guidance, model ID and LoRA settings.
Fibo manifests also record the StoryForge release, displayed model name and
base model type.

The current MCP schema does **not** identify the exact loaded weight file,
quantization or Wan2GP software revision. Retain Wan2GP's own generation/Gallery
metadata and installed version alongside the StoryForge manifest for those
details. Identical seeds do not promise identical output across checkpoints,
quantizations, libraries, hardware or software versions.

## Sources checked

Verified against the model cards, current pipeline documentation, Wan2GP source
and the live MCP model schemas on 2026-10-28:

- [BRIA Fibo 2.0 Dev model card](https://huggingface.co/briaai/Fibo-2.0-dev)
- [BRIA Fibo 2.0 Edit Turbo model card](https://huggingface.co/briaai/Fibo-2.0-edit-turbo)
- [Diffusers Fibo 2.0 pipeline](https://huggingface.co/docs/diffusers/main/en/api/pipelines/bria_fibo2)
- [BRIA image generation best practices](https://docs.bria.ai/image-generation-best-practices)
- [Wan2GP Fibo handler and defaults](https://github.com/deepbeepmeep/Wan2GP/blob/main/models/fibo2/fibo2_handler.py)
- [Wan2GP Fibo caption parser](https://github.com/deepbeepmeep/Wan2GP/blob/main/models/fibo2/caption.py)
- [Wan2GP Fibo help and prompt guidance](https://github.com/deepbeepmeep/Wan2GP/blob/main/models/fibo2/help.py)
- [ComfyUI Fibo edit workflow](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_fibo2_edit_dev_pe.json)
