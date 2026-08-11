import { z } from "zod";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { EnhanceConceptInput } from "@/lib/schemas/intake";

/**
 * No `.min()` or `.max()` here, deliberately.
 *
 * llama.cpp builds a GBNF grammar from the JSON schema to constrain decoding,
 * and it cannot express string length. A `maxLength` makes LM Studio answer
 * `400 Failed to initialize samplers: failed to parse grammar`, which reads as
 * a dead server rather than a bad schema. Length is checked in code instead.
 */
const enhancedConceptSchema = z.object({ concept: z.string() });

/** Matches the concept field on the New Project form. */
const MAX_CONCEPT_CHARS = 5000;

export type ConceptEnhancement =
  | { ok: true; concept: string }
  | { ok: false; reason: string };

/**
 * The concept is the only thing every downstream agent reads, so a thin one
 * produces a thin film. This expands it without taking the decisions the writer
 * has not made yet — the prohibitions below are the load-bearing half.
 */
export const CONCEPT_ENHANCER_SYSTEM = [
  "You expand a filmmaker's short concept note into a fuller one. A storyboarding tool reads",
  "your answer and builds a film from it, so what you write becomes the brief.",
  "",
  'Return JSON: { "concept": "<the expanded note>" }.',
  "",
  "The note is prose — two to four sentences, roughly 60 to 140 words. No headings, no bullet",
  "points, no preamble, no title, no commentary about the concept.",
  "",
  "Keep what the writer decided:",
  "- Every concrete thing already in the note is a decision, not a suggestion: subjects, setting,",
  "  period, named characters, objects, events, mood.",
  "- Never contradict the premise or quietly correct it, however odd it seems.",
  "",
  "Add only what the note already implies:",
  "- Draw out the visible world, what happens, and what has changed by the end.",
  "- Prefer what a camera can see over what a character thinks or feels.",
  "- Do not introduce named people, places, brands or lines of dialogue the writer did not.",
  "- Do not add a moral, a message, or a twist the writer did not ask for.",
  "",
  "Fit the running time given. A 30-second piece is one moment; two minutes can carry a turn.",
  "Do not describe more story than the duration can hold.",
  "",
  "Leave the craft alone. No shot lists, camera moves, lens or lighting notes, scene numbers or",
  "edit directions — later stages decide those, and naming them here overrides them.",
  "",
  "If the note is already detailed, sharpen and tighten it rather than padding it.",
].join("\n");

export async function enhanceConcept(
  input: EnhanceConceptInput,
  provider: PlanningProvider,
): Promise<ConceptEnhancement> {
  const user = JSON.stringify({
    concept: input.concept,
    runningTimeSeconds: input.requestedDurationSeconds,
    style: input.style,
    tone: input.tone,
    ...(input.audience ? { audience: input.audience } : {}),
    creativeMode: input.creativeMode,
  });

  // `generate` carries the failure reason; `generateJson` collapses it to null,
  // which left the screen able to say only that nothing came back.
  let raw: string | undefined;
  if (provider.generate) {
    const result = await provider.generate(CONCEPT_ENHANCER_SYSTEM, user, enhancedConceptSchema);
    if (!result.ok) return { ok: false, reason: describe(result.reason, result.detail) };
    raw = result.value.concept;
  } else {
    raw = (await provider.generateJson(CONCEPT_ENHANCER_SYSTEM, user, enhancedConceptSchema))
      ?.concept;
  }

  const concept = raw?.trim();
  if (!concept) return { ok: false, reason: "The planning model returned an empty answer." };
  if (concept.length > MAX_CONCEPT_CHARS) {
    return { ok: false, reason: "The planning model returned more text than the concept field holds." };
  }
  // Offering the writer their own sentence back invites them to accept a no-op.
  if (concept === input.concept.trim()) {
    return { ok: false, reason: "The planning model returned your concept unchanged." };
  }

  return { ok: true, concept };
}

function describe(reason: string, detail?: string): string {
  switch (reason) {
    case "timeout":
      return "The planning model timed out. It may still be loading.";
    case "request_failed":
      return `The planning model rejected the request${detail ? `: ${detail.slice(0, 200)}` : "."}`;
    case "unparseable_json":
    case "schema_mismatch":
      return "The planning model's answer did not match the expected shape.";
    case "format_unsupported":
      return "The planning model could not be asked for structured output.";
    default:
      return `The planning model failed (${reason}).`;
  }
}
