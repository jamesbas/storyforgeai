import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { applyDialogueSync, previewDialogueSync } from "@/lib/services/dialogue-sync-service";

export const dynamic = "force-dynamic";
const noStore = { headers: { "Cache-Control": "no-store" } };

/** Preview copying the video prompts' dialogue onto the scene cards. Nothing is saved. */
export async function POST(
  request: Request,
  props: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await props.params;
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await previewDialogueSync(projectId, body), noStore);
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Save the previewed dialogue onto the scene cards. The prompts are not touched. */
export async function PUT(
  request: Request,
  props: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await props.params;
  try {
    return NextResponse.json(await applyDialogueSync(projectId, await request.json()), noStore);
  } catch (error) {
    return toErrorResponse(error);
  }
}
