import { NextResponse } from "next/server";
import { listMedia } from "@/lib/services/assembly-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Servable media descriptors for a project, with per-asset availability. */
export async function GET(_request: Request, { params }: { params: { projectId: string } }) {
  try {
    return NextResponse.json({ media: await listMedia(params.projectId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
