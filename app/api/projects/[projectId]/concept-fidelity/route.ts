import { NextResponse } from "next/server";
import { checkConceptFidelity } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Check the project's finished frames against its concept.
 *
 * Returns findings only. Nothing from this route reaches the storyboard agents,
 * by design — see `lib/agents/concept-fidelity.ts`.
 */
export async function POST(_request: Request, { params }: { params: { projectId: string } }) {
  try {
    const record = await checkConceptFidelity(params.projectId);
    return NextResponse.json(
      { conceptFidelity: record.conceptFidelity },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
