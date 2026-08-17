import { AUDIENCE_PRESETS, TONE_PRESETS, type PresetOption } from "@/lib/presets";
import type { Project } from "@/lib/schemas/project";
import type { SceneDraft } from "@/lib/schemas/storyboard";

/**
 * Tells the prompt agents that the sexual content is meant to be rendered.
 *
 * Nothing did. The tone and audience presets carry descriptions saying exactly
 * that — "Explicit sexual content is intended. Nothing is softened, implied or
 * cut away from." — and those descriptions were shown in the UI and read by no
 * model. What reached the render was `lookPromptSuffix`, which staples the bare
 * values on *after* the agent has finished writing, so it cannot influence a
 * word of it. The agent was meanwhile told not to restate style or tone.
 *
 * The result was literary euphemism: "the point of contact", "drives into her".
 * A diffusion model has no representation for an implication. It renders nouns.
 */

const EXPLICIT_AUDIENCE = /explicit/i;
const EXPLICIT_TONE = /erotic|carnal|sexual/i;

/**
 * The words a description uses when it is actually describing the act.
 *
 * Deliberately narrow: every term here names anatomy or a sexual act outright,
 * so a tame project cannot trip it. Words that read as explicit only in context
 * — "climax", "riding", "mounted", "erect" — are left out, because classifying
 * a family film as explicit is the more expensive mistake.
 */
const EXPLICIT_VOCABULARY =
  /\b(naked|nude|nudity|topless|nipples?|areolae?|genitals?|penis|\bcocks?\b|vagina|vulva|pussy|clitoris|labia|testicles|scrotum|buttocks|anus|erection|penetrat\w*|intercourse|fellatio|blow ?job|cunnilingus|oral sex|masturbat\w*|orgasm\w*|ejaculat\w*|semen|sexual|sex act|foreplay|bare breasts|breasts|undressed|unclothed|fuck\w*)\b/i;

function describe(presets: readonly PresetOption[], value: string): string {
  const match = presets.find((p) => p.value.toLocaleLowerCase() === value.trim().toLocaleLowerCase());
  return match?.description ?? "";
}

/** Whether a piece of text names sexual content outright rather than alluding to it. */
export function namesExplicitContent(text: string | undefined): boolean {
  return EXPLICIT_VOCABULARY.test(text ?? "");
}

/**
 * Whether this project asks for explicit sexual content.
 *
 * Audience and tone are the settings a user picks deliberately, so they lead.
 * The concept and style are read too: a project whose brief describes the act
 * in plain terms has said what it is, and reading only the two dropdowns meant
 * such a project rendered with no explicit guidance at all.
 */
export function isExplicitProject(project: Project): boolean {
  return (
    EXPLICIT_AUDIENCE.test(project.audience ?? "") ||
    EXPLICIT_TONE.test(project.tone ?? "") ||
    namesExplicitContent(project.concept) ||
    namesExplicitContent(project.style)
  );
}

/**
 * Whether this one scene depicts explicit content, whatever the project says.
 *
 * A generally adult project can reach a single explicit scene without its tone
 * or audience using a trigger word, and that scene needs the same directive as
 * a wall-to-wall explicit piece — it is the scene, not the project, that gets
 * rendered.
 */
export function isExplicitScene(scene: Pick<
  SceneDraft,
  "visualDescription" | "actionDescription" | "storyBeat" | "sceneObjective"
>): boolean {
  return [
    scene.visualDescription,
    scene.actionDescription,
    scene.storyBeat,
    scene.sceneObjective,
  ].some(namesExplicitContent);
}

export function explicitnessDirective(
  project: Project,
  kind: "image" | "video" | "plan",
  scene?: Parameters<typeof isExplicitScene>[0],
): string {
  if (!isExplicitProject(project) && !(scene && isExplicitScene(scene))) return "";

  // The preset descriptions are the wording the user chose from, so the model
  // reads the same definition the settings screen showed.
  const context = [
    describe(AUDIENCE_PRESETS, project.audience ?? ""),
    describe(TONE_PRESETS, project.tone ?? ""),
  ]
    .filter(Boolean)
    .join(" ");

  const intent =
    " This project is made for adults and its sexual content is meant to be shown rather than " +
    "suggested." +
    (context ? ` ${context}` : "");

  // Planning agents write the card a render prompt is later built from, so an
  // act described obliquely here cannot be recovered downstream: the prompt
  // agent can only make explicit what the card says happens.
  if (kind === "plan") {
    return (
      intent +
      " Say plainly what happens. A scene that reaches a sexual act must describe the act, the " +
      "positions and what the bodies are doing, in the same physical, observable terms you would " +
      "use for any other action. Do not fade out, cut away, end a scene at the moment it becomes " +
      "explicit, or replace the act with the mood surrounding it. Literary indirection — " +
      "\"they come together\", \"the moment takes them\" — reads as an event that was never " +
      "described, and a render built from it shows two people standing near each other." +
      // The observed failure. Every one of these was written by a planning
      // agent that believed it had complied: it names the category the act
      // belongs to and leaves the geometry — which is all a render can draw —
      // entirely unstated.
      " Naming the category is not describing it. \"They have sex\", \"he performs oral sex on " +
      "her\", \"he engages her from behind\" and \"they make love\" are labels; state which " +
      "position they are in, who is doing what to whom, and what is inside what."
    );
  }

  const shared =
    intent +
    " Write the bodies plainly. Name the anatomy, state which parts are in contact, whose body " +
    "is where, and what is visible from this angle. Phrases like \"the point of contact\", " +
    "\"their union\" or \"he takes her\" name an idea rather than a thing, and an image model " +
    "has nothing to draw from an idea — it renders nouns. Do not soften, abstract, fade out or " +
    "cut away, and do not substitute mood words for the act itself." +
    REGISTER;

  return kind === "image" ? shared + IMAGE_FRAME_CONTRACT : shared + VIDEO_ACT_CONTRACT;
}

