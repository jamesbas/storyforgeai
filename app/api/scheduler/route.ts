import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { getScheduleState, getSchedulerSnapshot, scheduleAction } from "@/lib/services/scheduler-service";

export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };

/** The schedule, plus what is running and what holds the GPU. Polled by the Scheduler tab. */
export async function GET(request: Request) {
  try {
    // The nav tab's status dot needs only the state, once per navigation.
    if (new URL(request.url).searchParams.get("summary") === "1") {
      return NextResponse.json({ state: await getScheduleState() }, noStore);
    }
    return NextResponse.json(await getSchedulerSnapshot(), noStore);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** `{ action: "start" | "pause" | "resume" | "cancelCurrent" | "clearFinished", revision }` */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; revision?: unknown };
    await scheduleAction(body.action, body.revision);
    return NextResponse.json(await getSchedulerSnapshot(), noStore);
  } catch (err) {
    return toErrorResponse(err);
  }
}
