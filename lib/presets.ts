/**
 * Curated option catalogs for the free-text creative fields on the intake form.
 *
 * `style`, `tone` and `audience` stay `z.string()` in the schema — they are
 * interpolated verbatim into image and video prompts, so any wording is valid.
 * These presets exist so the common cases are one click away and so the Help
 * page has a single source of truth for what each option means. The form always
 * offers a "Custom…" escape hatch, which keeps projects created before the
 * dropdowns existed valid.
 */

export type PresetOption = {
  /** Literal text interpolated into prompts. */
  value: string;
  /** Human label shown in the dropdown. */
  label: string;
  /** Explanation rendered in the Help page field reference. */
  description: string;
};

/** Sentinel used by the form's <select> to reveal a free-text input. */
export const CUSTOM_PRESET_VALUE = "__custom__";

/**
 * Visual style. Reaches generation directly: every start/end frame prompt and
 * every video prompt ends with `"<style> style, <tone> mood"`.
 */
export const STYLE_PRESETS: readonly PresetOption[] = [
  {
    value: "cinematic",
    label: "Cinematic",
    description:
      "Filmic lensing, shallow depth of field, motivated lighting and deliberate composition. The safe default for narrative work.",
  },
  {
    value: "documentary",
    label: "Documentary",
    description:
      "Observational and naturalistic. Available light, handheld framing, minimal stylisation — reads as captured rather than staged.",
  },
  {
    value: "photorealistic",
    label: "Photorealistic",
    description:
      "Maximum physical realism with neutral grading. Use when the subject must look like a real photograph rather than a film frame.",
  },
  {
    value: "animated 3d",
    label: "Animated (3D)",
    description:
      "Stylised CG rendering with clean surfaces and expressive character design. Good for explainers and family-facing content.",
  },
  {
    value: "2d animation",
    label: "Animated (2D)",
    description:
      "Hand-drawn or vector look with flat colour fields and graphic outlines. Strong for abstract concepts that resist live action.",
  },
  {
    value: "anime",
    label: "Anime",
    description:
      "Japanese animation conventions: cel shading, dramatic speed lines, expressive faces and high-contrast key art.",
  },
  {
    value: "film noir",
    label: "Film noir",
    description:
      "High-contrast black and white, hard shadows, venetian-blind light and low camera angles. Carries an implied moral weight.",
  },
  {
    value: "vintage film",
    label: "Vintage film",
    description:
      "Period emulsion look: grain, halation, faded dyes and a softer lens. Signals memory or an earlier era.",
  },
  {
    value: "hyperreal commercial",
    label: "Commercial / product",
    description:
      "Glossy advertising finish — controlled studio lighting, pristine surfaces, hero framing of the product.",
  },
  {
    value: "editorial photography",
    label: "Editorial photography",
    description:
      "Magazine-style stills: strong single subject, considered negative space, fashion-adjacent lighting.",
  },
  {
    value: "watercolor illustration",
    label: "Watercolour illustration",
    description:
      "Soft painted edges, visible paper texture and bleeding pigment. Gentle and storybook-adjacent.",
  },
  {
    value: "graphic novel",
    label: "Graphic novel",
    description:
      "Inked linework, limited palette and bold panel composition. Reads as illustrated sequential art.",
  },
  {
    value: "retro vhs",
    label: "Retro VHS",
    description:
      "Analogue tape artefacts: scanlines, chroma bleed, soft focus and a 4:3-era feel. Nostalgic and lo-fi.",
  },
  {
    value: "surreal dreamlike",
    label: "Surreal / dreamlike",
    description:
      "Impossible geometry, drifting scale and diffuse light. Prioritises mood over physical plausibility.",
  },
  {
    value: "minimalist",
    label: "Minimalist",
    description:
      "Sparse frames, restrained palette and a single clear subject. Keeps attention on the idea, not the decor.",
  },
  {
    value: "boudoir photography",
    label: "Boudoir photography",
    description:
      "Low-key intimate lighting, warm skin tones and shallow depth of field in a bedroom or private interior. A look, not a subject — pair with an adult tone and audience.",
  },
  {
    value: "erotic art film",
    label: "Erotic art film",
    description:
      "Arthouse eroticism: natural light, long takes, restrained grade and composed framing. Reads as cinema rather than as a shoot.",
  },
  {
    value: "glamour photography",
    label: "Glamour photography",
    description:
      "High-gloss beauty lighting with sculpted highlights and a polished finish. Flattering and deliberately posed.",
  },
] as const;

/**
 * Emotional register. Reaches generation directly (prompt suffix), and also
 * drives the music cue prompts and the narrator voice profile.
 */
