import { NextResponse } from "next/server";
import { z } from "zod";
import {
  clearSceneKeyframePreview,
  generateSceneKeyframe,
} from "@/lib/services/media-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  purpose: z.enum(["start_frame", "end_frame"]),
});

/**
 * Render one keyframe for a scene, without the other frame or the clip.
 *
 * A prompt change is usually obvious from a single still, so this exists to
 * avoid spending a full scene's GPU time to see it. The result is stored as a
 * preview, never as an attempt.
 */
export async function POST(
  request: Request,
  props: { params: Promise<{ projectId: string; sceneId: string }> }
) {
  const params = await props.params;
  try {
    const { purpose } = bodySchema.parse(await request.json());
    const record = await generateSceneKeyframe(params.projectId, params.sceneId, purpose);
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Discard a scene's previews once they have served their purpose. */
export async function DELETE(
  _request: Request,
  props: { params: Promise<{ projectId: string; sceneId: string }> }
) {
  const params = await props.params;
  try {
    const record = await clearSceneKeyframePreview(params.projectId, params.sceneId);
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
