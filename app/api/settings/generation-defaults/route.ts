import { NextResponse } from "next/server";
import {
  getGenerationDefaults,
  saveGenerationDefaults,
} from "@/lib/services/generation-defaults-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * App-wide generation defaults for new projects.
 *
 * Not project-scoped, and deliberately so: these are read once when a project
 * is created and never consulted again, so there is no project to key them to.
 */
export async function GET() {
  try {
    return NextResponse.json(
      { defaults: await getGenerationDefaults() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const defaults = await saveGenerationDefaults(await request.json());
    return NextResponse.json({ defaults }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
