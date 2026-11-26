/**
 * Verbs that attribute a quotation to a speaker, shared by the visual-word
 * counter and the video-prompt gate so the two agree on what counts as speech.
 *
 * They disagreed: the counter knew six verbs and the gate seventeen, so a
 * multi-turn exchange introduced with "murmurs" or "pleads" was both counted
 * against the visual budget and reported as having no clear speaker.
 *
 * Bare "called" is left out on purpose — "a bar called "Eden"" names a place —
 * and so are verbs that are usually physical ("offers", "orders").
 */
export const SPEECH_VERB_PATTERN =
  "(?:says?|said|asks?|asked|repl(?:y|ies|ied)|answers?|answered|responds?|responded|" +
  "whispers?|whispered|murmurs?|murmured|mutters?|muttered|shouts?|shouted|yells?|yelled|" +
  "calls?|cries|cried|pleads?|pleaded|begs?|begged|snaps?|snapped|hiss(?:es|ed)?|" +
  "growls?|growled|gasps?|gasped|breathes?|breathed|laughs?|laughed|sighs?|sighed|" +
  "moans?|moaned|groans?|groaned|whimpers?|whimpered|exclaims?|exclaimed|rasps?|rasped|" +
  "speaks?|spoke|tells?|told|adds?|added|remarks?|remarked|insists?|insisted|" +
  "demands?|demanded|warns?|warned|admits?|admitted|grunts?|grunted|voice[- ]?over)";
