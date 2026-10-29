import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { listServerModels } from "@/lib/services/llm-runtime-service";
import {
  getPlanningModelSettings,
  savePlanningModelSettings,
} from "@/lib/services/planning-model-settings-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [settings, available] = await Promise.all([
      getPlanningModelSettings(),
      listServerModels(),
    ]);
    return NextResponse.json(
      { settings, available },
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
