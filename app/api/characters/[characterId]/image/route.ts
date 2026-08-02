import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import {
  clearReferenceImage,
  getCharacter,
  referenceImageContentType,
  setReferenceImage,
} from "@/lib/services/character-service";
import { resolveReferenceImagePath } from "@/lib/db/character-store";
import { referenceImagesOf } from "@/lib/schemas/character";
import { toErrorResponse } from "@/lib/http";
import { ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ characterId: string }> };

/**
 * Serve a character's reference image.
 *
 * The URL carries the character id, never a path: the filename comes from the
 * stored record and is re-validated against the library root before any read.
 */
export async function GET(request: Request, props: Params) {
  const params = await props.params;
  try {
    const character = await getCharacter(params.characterId);
    const images = referenceImagesOf(character);

    // `?index=` selects between a character's reference images. Parsed as a
    // number and bounds-checked, so it can only ever pick from the stored list.
    const raw = new URL(request.url).searchParams.get("index");
    const index = raw === null ? 0 : Number.parseInt(raw, 10);
    const filename = Number.isInteger(index) ? images[index] : undefined;
    if (!filename) return new Response("No reference image.", { status: 404 });

    const filePath = resolveReferenceImagePath(filename);
    if (!filePath) return new Response("No reference image.", { status: 404 });

    const bytes = await fs.readFile(filePath).catch(() => null);
    if (!bytes) return new Response("No reference image.", { status: 404 });

    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": referenceImageContentType(filename),
        "content-length": String(bytes.byteLength),
        // Revalidate every load: replacing the image reuses the same URL.
        "cache-control": "no-cache",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: Params) {
  const params = await props.params;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ValidationError("Expected a file field named 'file'");
    const character = await setReferenceImage(params.characterId, file);
    return NextResponse.json({ character });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Remove one reference image by `?index=`, or all of them when omitted. */
export async function DELETE(request: Request, props: Params) {
  const params = await props.params;
  try {
    const raw = new URL(request.url).searchParams.get("index");
    if (raw === null) {
      return NextResponse.json({ character: await clearReferenceImage(params.characterId) });
    }

    const index = Number.parseInt(raw, 10);
    const character = await getCharacter(params.characterId);
    const filename = Number.isInteger(index) ? referenceImagesOf(character)[index] : undefined;
    if (!filename) throw new ValidationError("No reference image at that position.");

    return NextResponse.json({
      character: await clearReferenceImage(params.characterId, filename),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
