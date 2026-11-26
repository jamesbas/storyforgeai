import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { listSchedulableProjects, schedulableScenes } from "@/lib/services/scheduler-service";

export const dynamic = "force-dynamic";

/**
 * What the add form offers: every project, or with `?projectId=` that
 * project's scenes and whether each already has keyframes and a clip.
 */
export async function GET(request: Request) {
  try {
    const projectId = new URL(request.url).searchParams.get("projectId");
    const body = projectId
      ? { scenes: await schedulableScenes(projectId) }
      : { projects: await listSchedulableProjects() };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
