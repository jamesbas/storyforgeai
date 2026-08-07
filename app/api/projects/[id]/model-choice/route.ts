import { NextResponse } from "next/server";
import { getProjectRecord } from "@/lib/services/project-service";
import { getWangpStatus, previewModelChoice } from "@/lib/services/wangp-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * What "Automatic" actually resolves to for this project, and whether WanGP is
 * answering at all.
 *
 * Both halves of one question. An empty model picker has two very different
 * causes — nothing installed, or nothing reachable — and the screen cannot tell
 * them apart from the catalogue alone, because an unreachable server and an
 * empty one both return no models.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { project } = await getProjectRecord(id);
    const status = await getWangpStatus();

    const choice = status.ok
      ? await previewModelChoice({
          modelStrategy: project.modelStrategy,
          imageModel: project.imageModel,
          videoModel: project.videoModel,
          needsReferenceImages:
            Boolean(project.useCharacterLibrary && project.characterIds?.length) &&
            project.useCharacterReferenceImages !== false,
        })
      : { image: null, video: null };

    return NextResponse.json({
      status,
      image: choice.image
        ? { modelType: choice.image.modelType, name: choice.image.name }
        : null,
      video: choice.video
        ? { modelType: choice.video.modelType, name: choice.video.name }
        : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
