import { NextResponse } from "next/server";
import { submitJob } from "@/lib/services/wangp-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { settings?: Record<string, unknown> };
    const job = await submitJob(body.settings ?? {});
    return NextResponse.json({ job }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
