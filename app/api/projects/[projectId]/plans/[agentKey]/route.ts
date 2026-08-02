import { NextResponse } from "next/server";
import { updatePlan } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  props: { params: Promise<{ projectId: string; agentKey: string }> }
) {
  const params = await props.params;
  try {
    const body = await request.json();
    const record = await updatePlan(params.projectId, params.agentKey, body);
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}
