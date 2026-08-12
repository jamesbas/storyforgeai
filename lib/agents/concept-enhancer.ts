import { z } from "zod";
import type { PlanningProvider } from "@/lib/agents/llm/provider";
import type { EnhanceConceptInput } from "@/lib/schemas/intake";
import { CREATIVE_MODE_DOCS } from "@/lib/presets";

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

/** A useful brief grows with the film, without becoming a scene-by-scene treatment. */
export function conceptWordTarget(seconds: number): { minimum: number; maximum: number } {
  if (seconds <= 30) return { minimum: 90, maximum: 150 };
  if (seconds <= 60) return { minimum: 140, maximum: 220 };
  if (seconds <= 120) return { minimum: 180, maximum: 300 };
  if (seconds <= 300) return { minimum: 240, maximum: 400 };
  return { minimum: 300, maximum: 500 };
}

export type ConceptEnhancement =
  | { ok: true; concept: string }
  | { ok: false; reason: string };

/**
 * The concept is the only thing every downstream agent reads, so a thin one
 * produces a thin film. This expands it without taking the decisions the writer
 * has not made yet — the prohibitions below are the load-bearing half.
 */
export const CONCEPT_ENHANCER_SYSTEM = [
  "You are a development editor. Expand a filmmaker's concept into a substantially more useful",
  "story brief. A storyboarding system reads only this prose, so every addition must give later",
  "agents concrete story information they can stage. Do not merely paraphrase or decorate the",
  "writer's sentences.",
  "",
  'Return JSON: { "concept": "<the expanded note>" }.',
  "",
  "The note is cohesive prose. Follow the targetWords range in the user payload. No headings,",
  "bullet points, preamble, title, analysis, or commentary about the concept.",
  "",
  "Preserve the writer's story:",
  "- Every concrete thing already in the note is a decision, not a suggestion: subjects, setting,",
  "  period, relationships, objects, events, outcome, genre, intensity and maturity level.",
  "- Never contradict the premise or quietly correct it, however odd it seems.",
  "- Do not sanitize, euphemize, moralize, or make the premise safer or more conventional. Match",
  "  the supplied tone and audience while remaining direct and specific.",
  "",
  "Develop it rather than repeating it:",
  "- Establish the opening situation and what puts it in motion.",
  "- Add a chronological chain of compatible actions, reactions, pressures or complications in",
  "  which each beat causes or motivates the next. Scale the number of beats to the running time.",
  "- Include a meaningful turn, escalation or reveal already latent in the premise, then state the",
  "  concrete end condition: what is visibly different when the film finishes.",
  "- For informational, commercial or presenter-led work, use question or need, development, proof",
  "  and payoff instead of forcing fictional conflict.",
  "- You may invent compatible connective details, unnamed supporting roles, obstacles, reactions,",
  "  props and consequences. Do not invent names, brands, dialogue, a separate subplot, a moral, or",
  "  a twist or outcome that redirects the writer's premise.",
  "- Prefer actions, choices, sensory details and consequences a camera or microphone can capture.",
  "  Style and tone should shape those details, not appear as a pile of adjectives.",
  "- Every sentence must add new usable information. Do not retell one event several ways to reach",
  "  the word target.",
  "",
  "Fit the running time and creativeModeGuidance in the user payload. A 30-second piece can carry",
  "one compact progression; a minute needs a clear turn and payoff; several minutes need multiple",
  "causal developments. Do not write a scene list or more story than the duration can hold.",
  "",
  "Leave the craft alone. No shot lists, camera moves, lens or lighting notes, scene numbers or",
  "edit directions — later stages decide those, and naming them here overrides them.",
  "",
  "If the input already meets the requested depth, improve causal clarity and specificity instead",
  "of padding it. The result must still be meaningfully different and more actionable.",
].join("\n");

export async function enhanceConcept(
  input: EnhanceConceptInput,
  provider: PlanningProvider,
): Promise<ConceptEnhancement> {
  const targetWords = conceptWordTarget(input.requestedDurationSeconds);
  const user = JSON.stringify({
    concept: input.concept,
    runningTimeSeconds: input.requestedDurationSeconds,
    targetWords,
    style: input.style,
    tone: input.tone,
    ...(input.audience ? { audience: input.audience } : {}),
    creativeMode: input.creativeMode,
    creativeModeGuidance: CREATIVE_MODE_DOCS[input.creativeMode],
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
  const originalWords = countWords(input.concept);
  const expandedWords = countWords(concept);
  if (originalWords < targetWords.minimum) {
    const minimumGrowth = Math.max(30, Math.ceil(originalWords * 0.35));
    if (expandedWords < originalWords + minimumGrowth) {
      return {
        ok: false,
        reason: "The planning model only rephrased the concept instead of meaningfully expanding it.",
      };
    }
  }

  return { ok: true, concept };
}

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
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
