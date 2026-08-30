import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import {
  getSystemPromptSettings,
  saveSystemPromptSettings,
} from "@/lib/services/system-prompt-settings-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(
      { settings: await getSystemPromptSettings() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const settings = await saveSystemPromptSettings(await request.json());
    return NextResponse.json({ settings }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}