import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import {
  clearVoiceSample,
  getCharacter,
  setVoiceSample,
  voiceSampleContentType,
} from "@/lib/services/character-service";
import { resolveVoiceSamplePath } from "@/lib/db/character-store";
import { toErrorResponse } from "@/lib/http";
import { ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ characterId: string }> };

/**
 * Serve a character's voice recording.
 *
 * The URL carries the character id, never a path: the filename comes from the
 * stored record and is re-validated against the voice directory before any read.
 */
export async function GET(_request: Request, props: Params) {
  const params = await props.params;
  try {
    const character = await getCharacter(params.characterId);
    const filename = character.voiceSample;
    const filePath = filename ? resolveVoiceSamplePath(filename) : null;
    if (!filename || !filePath) return new Response("No voice sample.", { status: 404 });

    const bytes = await fs.readFile(filePath).catch(() => null);
    if (!bytes) return new Response("No voice sample.", { status: 404 });

    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": voiceSampleContentType(filename),
        "content-length": String(bytes.byteLength),
        // Revalidate every load: replacing the recording can reuse the same URL.
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
    const character = await setVoiceSample(params.characterId, file);
    return NextResponse.json({ character });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: Params) {
  const params = await props.params;
  try {
    return NextResponse.json({ character: await clearVoiceSample(params.characterId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