export const TONE_PRESETS: readonly PresetOption[] = [
  {
    value: "inspirational",
    label: "Inspirational",
    description:
      "Uplifting and forward-leaning. Rising music, warm light, resolutions that land on possibility.",
  },
  {
    value: "hopeful",
    label: "Hopeful",
    description:
      "Quietly optimistic. Softer than inspirational — earns its lift rather than declaring it.",
  },
  {
    value: "dramatic",
    label: "Dramatic",
    description:
      "High emotional stakes, strong contrast, deliberate pacing. Conflict is foregrounded.",
  },
  {
    value: "tense",
    label: "Tense",
    description:
      "Sustained unease. Tight framing, restless camera, withheld resolution. Good for thrillers and reveals.",
  },
  {
    value: "melancholic",
    label: "Melancholic",
    description: "Reflective and wistful. Cool palette, slow moves, unresolved emotional edges.",
  },
  {
    value: "playful",
    label: "Playful",
    description: "Light and energetic. Bright colour, quick beats, room for visual jokes.",
  },
  {
    value: "humorous",
    label: "Humorous",
    description:
      "Comedy is the point. Timing-driven cuts and performances pitched slightly above naturalism.",
  },
  {
    value: "serious",
    label: "Serious",
    description:
      "Measured and credible. Restrained performance and camera; no stylistic flourishes competing with the message.",
  },
  {
    value: "urgent",
    label: "Urgent",
    description:
      "Momentum-first. Short beats, driving underscore, a sense that time is running out.",
  },
  {
    value: "calm",
    label: "Calm",
    description: "Slow, steady and low-arousal. Long holds, soft light, minimal cutting.",
  },
  {
    value: "awe-inspiring",
    label: "Awe-inspiring",
    description: "Scale and wonder. Wide framing, sweeping moves, subject dwarfed by its setting.",
  },
  {
    value: "gritty",
    label: "Gritty",
    description:
      "Rough and unglamorous. Texture, imperfection and practical light over polish.",
  },
  {
    value: "nostalgic",
    label: "Nostalgic",
    description: "Warm remembrance. Golden light, softened detail, an implied past tense.",
  },
  {
    value: "sensual",
    label: "Sensual",
    description:
      "Slow and tactile. Lingering holds on texture, skin and breath; touch carries the scene rather than dialogue.",
  },
  {
    value: "intimate",
    label: "Intimate",
    description:
      "Close and unguarded. Tight framing, quiet sound, the sense of a private moment observed rather than staged.",
  },
  {
    value: "erotic",
    label: "Erotic",
    description:
      "Explicitly charged. Desire is the driving force of the scene and is stated rather than implied. Adult audiences only.",
  },
  {
    value: "raw and carnal",
    label: "Raw / carnal",
    description:
      "Urgent and unpolished. Physical, heavy-breathing intensity with handheld energy and no romantic softening. Adult audiences only.",
  },
  {
    value: "neutral",
    label: "Neutral",
    description:
      "No emotional colouring. Use when the content should carry the meaning without a mood applied on top.",
  },
] as const;

/**
 * Intended viewer. Shapes vocabulary, pacing, content limits and framing
 * decisions taken by the planning agents.
 */
export const AUDIENCE_PRESETS: readonly PresetOption[] = [
  {
    value: "general audience",
    label: "General audience",
    description:
      "No assumed background. Plain language, universal references, nothing that needs prior context.",
  },
  {
    value: "children",
    label: "Children",
    description:
      "Simple vocabulary, slow clear action, bright friendly imagery and no frightening or mature content.",
  },
  {
    value: "teens",
    label: "Teens",
    description:
      "Fast pacing, contemporary references and a peer voice rather than an instructional one.",
  },
  {
    value: "young adults",
    label: "Young adults",
    description:
      "Culturally current and platform-native. Assumes short-form literacy and tolerates ambiguity.",
  },
  {
    value: "adults",
    label: "Adults",
    description:
      "Full emotional and thematic range with no simplification of language or subject matter.",
  },
  {
    value: "adults only, explicit content",
    label: "Adults only (explicit)",
    description:
      "Explicit sexual content is intended. Nothing is softened, implied or cut away from. StoryForgeAI applies no content filtering of its own — what you can actually produce depends on your planning model and the licence of each WanGP model you generate with.",
  },
  {
    value: "families",
    label: "Families",
    description:
      "Watchable together. Layered so children stay engaged while adults get a second level of meaning.",
  },
  {
    value: "business decision makers",
    label: "Business decision makers",
    description:
      "Outcome-led. Leads with the result, keeps the mechanism brief, respects limited attention.",
  },
  {
    value: "technical professionals",
    label: "Technical professionals",
    description:
      "Precise terminology, accurate detail and no hand-waving. Assumes domain fluency.",
  },
  {
    value: "educators and students",
    label: "Educators & students",
    description:
      "Structured for comprehension: stated objective, worked progression, explicit recap.",
  },
  {
    value: "prospective customers",
    label: "Prospective customers",
    description:
      "Benefit-first framing with a clear reason to care, ending on a call to action.",
  },
  {
    value: "existing customers",
    label: "Existing customers",
    description:
      "Assumes familiarity with the product. Focuses on what is new or how to get further value.",
  },
  {
    value: "investors",
    label: "Investors",
    description:
      "Market, traction and differentiation. Confident and evidence-led rather than aspirational.",
  },
  {
    value: "internal team",
    label: "Internal team",
    description:
      "Insider shorthand is fine. Direct, informal and focused on action rather than persuasion.",
  },
] as const;

