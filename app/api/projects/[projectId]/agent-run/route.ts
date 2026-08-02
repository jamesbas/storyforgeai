import { NextResponse } from "next/server";
import { getAgentRun } from "@/lib/services/agent-runs";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** What the Agentic Canvas polls to recover run state after a navigation. */
export async function GET(_request: Request, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    return NextResponse.json({ run: getAgentRun(params.projectId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
