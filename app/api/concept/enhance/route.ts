import { NextResponse } from "next/server";
import { enhanceConcept } from "@/lib/agents/concept-enhancer";
import { getPlanningProvider } from "@/lib/agents/llm/provider";
import { ValidationError } from "@/lib/errors";
import { toErrorResponse } from "@/lib/http";
import { enhanceConceptSchema } from "@/lib/schemas/intake";

export const dynamic = "force-dynamic";

/**
 * Expand the concept typed on the New Project form. Not project-scoped: the
 * project does not exist yet when this is called.
 *
 * Returns a suggestion for the writer to accept or reject. Nothing is stored,
 * so a refusal costs nothing.
 */
export async function POST(request: Request) {
  try {
    const input = enhanceConceptSchema.parse(await request.json());

    const provider = getPlanningProvider();
    if (!provider) {
      throw new ValidationError(
        "Concept help needs the planning model. Enable AI planning and point OPENAI_BASE_URL at " +
          "your LM Studio server, then try again.",
      );
    }

    const result = await enhanceConcept(input, provider);
    if (!result.ok) throw new ValidationError(`${result.reason} Your concept is unchanged.`);

    return NextResponse.json({ concept: result.concept }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
