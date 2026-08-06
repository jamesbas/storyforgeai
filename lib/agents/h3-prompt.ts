import type { ModelFamily } from "@/lib/wangp/family";

/**
 * MiniMax H3's native prompt envelope.
 *
 * H3 does not take one blob of prose. Its published guide
 * (VIDEO_PROMPT_WRITING_GUIDE_base_en) specifies an alignment instruction on
 * the first line, a blank line, then three labelled fields: the timeline, the
 * ambience, and the audience-only score. WanGP passes `prompt` through
 * untouched and `prompt_enhancer` is forced off, so nothing between StoryForge
 * and the model will produce this shape if we do not.
 *
 * **Off by default, and the reason is unresolved.** Three A/B pairs on
 * `minimax_h3_fl2va_pruned` produced no spoken dialogue at all in the enveloped
 * arm, while the plain-prose arm spoke the line correctly every time. Picture,
 * timing, end-frame landing and audio levels were indistinguishable throughout.
 *
 * That is not explained by the format being wrong for this model. H3 is three
 * modules: a hosted **H3-Context-IR** that turns free-form input into exactly
 * this structure, **H3-Base** (what WanGP runs) which consumes it, and a hosted
 * 2K regenerator. MiniMax's own worked examples post this structure to a
 * locally deployed H3-Base, so it is the documented input here.
 *
 * Eliminated across the three runs:
 *   - *Audio direction.* Run 1's arms differed because only the enveloped one
 *     carried ambience and score; both have carried it since, and the gap in
 *     stereo width vanished with it.
 *   - *Tokenisation.* WanGP ships MiniMax's tokenizer config, and
 *     `Qwen3-VL-32B-Instruct` declares `<d>` and `</d>` as special tokens.
 *   - *Prompt length.* Raising the timeline from ~120 to ~294 words changed
 *     nothing.
 *
 * Untested, and the only candidate left: the test subject is a robot whose
 * prompt states it has no mouth, which the stricter structured reading may be
 * honouring by declining to speak. Resolving it needs a human character.
 *
 * One loose end for anyone who picks this up: WanGP's `text_encoder.py` emits
 * images as `<Picture 1>:` with angle brackets, while the guide's FL2VA
 * alignment sentence — reproduced verbatim here — names them bare. Whether the
 * bare form binds to the image token is unverified.
 *
 * Everything here is pure string work over facts the caller already has, so the
 * format can be verified without a GPU.
 */

/** Which of H3's modes a set of supplied keyframes puts the job in. */
export type H3Mode = "t2va" | "i2va" | "l2va" | "fl2va";

export function h3Mode(hasStart: boolean, hasEnd: boolean): H3Mode {
  if (hasStart && hasEnd) return "fl2va";
  if (hasStart) return "i2va";
  if (hasEnd) return "l2va";
  return "t2va";
}

/** The guide formats every timestamp to exactly two decimal places. */
function seconds(value: number): string {
  return Math.max(0, value).toFixed(2);
}

/**
 * The first line, which tells H3 where each supplied frame lands in time.
 *
 * The wording is fixed by the guide rather than chosen — each mode has one
 * sentence, quoted verbatim there. T2VA has no instruction at all.
 */
export function h3AlignmentHeader(mode: H3Mode, durationSeconds: number): string {
  if (mode === "i2va") {
    return (
      "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) " +
      "is fully referenced."
    );
  }
  if (mode === "l2va") {
    return (
      "How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) " +
      `aligns with the ${seconds(durationSeconds)}-second mark of the target video.`
    );
  }
  if (mode === "fl2va") {
    return (
      "How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns " +
      "with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the " +
      `${seconds(durationSeconds)}-second mark of the target video.`
    );
  }
  return "";
}

export type H3PromptParts = {
  /** The timeline prose, without the `[Shot 1]` marker. */
  body: string;
  /** Ambience and physical sound. Empty falls back to the guide's `N/A`. */
  soundscape?: string;
  /** Audience-only score. Empty means there is none, which the guide writes `N/A`. */
  score?: string;
  durationSeconds: number;
  hasStart: boolean;
  hasEnd: boolean;
};

/** Trailing whitespace and a single trailing period, normalised. */
function tidy(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

const SHOT = "[Shot 1]";

/** Speech markup: `<d>[Language] words</d>`, per the guide. */
const DIALOGUE_TAG = /<d>\s*\[[^\]]*\]\s*([\s\S]*?)<\/d>/g;

/** A said/says clause with the spoken words quoted after it. */
const SPOKEN_CLAUSE = /\b(says?|said)\b[,:]?\s*[""]([^""]+)[""]/g;

