import { NextResponse } from "next/server";
import { insertScene, previewSceneInsert } from "@/lib/services/scene-order-service";
import { toErrorResponse } from "@/lib/http";
import { ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

/**
 * A static segment beside `[sceneId]`, which Next resolves first. Scene ids are
 * generated, so none can ever be the literal string "insert".
 */
function anchor(request: Request): { anchorSceneId: string; side: "before" | "after" } {
  const params = new URL(request.url).searchParams;
  const anchorSceneId = params.get("anchorSceneId");
  const side = params.get("side");
  if (!anchorSceneId || (side !== "before" && side !== "after")) {
    throw new ValidationError("Supply anchorSceneId and side=before or side=after.");
  }
  return { anchorSceneId, side };
}

/** What inserting here would cost, without inserting anything. */
export async function GET(request: Request, props: Params) {
  const { projectId } = await props.params;
  try {
    const { anchorSceneId, side } = anchor(request);
    const impact = await previewSceneInsert(projectId, anchorSceneId, side);
    return NextResponse.json({ impact }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Add a scene beside an existing one.
 *
 * Returns the record with what the screen needs to scroll, announce and warn
 * without a second fetch — the minted id, its number, and whether the scene
 * that now follows is holding a frame it inherited from a different neighbour.
 */
export async function POST(request: Request, props: Params) {
  const { projectId } = await props.params;
  try {
    const result = await insertScene(projectId, await request.json());
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
