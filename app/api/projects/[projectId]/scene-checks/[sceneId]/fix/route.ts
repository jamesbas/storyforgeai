import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { sceneCheckFixPreviewSchema } from "@/lib/schemas/scene-check";
import { applySceneCheckFix, previewSceneCheckFix } from "@/lib/services/scene-check-service";

export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

/** Propose a fix for one finding. Nothing is written. */
export async function POST(
  request: Request,
  props: { params: Promise<{ projectId: string; sceneId: string }> },
) {
  const { projectId, sceneId } = await props.params;
  try {
    const { depth, findingId } = sceneCheckFixPreviewSchema.parse(await request.json());
    return NextResponse.json(await previewSceneCheckFix(projectId, sceneId, depth, findingId), noStore);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Apply a previewed fix. Refused if the text changed after the preview. */
export async function PUT(
  request: Request,
  props: { params: Promise<{ projectId: string; sceneId: string }> },
) {
  const { projectId, sceneId } = await props.params;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const record = await applySceneCheckFix(projectId, { ...body, sceneId });
    return NextResponse.json(record, noStore);
  } catch (err) {
    return toErrorResponse(err);
  }
}
