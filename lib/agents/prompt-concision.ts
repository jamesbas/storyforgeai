import { countWords, visualWordCount, wordBudget } from "@/lib/agents/media-prompt-spec";
import type { ModelFamily } from "@/lib/wangp/family";

export { visualWordCount } from "@/lib/agents/media-prompt-spec";

export function exceedsPromptBudget(
  text: string,
  family: ModelFamily,
  kind: "image" | "video",
  seconds: number,
): boolean {
  return (kind === "video" ? visualWordCount(text) : countWords(text)) >
    wordBudget(family, kind, seconds);
}

export function concisePromptDirective(
  family: ModelFamily,
  kind: "image" | "video",
  seconds: number,
): string {
  const budget = wordBudget(family, kind, seconds);
  return (
    ` Keep each ${kind} prompt within ${budget} words` +
    (kind === "video" ? " of visual prose, with verbatim dialogue additional" : "") +
    ", including any automatically appended continuity and appearance text. This is a ceiling, " +
    "not a target: use fewer words whenever the scene allows. After the brief framing " +
    "(for stills), put who is where and what each person is doing first. Use plain, positive, " +
    "concrete sentences. State each critical spatial or contact relationship once, with named " +
    "participants: who is directly behind whom, which hand holds what, what is free or bound, " +
    "and what remains attached. Include only relationships the scene actually specifies. " +
    "Keep roles, left/right placement and body positions consistent across the start frame, " +
    "the motion and the end frame; change them only through an action the scene specifies. " +
    "Before returning JSON, check that each person has one compatible pose at each instant, " +
    "hands and objects have consistent owners, and contacts are physically possible in the " +
    "layout. Resolve contradictions using the supplied scene and established opening frame, " +
    "rather than combining incompatible instructions. Keep necessary constraints; remove " +
    "repetition, exclusive locks, cinematic padding and secondary detail first. Use at most " +
    "one short lighting/style clause. Never invent anatomy, contacts or actions to fill a budget."
  );
}

export const SHORTEN_PROMPT_DIRECTIVE =
  " Rewrite the previous answer more concisely using the same JSON fields. Preserve every " +
  "participant, role, critical placement/contact constraint, wardrobe change and spoken line " +
  "from the scene. State each constraint once and positively. Remove repeated appearance, " +
  "lighting, lens and mood language before shortening the composition or action. Check for " +
  "incompatible simultaneous poses and swapped roles. Do not truncate sentences or dialogue.";
