import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { assertManualRunAllowed } from "@/lib/services/generation-busy";
import { applyCardFeedback, previewCardFeedback } from "@/lib/services/card-feedback-service";

export const dynamic = "force-dynamic";
const noStore = { headers: { "Cache-Control": "no-store" } };

/** Preview card corrections for the picked scenes. Nothing is saved. */
export async function POST(
  request: Request,
  props: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await props.params;
  try {
    assertManualRunAllowed("feedback/cards");
    return NextResponse.json(await previewCardFeedback(projectId, await request.json()), noStore);
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Save the previewed corrections, then rewrite the ticked prompts from the corrected cards. */
export async function PUT(
  request: Request,
  props: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await props.params;
  try {
    return NextResponse.json(await applyCardFeedback(projectId, await request.json()), noStore);
  } catch (error) {
    return toErrorResponse(error);
  }
}
