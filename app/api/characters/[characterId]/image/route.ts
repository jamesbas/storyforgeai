import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import {
  clearReferenceImage,
  getCharacter,
  referenceImageContentType,
  setReferenceImage,
} from "@/lib/services/character-service";
import { resolveReferenceImagePath } from "@/lib/db/character-store";
import { toErrorResponse } from "@/lib/http";
import { ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: { characterId: string } };

/**
 * Serve a character's reference image.
 *
 * The URL carries the character id, never a path: the filename comes from the
 * stored record and is re-validated against the library root before any read.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const character = await getCharacter(params.characterId);
    if (!character.referenceImage) {
      return new Response("No reference image.", { status: 404 });
    }
    const filePath = resolveReferenceImagePath(character.referenceImage);
    if (!filePath) return new Response("No reference image.", { status: 404 });

    const bytes = await fs.readFile(filePath).catch(() => null);
    if (!bytes) return new Response("No reference image.", { status: 404 });

    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": referenceImageContentType(character.referenceImage),
        "content-length": String(bytes.byteLength),
        // Revalidate every load: replacing the image reuses the same URL.
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
    const character = await setReferenceImage(params.characterId, file);
    return NextResponse.json({ character });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    return NextResponse.json({ character: await clearReferenceImage(params.characterId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
