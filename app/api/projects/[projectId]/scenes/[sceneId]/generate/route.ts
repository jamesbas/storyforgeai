import { NextResponse } from "next/server";
import { generateSceneMedia } from "@/lib/services/media-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sceneId: string }> };

export async function POST(_request: Request, props: Params) {
  const params = await props.params;
  try {
    const record = await generateSceneMedia(params.projectId, params.sceneId);
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}
