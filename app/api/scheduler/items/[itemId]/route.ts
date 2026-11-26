import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import {
  editScheduleItem,
  getSchedulerSnapshot,
  removeScheduleItem,
  scheduleItemAction,
} from "@/lib/services/scheduler-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ itemId: string }> };

const noStore = { headers: { "Cache-Control": "no-store" } };

async function body(request: Request): Promise<Record<string, unknown>> {
  return ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

/** Edit the scope or options of a waiting item: `{ revision, scope?, options? }`. */
export async function PATCH(request: Request, props: Params) {
  const { itemId } = await props.params;
  try {
    const { revision, ...patch } = await body(request);
    await editScheduleItem(itemId, patch, revision);
    return NextResponse.json(await getSchedulerSnapshot(), noStore);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Remove a non-running item: `{ revision }`. */
export async function DELETE(request: Request, props: Params) {
  const { itemId } = await props.params;
  try {
    const { revision } = await body(request);
    await removeScheduleItem(itemId, revision);
    return NextResponse.json(await getSchedulerSnapshot(), noStore);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** `{ revision, action: "moveUp" | "moveDown" | "duplicate" | "requeue" }` */
export async function POST(request: Request, props: Params) {
  const { itemId } = await props.params;
  try {
    const { revision, action } = await body(request);
    await scheduleItemAction(itemId, action, revision);
    return NextResponse.json(await getSchedulerSnapshot(), noStore);
  } catch (err) {
    return toErrorResponse(err);
  }
}
