import type { CreativePlans } from "@/lib/agents/creative-context";

/**
 * Keep the venue in the picture.
 *
 * An image prompt is read on its own, and a model told to be concise spends its
 * words on who is doing what to whom and drops where. On a medium close-up
 * that left nothing to say the scene was in a club: the render invented a
 * white clapboard wall, and a strip club became a trailer park. The setting was
 * in the world bible all along; it just never reached the frame. The negative
 * prompt ("outdoor setting") cannot help, because the image families that need
 * the correction most ignore negatives.
 *
 * So the project's setting is carried here and added to any frame that does not
 * already say it, the way the project's look and the cast sheet are.
 */

/** Words that say little about a place, so sharing them proves nothing. */
const GENERIC = new Set([
  "setting", "interior", "exterior", "lighting", "light", "dominated", "soft", "hues", "hue",
  "with", "that", "this", "from", "their", "there", "where", "which", "while", "around", "within",
  "scene", "area", "space", "place", "room", "seated", "surrounding", "between", "under", "over",
  "high", "low", "dark", "deep", "large", "small", "main",
  // Furniture and fabric turn up in every place, so they join none of them.
  "floor", "floors", "wall", "walls", "table", "tables", "chair", "chairs", "door", "doors",
  "window", "windows", "ceiling", "bright", "dimly", "warm", "cool", "wood", "wooden", "metal",
  "glass", "people", "person", "front", "back", "edge", "surface", "surfaces", "background",
]);

function stems(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z]{4,}/g) ?? [])
      .filter((word) => !GENERIC.has(word))
      .map((word) => word.slice(0, 5)),
  );
}

function coverage(wanted: ReadonlySet<string>, present: ReadonlySet<string>): number {
  if (!wanted.size) return 1;
  let hits = 0;
  for (const stem of wanted) if (present.has(stem)) hits += 1;
  return hits / wanted.size;
}

const SETTING_RULE = /\b(?:setting|takes place|set in|set at|located)\b/i;
const MAX_WORDS = 24;

/** A statement that walks through several places is not one setting. */
const SEVERAL_PLACES =
  /\b(?:then|transition\w*|moves?|moving|alternat\w*|between|exterior|sequence|segments?|followed|afterwards?)\b/i;

const LEAD_IN =
  /^\s*(?:the\s+)?(?:(?:scene|story|film|video)(?:'s)?\s+)?(?:(?:entire|whole)\s+)?(?:setting|story|film|piece|action|scene|video|sequence)(?:'s)?(?:\s+setting)?\s+(?:is|takes\s+place|occurs|unfolds|happens)\s+/i;

function clip(text: string): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const clipped = words.slice(0, MAX_WORDS).join(" ").replace(/[,;:\s]+$/, "");
  return clipped.replace(/[.!?]+$/, "");
}

/**
 * The place itself, without the sentence it was stated in.
 *
 * Statements arrive as "The scene takes place entirely within…", "strictly a
 * single room; no windows are visible" and the like. Only the place goes into a
 * prompt: the framing words are noise, and a negation embeds the thing it
 * denies — a text encoder has no operator for "no", so "no windows" is read as
 * windows.
 */
function placeOf(statement: string): string {
  return statement
    .replace(LEAD_IN, "")
    .replace(/^\s*(?:set|located)\s+(?:in|at)\s+/i, "")
    .replace(/^\s*(?:(?:entirely|exclusively|strictly|always|only|all)\s+)+/i, "")
    .replace(/^\s*(?:in|at|inside|within|on)\s+/i, "")
    .split(";")[0]!
    .replace(/\s*,?\s*(?:with|and|but|where)?\s*\bno\b\s[^.;]*/i, "")
    .trim();
}

/**
 * The project's setting as one short clause, or nothing when the world bible
 * does not state one, states several, or states unrelated places.
 *
 * Only the world bible's own statement of the setting counts. A location's
 * description is not a fallback: it is one place among several, and stating it
 * in every frame would put a story that moves between a house and a street in
 * the house throughout. An unstated setting stays unstated.
 *
 * The same reasoning rules the statement out when it walks through places
 * ("exterior field, then interior bay") or when the bible's own locations do
 * not hang together with it. Stages, seating and a perimeter all belong to a
 * club, and each shares something with the statement or with a place that does;
 * a house, a street and a car do not, and for that story the one-line setting
 * is only true of some scenes.
 */
export function projectSetting(plans: CreativePlans | undefined): string | undefined {
  const rule = plans?.worldBible?.universeRules?.find((r) => SETTING_RULE.test(r));
  if (!rule || SEVERAL_PLACES.test(rule)) return undefined;
  const plain = placeOf(rule);
  if (!plain) return undefined;
  if (!locationsBelongTogether(rule, plans?.worldBible?.locations ?? [])) return undefined;
  return `Setting: ${clip(plain.charAt(0).toLowerCase() + plain.slice(1))}.`;
}

/**
 * Whether every location can be reached from the setting statement through
 * shared, specific words — directly, or by way of another location.
 */
function locationsBelongTogether(
  statement: string,
  locations: readonly { name: string; description: string }[],
): boolean {
  // One place cannot disagree with the statement of where the story is.
  if (locations.length <= 1) return true;
  const known = stems(statement);
  const pending = locations.map((location) => stems(`${location.name} ${location.description}`));
  let progressed = true;
  while (pending.length && progressed) {
    progressed = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if ([...pending[i]!].some((stem) => known.has(stem))) {
        for (const stem of pending[i]!) known.add(stem);
        pending.splice(i, 1);
        progressed = true;
      }
    }
  }
  return pending.length === 0;
}

/** The clause to append to a frame prompt, empty when the prompt already says it. */
export function settingSuffix(prompt: string, setting: string | undefined): string {
  if (!setting) return "";
  return coverage(stems(setting), stems(prompt)) >= 0.4 ? "" : ` ${setting}`;
}
