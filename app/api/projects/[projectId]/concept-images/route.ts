import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import {
  addConceptImage,
  conceptImageContentType,
  conceptImagePath,
  removeConceptImage,
} from "@/lib/services/concept-image-service";
import { getProjectRecord } from "@/lib/services/project-service";
import { conceptImageKindSchema } from "@/lib/schemas/project";
import { toErrorResponse } from "@/lib/http";
import { ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: { projectId: string } };

/**
 * Serve one of a project's concept images.
 *
 * `?name=` names a stored file, and it is checked against the project's own
 * record before any path is built — a name that is not in the record is a 404
 * whatever it points at.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const record = await getProjectRecord(params.projectId);
    const stored = record.project.conceptImages ?? [];
    const name = new URL(request.url).searchParams.get("name") ?? "";
    if (!stored.some((entry) => entry.name === name)) {
      return new Response("No such concept image.", { status: 404 });
    }

    const filePath = conceptImagePath(params.projectId, name);
    if (!filePath) return new Response("No such concept image.", { status: 404 });

    const bytes = await fs.readFile(filePath).catch(() => null);
    if (!bytes) return new Response("No such concept image.", { status: 404 });

    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": conceptImageContentType(name),
        "content-length": String(bytes.byteLength),
        "cache-control": "no-cache",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ValidationError("Expected a file field named 'file'");
    // Required, not defaulted. Guessing wrong lets a render inform the look.
    const kind = conceptImageKindSchema.safeParse(form.get("kind"));
    if (!kind.success) {
      throw new ValidationError("Expected a 'kind' field of 'reference' or 'render'");
    }
    const conceptImages = await addConceptImage(params.projectId, file, kind.data);
    return NextResponse.json({ conceptImages }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const name = new URL(request.url).searchParams.get("name") ?? undefined;
    const conceptImages = await removeConceptImage(params.projectId, name);
    return NextResponse.json({ conceptImages }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
