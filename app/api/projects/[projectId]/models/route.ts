import { NextResponse } from "next/server";
import { updateProjectModels } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Change the WanGP model pins for a project. */
export async function PATCH(
  request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const body = await request.json();
    const record = await updateProjectModels(params.projectId, body);
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}
