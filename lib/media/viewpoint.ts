/**
 * Where the camera stands *around* the subject, as opposed to how high it is.
 *
 * The shot vocabulary this project uses everywhere — size, lens, height,
 * movement — describes one axis of camera placement and leaves the other one
 * unstated. Height is vertical: eye level, low, high, overhead. Nothing names
 * the horizontal position, and that is the axis which decides whether a given
 * side of a body is facing the lens or hidden behind it.
 *
 * It does not matter for most shots, and it decides the shot completely when
 * the point of the frame is a specific point of contact. Live, on a scene whose
 * whole content was a man's hand gripping a woman's backside: the prompt named
 * the anatomy, named the contact, named the position, passed every check, and
 * opened "Medium close-up, eye level" with the two of them staged facing each
 * other. Both bodies were therefore side-on to the lens with her backside on
 * the far side of her, and the render put his hand on her hip — the only place
 * it could put a hand it was able to see. The camera was never told to stand
 * where the thing being described was visible.
 *
 * A diffusion model does not report this. It draws something plausible from the
 * viewpoint it was given, so the failure arrives as a picture that looks fine
 * and shows the wrong thing.
 */

/** The horizontal positions a camera can occupy, coarse enough to be checkable. */
export const VIEWPOINTS = [
  "front",
  "three_quarter_front",
  "profile",
  "three_quarter_rear",
  "rear",
  "over_shoulder",
  "overhead",
] as const;
export type Viewpoint = (typeof VIEWPOINTS)[number];

/**
 * Longer phrases first: "three-quarter rear" must not be read as "rear", and
 * "over-the-shoulder from behind her" must not be read as a plain rear view.
 */
