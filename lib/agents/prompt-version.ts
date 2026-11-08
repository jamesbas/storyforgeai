/**
 * Stable version tags per prompt family.
 *
 * Recorded on every execution so a run can be tied to the wording that produced
 * it. Bump the tag when a system prompt changes materially; SPEC-003 will own
 * the composer versions for media prompts.
 */
export const PROMPT_VERSIONS = {
  intake: "intake-v1",
  // v2: names the segment the climax belongs at, asks where it was written, and
  // every window reports its continued segments and the climax.
  // v3: a climax the user named is quoted and declared not the model's to
  // change, and a chosen aftermath count replaces the automatic budget.
  // v4: beats say what a lowered or removed garment leaves visible, and keep
  // garments where the pose allows.
  storyArchitect: "story-architect-v4",
  visualBible: "visual-bible-v2",
  // v2: each batch is handed the wardrobe as it stands after the changes
  // declared so far, and the undressing case is stated as a requirement.
  // v5: wardrobe states say what is now bare, not only where the garment went.
  storyboard: "storyboard-v5",
  // v10: Krea 2 is told its published prompting rules — natural-language
  // paragraph, bound attributes, concrete light and materials, quoted lettering,
  // no quality tags or weighting syntax, and a short task-specific negative.
  // v11: every scene's closing frame is an edit (its own opening where nothing
  // is carried), each frame is given its target framing, and a vague wardrobe
  // state is named so the visible result is written out.
  // v12: a stated skin tone or ethnicity is required beside the name in every
  // frame, and visual-bible characters get the library's appended fallback.
  imagePrompt: "image-prompt-v12",
  // v4: a scene continuing from the one before it is handed its actual opening
  // frame in the payload, not just told about it in the system prompt.
  // v8: story characters are named in the cast line, and Ref2VA binds each
  // person with a phrase that includes a stated skin tone.
  videoPrompt: "video-prompt-v8",
  variants: "variants-v2",
  worldBible: "world-bible-v1",
  director: "director-v1",
  cinematographer: "cinematographer-v1",
  artDirector: "art-director-v1",
  audio: "audio-v1",
  // v2: handed the appearance of everyone in the scene and the previous scene,
  // both of which it was already asked to judge against.
  qc: "qc-v2",
  conceptReader: "concept-reader-v1",
} as const;

/**
 * Deterministic builders carry their own version, so a fallback is traceable too.
 * v7: on Krea the look follows the framing sentence and a non-explicit audience
 * is left off.
 * v8: visual-bible characters named in a frame get an appended identity, and a
 * stated skin tone is kept beside the name.
 */
export const BUILDER_VERSION = "builders-v8";
