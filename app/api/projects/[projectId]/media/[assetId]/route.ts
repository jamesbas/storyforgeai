import { getProjectRecord } from "@/lib/services/project-service";
import { parseMediaRef, resolveMediaPath } from "@/lib/media/refs";
import { streamFile } from "@/lib/media/streaming";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * Stream a project's generated media by opaque asset id.
 *
 * The browser never sees a filesystem path: the id names a scene/attempt/role
 * (or the rough/final cut), the path comes from the persisted project record,
 * and `resolveMediaPath` enforces the approved-root policy before any read.
 */
export async function GET(
  request: Request,
  props: { params: Promise<{ projectId: string; assetId: string }> }
) {
  const params = await props.params;
  const ref = parseMediaRef(decodeURIComponent(params.assetId));
  if (!ref) return new Response("Unknown media reference.", { status: 400 });

  let filePath: string | null;
  try {
    filePath = resolveMediaPath(await getProjectRecord(params.projectId), ref);
  } catch (err) {
    if (err instanceof NotFoundError) return new Response("Project was not found.", { status: 404 });
    throw err;
  }
  if (!filePath) return new Response("Media was not found.", { status: 404 });

  return streamFile(filePath, request);
}