/** Documentation for the enum-backed selects, used by the Help page. */
export const ASPECT_RATIO_DOCS: Readonly<Record<string, string>> = {
  "16:9": "Widescreen landscape. YouTube, web embeds, TV and most desktop viewing.",
  "9:16": "Vertical. TikTok, Reels, Shorts and any full-screen phone playback.",
  "1:1": "Square. Feed posts that must read the same on any device.",
  custom:
    "Non-standard framing. StoryForgeAI cannot infer a shape, so the DEFAULT_RESOLUTION environment value is used verbatim — set it to the exact size you want.",
};

export const RESOLUTION_DOCS: Readonly<Record<string, string>> = {
  draft:
    "Smallest frame and the fewest steps — 848×480 at 16:9, with the step floor scaled down. The fastest way to check story and motion before committing.",
  standard:
    "Balanced quality and render time — 1280×720 at 16:9. The default for review cuts.",
  high:
    "Largest frame and the most steps — 1920×1088 at 16:9. Slowest and most VRAM-hungry; use for final renders only.",
};

export const CREATIVE_MODE_DOCS: Readonly<Record<string, string>> = {
  film_short: "Narrative short film. Three-act shape, character-driven beats, cinematic coverage.",
  microdrama: "Serialised vertical drama. Rapid escalation with a hook or cliffhanger in every scene.",
  youtube_video: "Long-form landscape content. Strong cold open, chaptered structure, sustained pacing.",
  shorts_reels_tiktok: "Vertical short-form. Hook inside the first second and a loop-friendly ending.",
  brand_ad: "Advertising spot. Brand-forward, emotionally compact, ends on a call to action.",
  product_demo: "Product walkthrough. Feature-to-benefit ordering with clear on-screen focus.",
  educational_explainer: "Teaching content. Stated objective, ordered explanation, explicit recap.",
  ai_avatar: "Presenter-led delivery. A single speaking subject held consistently across all scenes.",
  social_campaign: "Multi-post campaign. Repeatable visual system across a set of related pieces.",
};

export const GENERATION_MODE_DOCS: Readonly<Record<string, string>> = {
  storyboard_only:
    "Plan only. Produces the brief, story arc, visual bible, scene cards and prompts; the generate-media buttons stay disabled so no GPU time can be spent by accident.",
  keyframes_only:
    "Plan plus a start and end frame per scene. The video model is never loaded and no clips are rendered — the cheap way to judge look and casting before committing to motion.",
  video_segments:
    "Plan, keyframes and a clip per scene. You decide when to start generation and when to assemble. The usual choice.",
  full_auto:
    "As video segments, but generating the storyboard immediately queues every scene. Assembly still waits for you to approve attempts.",
};

export const AUDIO_TOGGLE_DOCS: Readonly<Record<string, string>> = {
  Narration: "Adds voice-over lines to each scene card. The video model performs them from the prompt — nothing is synthesised separately.",
  Dialogue: "Adds spoken character lines, quoted inline in the video prompt so the model lip-syncs them.",
  Music: "Asks the Audio Director for underscore cues, each anchored to a scene with an offset and duration.",
  SFX: "Asks the Audio Director for sound-effect cues placed against specific scene moments.",
};

/** Scene continuity modes, labelled for the storyboard control. */
export const SCENE_CONTINUITY_OPTIONS: readonly PresetOption[] = [
  {
    value: "cut",
    label: "Cut between scenes",
    description:
      "Every scene renders its own start and end frame. Correct when scenes are separate shots — reusing a frame across a hard cut looks like a freeze rather than a flow. Costs two image renders per scene.",
  },
  {
    value: "reuse_end_frame",
    label: "Continue from previous end frame (default)",
    description:
      "Each scene starts from the previous scene's end frame instead of rendering a new one. The seam matches exactly, and image renders drop from 2N to N+1. Only applied where the action actually runs on: a scene that cuts to a different shot size, or whose transition names a cut or dissolve, renders its own start frame regardless.",
  },
  {
    value: "continue_video",
    label: "Continue from previous clip",
    description:
      "Each scene continues from the previous scene's rendered video, so motion carries across the boundary rather than restarting from a still. The source clip replaces the start frame; StoryForgeAI still renders and supplies the scene's end image as its destination. Needs a video model that advertises continuation, including LTX-2 and compatible MiniMax H3 variants.",
  },
] as const;
