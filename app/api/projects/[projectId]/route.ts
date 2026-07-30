import { NextResponse } from "next/server";
import { deleteProject, getProjectRecord, renameProject } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: { projectId: string } };

export async function GET(_request: Request, { params }: Params) {
  try {
    const record = await getProjectRecord(params.projectId);
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Rename a project. Metadata only — nothing downstream reads the title. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const record = await renameProject(params.projectId, await request.json());
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Delete a project.
 *
 * Generated media goes with it unless `?keepMedia=1` is passed — an orphaned
 * media folder is unreachable from the UI, so keeping it has to be deliberate.
 */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const keepMedia = new URL(request.url).searchParams.get("keepMedia") === "1";
    await deleteProject(params.projectId, { keepMedia });
    return NextResponse.json({ ok: true, keptMedia: keepMedia });
  } catch (err) {
    return toErrorResponse(err);
  }
}