const VIEWPOINT_PATTERNS: readonly (readonly [Viewpoint, RegExp])[] = [
  [
    "three_quarter_rear",
    /\bthree[-\s]?quarters?\s+(?:rear|back|behind)\b|\b(?:rear|back)\s+three[-\s]?quarters?\b/i,
  ],
  ["three_quarter_front", /\bthree[-\s]?quarters?\b|\b3\/4\s*(?:view|angle|profile)?\b/i],
  ["over_shoulder", /\bover[-\s]the[-\s]shoulder\b|\bover\s+(?:his|her|their)\s+shoulder\b|\bOTS\b/i],
  ["overhead", /\boverhead\b|\btop[-\s]down\b|\bbird'?s[-\s]eye\b|\bfrom\s+above\b/i],
  [
    "rear",
    /\bfrom\s+behind\b|\brear\s+(?:view|angle|shot)\b|\bbehind\s+(?:her|him|them|the\s+subject)\b|\bback\s+to\s+(?:the\s+)?(?:camera|lens|viewer)\b|\bfacing\s+away\s+from\s+(?:the\s+)?(?:camera|lens|viewer)\b|\bseen\s+from\s+the\s+back\b/i,
  ],
  ["profile", /\bin\s+profile\b|\bprofile\s+(?:view|angle|shot)\b|\bside[-\s]on\b|\bfrom\s+the\s+side\b/i],
  [
    "front",
    /\bfront\s+(?:view|angle|shot|on)\b|\bhead[-\s]on\b|\bfacing\s+(?:the\s+)?(?:camera|lens)\b|\bfrontal\b/i,
  ],
];

/**
 * Prompt agents are instructed to open with the shot, so that is where the
 * camera is declared. Reading only the opening is what keeps set dressing out
 * of range: live, a prompt reading "...blue LED light from the back-bar behind
 * them..." matched as a rear camera on the strength of a lamp, and passed a
 * frame that was shot from the front. The same window `shotSizeOf` uses, for
 * the same reason.
 */
const LEAD_CHARS = 160;

/** The viewpoint a prompt states, or undefined when it never names one. */
export function viewpointOf(text: string | undefined): Viewpoint | undefined {
  if (!text) return undefined;
  const lead = text.slice(0, LEAD_CHARS);
  for (const [viewpoint, pattern] of VIEWPOINT_PATTERNS) {
    if (pattern.test(lead)) return viewpoint;
  }
  return undefined;
}

/**
 * Camera placement stated anywhere in the prompt, not just the opening.
 *
 * These phrases name the camera outright, so they cannot be confused with a
 * lamp or a body standing behind another one and are safe to read from the
 * whole text. A prompt that puts its angle in the third sentence is still
 * telling the truth about where the lens is.
 */
const CAMERA_BEHIND =
  /\bcamera\s+(?:[\w-]+\s+){0,3}?behind\b|\bshot\s+from\s+behind\b|\b(?:viewed|seen|photographed|framed)\s+from\s+(?:behind|the\s+back)\b|\bback\s+to\s+(?:the\s+)?(?:camera|lens|viewer)\b|\bfacing\s+away\s+from\s+(?:the\s+)?(?:camera|lens|viewer)\b/i;

/**
 * Anatomy on the back of a body.
 *
 * Deliberately short and unambiguous. "Behind" and "rear" are absent because
 * they describe where somebody stands far more often than what is being looked
 * at, and a focal-point check that fires on staging would reject correct
 * prompts.
 */
const REAR_ANATOMY =
  /\b(?:ass|asses|arse|ass ?cheeks?|arse ?cheeks?|buttocks?|backside|rump|anus|asshole|arsehole|tailbone|small of (?:her|his|their) back)\b/i;

/** Anatomy on the front of a body, for the mirror case. */
const FRONT_ANATOMY =
  /\b(?:breasts?|nipples?|cleavage|navel|belly|stomach|pubic|mound|vulva|labia|clitoris|clit|pussy|cunt|cocks?|penis|shafts?|balls|testicles|scrotum)\b/i;

/**
 * Viewpoints from which the back of a body is visible.
 *
 * A profile counts: side-on, the curve of a backside is in frame and a hand on
 * it reads correctly. A plain front view does not, which is the whole point.
 */
const REAR_VISIBLE: readonly Viewpoint[] = [
  "rear",
  "three_quarter_rear",
  "three_quarter_front",
  "profile",
  "over_shoulder",
  "overhead",
];

const FRONT_VISIBLE: readonly Viewpoint[] = [
  "front",
  "three_quarter_front",
  "three_quarter_rear",
  "profile",
  "overhead",
];
/**
 * A body orientation stated in the prose rather than as a camera angle.
 *
 * The prompt that fixed the live scene did not name a camera position at all —
 * it turned the subject instead: "she is turned three-quarters so her ass is
 * visible on the right of frame". Same result, and it is the more natural way
 * to write it, so a check that only read camera nouns would reject the fix.
 */
const ORIENTS_TO_LENS =
  /\b(?:turned|angled|rotated|twisted|pivoted|oriented)\s+(?:[\w-]+\s+){0,3}?(?:toward|towards|away|so|to)\b|\b(?:visible|presented|exposed|bared|offered)\s+to\s+(?:the\s+)?(?:camera|lens|frame|viewer)\b|\bvisible\s+(?:in|on|at)\s+(?:the\s+)?(?:frame|shot|right|left|foreground)\b/i;

/**
 * Whether a prompt puts the back of a body in view of the lens.
 *
 * Split deliberately from `focalSide`: what the frame is *about* comes from the
 * scene card, which is the authority on the beat, while whether the camera can
 * *see* it is a property of the prompt. Reading both from the prompt meant a
 * prompt that named the far side in order to rule it out — "palm flat on her
 * ass ... not on her stomach" — looked like a frame about both sides at once
 * and switched the check off. That sentence is good prompt writing and must not
 * be punished.
 */
export function sideVisibleIn(text: string | undefined, side: "front" | "rear"): boolean {
  if (!text) return false;
  // An explicit orientation sentence settles it without naming a camera angle,
  // and it is the more natural way to write it.
  if (ORIENTS_TO_LENS.test(text)) return true;
  if (side === "rear" && CAMERA_BEHIND.test(text)) return true;
  const viewpoint = viewpointOf(text);
  if (!viewpoint) return false;
  return (side === "rear" ? REAR_VISIBLE : FRONT_VISIBLE).includes(viewpoint);
}

/**
 * Which side of a body the frame is about, when that is answerable.
 *
 * **Rear only, and deliberately so.** The mirror case is unreliable once two
 * bodies are involved: one person's front pressed against another's back is
 * plainly visible from behind, so "front anatomy named, camera behind" is
 * usually correct staging rather than a fault. Swept over a real 27-scene
 * project the front rule fired on six frames and every one of them was a
 * legitimate shot — a doggy-style frame reading "Leroy's erect cock is fully
 * inserted in TLBr3f's pussy" from a rear camera is exactly right, and
 * rejecting it would have cost a retry to arrive back where it started.
 *
 * The rear case has no such ambiguity. A hand on a backside is behind the body
 * it is on whatever else is in the frame, so a prompt that never says where the
 * camera stands will be rendered from the front and the contact moved somewhere
 * the lens can see.
 */
export function focalSide(text: string | undefined): "rear" | undefined {
  if (!text) return undefined;
  if (!REAR_ANATOMY.test(text)) return undefined;
  // Naming both sides means the staging is already doing the work, or the
  // frame holds two bodies facing opposite ways.
  if (FRONT_ANATOMY.test(text)) return undefined;
  return "rear";
}
