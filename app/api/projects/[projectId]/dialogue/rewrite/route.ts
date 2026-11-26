import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { rewriteDialogue } from "@/lib/services/dialogue-rewrite-service";

export const dynamic = "force-dynamic";

/**
 * Rewrite the dialogue of the named scenes (or every under-covered one), and
 * optionally their video prompts. Keyframes and image prompts are not touched.
 */
export async function POST(
  request: Request,
  props: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await props.params;
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await rewriteDialogue(projectId, body), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
