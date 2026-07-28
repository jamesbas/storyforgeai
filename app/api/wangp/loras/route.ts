import { NextResponse } from "next/server";
import {
  catalogForModel,
  catalogForModelType,
  resetLoraCatalogCache,
  resolvePinnedModels,
} from "@/lib/services/lora-service";
import { getProjectRecord } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";
import type { LoraCatalog } from "@/lib/schemas/lora";

export const dynamic = "force-dynamic";

/**
 * LoRAs installed for a model.
 *
 * The WanGP MCP server publishes no LoRA inventory, so this is backed by a read
 * of the configured LoRA store. Only bare filenames are returned; absolute
 * paths stay server-side.
 *
 * Accepts either an explicit `model`, or a `projectId` + `kind` pair. The
 * latter exists because a project may leave its pin on "automatic", in which
 * case only the server knows which model will actually be used.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);

    // The picker's refresh button has to see a LoRA dropped into the folder a
    // moment ago, which the catalog TTL would otherwise hide.
    if (url.searchParams.get("refresh") === "1") resetLoraCatalogCache();

    const modelType = url.searchParams.get("model")?.trim();
    if (modelType) return json(await catalogForModelType(modelType));

    const projectId = url.searchParams.get("projectId")?.trim();
    const kind = url.searchParams.get("kind")?.trim();
    if (!projectId || (kind !== "image" && kind !== "video")) {
      return NextResponse.json(
        { error: "Provide `model`, or `projectId` with `kind` of image or video." },
        { status: 400 },
      );
    }

    const { project } = await getProjectRecord(projectId);
    const pinned = await resolvePinnedModels({
      imageModel: project.imageModel,
      videoModel: project.videoModel,
    });
    const model = pinned[kind];
    if (!model) {
      return json({
        supported: false,
        modelType: "",
        reason:
          `No ${kind} model is pinned for this project and none could be resolved, ` +
          `so there is no LoRA folder to read. Pin a ${kind} model first.`,
      });
    }

    return json(await catalogForModel(model));
  } catch (err) {
    return toErrorResponse(err);
  }
}

function json(catalog: LoraCatalog) {
  return NextResponse.json(catalog, {
    // Without this the browser heuristically caches the response and the picker
    // keeps showing a stale catalog after a refresh.
    headers: { "Cache-Control": "no-store" },
  });
}
