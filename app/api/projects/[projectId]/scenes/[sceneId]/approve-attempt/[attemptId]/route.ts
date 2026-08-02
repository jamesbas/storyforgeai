import { NextResponse } from "next/server";
import { approveAttempt } from "@/lib/services/media-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sceneId: string; attemptId: string }> };

export async function POST(_request: Request, props: Params) {
  const params = await props.params;
  try {
    const record = await approveAttempt(params.projectId, params.sceneId, params.attemptId);
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}
