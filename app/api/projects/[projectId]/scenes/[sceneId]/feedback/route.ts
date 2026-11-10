import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { applySceneFeedback, previewSceneFeedback } from "@/lib/services/scene-feedback-service";

export const dynamic = "force-dynamic";
const noStore = { headers: { "Cache-Control": "no-store" } };

export async function POST(
  request: Request,
  props: { params: Promise<{ projectId: string; sceneId: string }> },
) {
  const { projectId, sceneId } = await props.params;
  try {
    return NextResponse.json(await previewSceneFeedback(projectId, sceneId, await request.json()), noStore);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(
  request: Request,
  props: { params: Promise<{ projectId: string; sceneId: string }> },
) {
  const { projectId, sceneId } = await props.params;
  try {
    return NextResponse.json(await applySceneFeedback(projectId, sceneId, await request.json()), noStore);
  } catch (error) {
    return toErrorResponse(error);
  }
}
