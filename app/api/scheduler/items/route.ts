import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { addScheduleItem, getSchedulerSnapshot } from "@/lib/services/scheduler-service";

export const dynamic = "force-dynamic";

/**
 * Add an item: `{ revision, projectId, runType, scope, options }`.
 * Returns the new item — `invalid`, with its reason, when its position forbids
 * it — and the refreshed snapshot.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { revision, ...input } = body;
    const { item } = await addScheduleItem(input, revision);
    return NextResponse.json(
      { item, snapshot: await getSchedulerSnapshot() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
