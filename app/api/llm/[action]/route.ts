import { NextResponse } from "next/server";
import { loadPlanningModel, unloadPlanningModel } from "@/lib/services/llm-runtime-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Load or unload the planning model so it stops competing with generation for
 * the GPU. The action is taken from the path, and the model comes from
 * configuration, so no model identifier is ever accepted from the caller.
 */
export async function POST(_request: Request, { params }: { params: { action: string } }) {
  try {
    if (params.action === "load") return NextResponse.json(await loadPlanningModel());
    if (params.action === "unload") return NextResponse.json(await unloadPlanningModel());
    return NextResponse.json({ error: `Unknown action ${params.action}` }, { status: 404 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
