import { NextResponse } from "next/server";
import { getLlmRuntimeStatus } from "@/lib/services/llm-runtime-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Whether the planning model is currently holding the GPU. */
export async function GET() {
  try {
    return NextResponse.json(await getLlmRuntimeStatus(), {
      // Without an explicit directive the response carries no cache header at
      // all, and browsers fall back to heuristic caching — which showed a stale
      // "unloaded" long after the model had been loaded again.
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
