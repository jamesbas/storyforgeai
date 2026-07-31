import { NextResponse } from "next/server";
import { importProject } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";
import { ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** A storyboard for a long project is large; well past that is not one of ours. */
const MAX_BYTES = 32 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const text = await request.text();
    if (text.length > MAX_BYTES) {
      throw new ValidationError("That file is too large to be a StoryForgeAI project.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ValidationError("That file is not valid JSON.");
    }
    const outcome = await importProject(parsed);
    return NextResponse.json(outcome, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
