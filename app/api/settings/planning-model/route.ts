import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import {
  getPlanningModelSettings,
  savePlanningModelSettings,
} from "@/lib/services/planning-model-settings-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(
      { settings: await getPlanningModelSettings() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    return NextResponse.json(
      { settings: await savePlanningModelSettings(await request.json()) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