/**
 * Tag spoken lines so H3 performs them instead of describing them.
 *
 * Inside the envelope a quoted sentence is just more description: a live clip
 * whose prompt said `The robot says, "..."` came back with no speech in it at
 * all, while the same line in loose prose was at least sung. The guide is
 * explicit that only `<d>` content is uttered, and that the speaker id and
 * delivery stay outside the tag.
 *
 * Left alone when the prompt already carries markup, so a prompt written to the
 * contract is never rewritten by a regex.
 */
export function markDialogue(text: string): string {
  DIALOGUE_TAG.lastIndex = 0;
  if (DIALOGUE_TAG.test(text)) return text;

  let speaker = 0;
  return text.replace(SPOKEN_CLAUSE, (_match, verb: string, line: string) => {
    speaker += 1;
    return `(S${speaker}) ${verb}: <d>[English] ${line.trim()}</d>`;
  });
}

/** Put tagged speech back to ordinary quoted prose for everything else. */
export function stripDialogueMarkup(text: string): string {
  return text.replace(DIALOGUE_TAG, (_match, line: string) => `"${line.trim()}"`);
}

/**
 * Assemble the envelope.
 *
 * One shot only: the guide says FL2VA "generally favors a single shot so the
 * model can interpolate continuously from the first frame to the last frame",
 * and a StoryForge scene is exactly one continuous take by construction.
 */
export function renderH3Prompt(parts: H3PromptParts): string {
  const mode = h3Mode(parts.hasStart, parts.hasEnd);
  const header = h3AlignmentHeader(mode, parts.durationSeconds);

  const body = markDialogue(tidy(parts.body));
  const timeline = body.startsWith(SHOT) ? body : `${SHOT} ${body}`;

  const fields = [
    `integrated_multimodal_description: ${timeline}`,
    `overall_soundscape: ${tidy(parts.soundscape) || "N/A"}`,
    `non_diegetic_music: ${tidy(parts.score) || "N/A"}`,
  ].join("\n\n");

  return header ? `${header}\n\n${fields}` : fields;
}

/** Whether a prompt has already been put in the envelope. */
export function isH3Prompt(prompt: string): boolean {
  return prompt.includes("integrated_multimodal_description:");
}

/**
 * Fold the two audio layers back into the prose.
 *
 * H3's directive asks the prompt agent to keep ambience and score out of the
 * timeline and put them in fields of their own. Without the envelope those
 * fields have nowhere to go, and a model that writes its own soundtrack is then
 * given no audio direction at all — which is not neutral. Left to invent one it
 * will, and an unguided clip sang a line the scene had only asked it to say.
 */
export function appendAudioProse(
  prompt: string,
  soundscape?: string,
  score?: string,
): string {
  const layers = [tidy(soundscape), tidy(score)].filter((layer) => layer && layer !== "N/A");
  if (!layers.length) return prompt;
  return `${prompt.trim()} ${layers.join(" ")}`.trim();
}

/**
 * Recover the plain timeline prose from an envelope.
 *
 * A prompt is written for the pinned model, but a pin can be missing from the
 * catalogue and fall through to the router — so the family a prompt was written
 * for is not always the family that renders it, exactly as `routeNegative`
 * documents. Handing `integrated_multimodal_description:` to a Wan model would
 * render those words rather than obey them.
 */
export function stripH3Envelope(prompt: string): string {
  if (!isH3Prompt(prompt)) return stripDialogueMarkup(prompt);

  const after = prompt.slice(prompt.indexOf("integrated_multimodal_description:"));
  const timeline = after
    .replace(/^integrated_multimodal_description:\s*/, "")
    .split(/\n\s*(?:overall_soundscape|non_diegetic_music):/)[0] ?? "";

  const sound = /\n\s*overall_soundscape:\s*([\s\S]*?)(?=\n\s*non_diegetic_music:|$)/.exec(prompt);
  const music = /\n\s*non_diegetic_music:\s*([\s\S]*)$/.exec(prompt);

  // The audio layers are still direction, just unlabelled: folded back in so a
  // fallback render loses the format without losing the intent.
  const audio = [sound?.[1], music?.[1]]
    .map((value) => tidy(value))
    .filter((value) => value && value !== "N/A");

  return [tidy(timeline).replace(/^\[Shot 1\]\s*/, ""), ...audio]
    .map(stripDialogueMarkup)
    .join(" ")
    .trim();
}

/** H3 is the only family that takes this envelope. */
export function usesH3PromptFormat(family: ModelFamily): boolean {
  return family === "minimax";
}
