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
  // v2: each batch is handed the wardrobe as it stands after the changes
  // declared so far, and the undressing case is stated as a requirement.
  storyboard: "storyboard-v2",
  imagePrompt: "image-prompt-v2",
  // v4: a scene continuing from the one before it is handed its actual opening
  // frame in the payload, not just told about it in the system prompt.
  videoPrompt: "video-prompt-v4",
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
