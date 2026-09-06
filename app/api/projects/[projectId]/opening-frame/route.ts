import { NextResponse } from "next/server";
import { pinOpeningFrame, unpinOpeningFrame } from "@/lib/services/media-service";
import { toErrorResponse } from "@/lib/http";
import { ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

/**
 * Pin a supplied image as scene 1's start frame.
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

    const result = await pinOpeningFrame(params.projectId, file, form.get("faceSwap") === "true");
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Release the pin, so scene 1 renders its own start frame again. */
export async function DELETE(_request: Request, props: Params) {
  const params = await props.params;
  try {
    const record = await unpinOpeningFrame(params.projectId);
    return NextResponse.json({ record }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
