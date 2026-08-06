import { NextResponse } from "next/server";
import { importAttemptFrame } from "@/lib/services/media-service";
import { toErrorResponse } from "@/lib/http";
import { ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sceneId: string }> };

/**
 * Replace one of an attempt's keyframes with an uploaded image.
 *
 * The bytes are uploaded, never a path: a client-supplied path would reach the
 * filesystem ahead of the media containment policy.
 */
export async function POST(request: Request, props: Params) {
  const params = await props.params;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ValidationError("Expected a file field named 'file'");

    const purpose = form.get("purpose");
    if (purpose !== "start_frame" && purpose !== "end_frame") {
      throw new ValidationError("purpose must be start_frame or end_frame");
    }

    const result = await importAttemptFrame(params.projectId, params.sceneId, purpose, file);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
