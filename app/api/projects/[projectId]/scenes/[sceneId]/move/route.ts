import { NextResponse } from "next/server";
import { moveScene, previewSceneMove } from "@/lib/services/scene-order-service";
import { toErrorResponse } from "@/lib/http";
import { ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sceneId: string }> };

function direction(request: Request): "up" | "down" {
  const value = new URL(request.url).searchParams.get("direction");
  if (value !== "up" && value !== "down") {
    throw new ValidationError("Supply direction=up or direction=down.");
  }
  return value;
}

/**
 * What moving this scene would cost, without moving it.
 *
 * The confirmation is built from this rather than from a guess at the shape of
 * the edit, so what it promises and what the move does cannot drift apart.
 */
export async function GET(request: Request, props: Params) {
  const params = await props.params;
  try {
    const impact = await previewSceneMove(params.projectId, params.sceneId, direction(request));
    return NextResponse.json({ impact }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Move this scene one position.
 *
 * Returns the impact alongside the record so the screen can report what the
 * move actually invalidated rather than repeating what the dialog predicted.
 */
export async function POST(request: Request, props: Params) {
  const params = await props.params;
  try {
    const body = await request.json().catch(() => ({}));
    const result = await moveScene(params.projectId, params.sceneId, body);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
