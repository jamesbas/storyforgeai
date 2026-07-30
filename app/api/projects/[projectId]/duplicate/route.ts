import { NextResponse } from "next/server";
import { duplicateProject } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Copy a project's plan into a new project. Generated media is not copied. */
export async function POST(
  _request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const project = await duplicateProject(params.projectId);
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
