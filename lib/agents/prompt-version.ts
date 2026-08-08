/**
 * Stable version tags per prompt family.
 *
 * Recorded on every execution so a run can be tied to the wording that produced
 * it. Bump the tag when a system prompt changes materially; SPEC-003 will own
 * the composer versions for media prompts.
 */
export const PROMPT_VERSIONS = {
  intake: "intake-v1",
  storyArchitect: "story-architect-v1",
  visualBible: "visual-bible-v1",
  storyboard: "storyboard-v1",
  imagePrompt: "image-prompt-v2",
  // v3: scenes that inherit their opening frame are told so, and stop writing
  // an opening that contradicts the picture they are handed.
  videoPrompt: "video-prompt-v3",
  variants: "variants-v2",
  worldBible: "world-bible-v1",
  director: "director-v1",
  cinematographer: "cinematographer-v1",
  artDirector: "art-director-v1",
  audio: "audio-v1",
  qc: "qc-v1",
  conceptReader: "concept-reader-v1",
} as const;

/** Deterministic builders carry their own version, so a fallback is traceable too. */
export const BUILDER_VERSION = "builders-v1";
