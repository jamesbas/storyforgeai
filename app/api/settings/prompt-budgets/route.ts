import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import {
  getPromptBudgetSettings,
  savePromptBudgetSettings,
} from "@/lib/services/prompt-budget-settings-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(
      { settings: await getPromptBudgetSettings() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    return NextResponse.json(
      { settings: await savePromptBudgetSettings(await request.json()) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
