import { NextResponse } from "next/server";
import { getProjectRecord } from "@/lib/services/project-service";
import { getWangpStatus, previewModelChoice } from "@/lib/services/wangp-service";
import { sendsFrameReferences } from "@/lib/services/media-service";
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
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    const { project } = await getProjectRecord(projectId);
    const status = await getWangpStatus();

    // Two independent reasons a job carries reference images, and the screen
    // has to name the right one: turning the character library off does not
    // stop a carried frame being handed back to the model.
    const characterRefs =
      Boolean(project.useCharacterLibrary && project.characterIds?.length) &&
      project.useCharacterReferenceImages !== false;
    const carriedFrames = sendsFrameReferences(project);

    const choice = status.ok
      ? await previewModelChoice({
          modelStrategy: project.modelStrategy,
          imageModel: project.imageModel,
          videoModel: project.videoModel,
          needsReferenceImages: characterRefs || carriedFrames,
        })
      : { image: null, video: null };

    return NextResponse.json({
      status,
      refsNeededFor: { characters: characterRefs, carriedFrames },
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