/**
 * Write both registers, because the model only knows one of them.
 *
 * NSFW-tuned checkpoints and nearly every NSFW LoRA are tagged from booru
 * data — "pussy", "cock", "vaginal" — while the general-purpose families were
 * captioned clinically. A prompt written in one register lands on a model
 * trained on the other as an unknown token, which is how an anatomically
 * specific prompt still renders a vague tangle of limbs. Writing both costs
 * three words a clause and hits either.
 */
const REGISTER =
  " Name anatomy in both registers, the common term first with the anatomical term beside it — " +
  "\"his cock (penis)\", \"her pussy (vagina)\", \"her asshole (anus)\" — because any given " +
  "model was trained on one vocabulary or the other and this way it finds the one it knows.";

/**
 * What a finished explicit keyframe has to contain.
 *
 * Stated as a numbered contract with a worked example, because that is the
 * form the instructions in this prompt that actually get obeyed already take.
 * The old wording asked for the same thing in one prose sentence and was
 * answered with "his mouth is pressed against her soft skin between her
 * thighs" — a sentence that names no anatomy, no contact and no position, and
 * renders as two people lying near each other.
 */
const IMAGE_FRAME_CONTRACT =
  " This is one still frame. A still cannot show rhythm, pace or repetition: do not write " +
  "\"rhythmic\", \"continuous\", \"steady rhythm\", \"in and out\", \"back and forth\" or " +
  "\"with each thrust\". Freeze it — state where the bodies are at this single instant and how " +
  "deep. Every frame of a sexual act must state all nine of these, and one missing any of them " +
  "is unfinished:\n" +
  "1. The position, named: cowgirl, reverse cowgirl, missionary, doggy style, spit-roast, " +
  "straddling, legs over his shoulders.\n" +
  "2. What is inside what: \"his cock (penis) inserted in her pussy (vagina)\", \"vaginal " +
  "penetration\", \"anal penetration\", \"his cock (penis) in her mouth\".\n" +
  "3. How far in: fully to the base, half withdrawn, the tip parting her labia.\n" +
  "4. The genital anatomy visible from this angle: her labia stretched around his shaft, his " +
  "balls against her, her clitoris exposed, the base of his cock still outside her.\n" +
  "5. Where every participant's limbs are, and what each pair of hands is doing.\n" +
  "6. Where skin meets skin: his hips against her buttocks, her thighs either side of his waist.\n" +
  "7. Wetness and sheen: glistening, sweat-slick, flushed skin, moisture where they join.\n" +
  "8. Each face — expression, mouth, eyes — and where they are looking.\n" +
  "9. Breasts and nipples wherever the frame shows them.\n" +
  // The rule this overrides is stated earlier and unconditionally, and the
  // model obeyed it: it dressed the man performing oral sex in black silk
  // trousers. An outfit is appended last and outranks the act it contradicts.
  "Everyone taking part in the act is naked. This overrides the instruction to give characters " +
  "outside the cast specific named garments: a participant wears nothing, and you must not put " +
  "a shirt, trousers, lingerie or underwear on anyone the act involves. Clothing belongs only " +
  "to people this scene's wardrobe explicitly dresses.\n" +
  "A finished frame reads like this: \"Medium shot, low angle. Reverse cowgirl: Mara sits " +
  "astride Mark facing away from him, his cock (penis) fully inserted in her pussy (vagina), " +
  "her labia stretched tight around his shaft, the base still visible where they join. Her " +
  "knees are either side of his hips, her hands braced on his thighs; his hands grip her waist. " +
  "Her back arches, head turned back over her shoulder, mouth open, eyes half closed. Her " +
  "breasts are lifted and her nipples hard. Sweat sheens both bodies and moisture glistens " +
  "where they meet.\" Write at that level of detail every time.";

const VIDEO_ACT_CONTRACT =
  " Spend the prompt on the movement of the act — its rhythm, direction, depth and pace, and " +
  "what each body is doing — rather than alluding to it. Name the position and what is inside " +
  "what before describing how it moves: a clip that says only \"he thrusts rhythmically\" has " +
  "not said which bodies, in what arrangement, or where. Everyone taking part is naked unless " +
  "this scene's wardrobe dresses them.";
