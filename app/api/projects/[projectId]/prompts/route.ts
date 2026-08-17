import { NextResponse } from "next/server";
import {
  regenerateAllScenePrompts,
  regenerateScenesPrompts,
  type PromptRewriteOptions,
} from "@/lib/services/project-service";
import type { PromptPass } from "@/lib/agents/prompt-agents";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

const PASSES: readonly PromptPass[] = ["image", "video"];

type RewriteRequest = { sceneIds: string[]; options: PromptRewriteOptions };

/**
 * The picked scenes and passes, defaulting to everything.
 *
 * A body naming no passes means both, so an older caller — or a caller that
 * sends no body at all — keeps the behaviour it had.
 */
async function parseRequest(request: Request): Promise<RewriteRequest> {
  try {
    const body = (await request.json()) as { sceneIds?: unknown; passes?: unknown };
    const wanted: unknown[] = Array.isArray(body?.passes) ? body.passes : [];
    const passes = PASSES.filter((pass) => wanted.includes(pass));
    return {
      sceneIds: Array.isArray(body?.sceneIds)
        ? body.sceneIds.filter((id): id is string => typeof id === "string")
        : [],
      options: passes.length ? { passes } : {},
    };
  } catch {
    return { sceneIds: [], options: {} };
  }
}

/**
 * Rewrite scene prompts from their cards, against the models pinned now.
 *
 * Scene cards are left alone: this re-runs the prompt agents, not the
 * storyboard, so the story survives and only its phrasing changes. An empty
 * selection means every scene, matching the clip queue.
 */
export async function POST(
  request: Request,
  props: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await props.params;
  try {
    const { sceneIds, options } = await parseRequest(request);
    const record = sceneIds.length
      ? await regenerateScenesPrompts(projectId, sceneIds, options)
      : await regenerateAllScenePrompts(projectId, options);
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
