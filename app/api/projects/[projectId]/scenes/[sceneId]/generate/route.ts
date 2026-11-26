import { NextResponse } from "next/server";
import { generateSceneMedia } from "@/lib/services/media-service";
import { toErrorResponse } from "@/lib/http";
import { assertManualRunAllowed, trackSceneRender } from "@/lib/services/generation-busy";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sceneId: string }> };

export async function POST(_request: Request, props: Params) {
  const params = await props.params;
  try {
    assertManualRunAllowed("scenes/generate");
    // Tracked so the Scheduler waits behind it rather than starting beside it.
    const record = await trackSceneRender(params.projectId, "Scene render", () =>
      generateSceneMedia(params.projectId, params.sceneId),
    );
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}
