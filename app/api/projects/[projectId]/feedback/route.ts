import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { assertManualRunAllowed } from "@/lib/services/generation-busy";
import { refineScenesWithFeedback } from "@/lib/services/scene-feedback-service";

export const dynamic = "force-dynamic";

/** Apply one piece of feedback to the chosen prompts of the picked scenes, with no preview step. */
export async function POST(
  request: Request,
  props: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await props.params;
  try {
    assertManualRunAllowed("feedback");
    return NextResponse.json(
      await refineScenesWithFeedback(projectId, await request.json()),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
