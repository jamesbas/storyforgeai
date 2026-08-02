import { NextResponse } from "next/server";
import { auditRenderImages } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Check the project's own renders against its concept.
 *
 * Returns findings only. Nothing from this route reaches the storyboard agents,
 * by design — see `lib/agents/render-auditor.ts`.
 */
export async function POST(_request: Request, { params }: { params: { projectId: string } }) {
  try {
    const record = await auditRenderImages(params.projectId);
    return NextResponse.json(
      { renderAudit: record.renderAudit },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
