import { NextResponse } from "next/server";
import { deleteCharacter, getCharacter, updateCharacter } from "@/lib/services/character-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ characterId: string }> };

export async function GET(_request: Request, props: Params) {
  const params = await props.params;
  try {
    return NextResponse.json({ character: await getCharacter(params.characterId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, props: Params) {
  const params = await props.params;
  try {
    const character = await updateCharacter(params.characterId, await request.json());
    return NextResponse.json({ character });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: Params) {
  const params = await props.params;
  try {
    await deleteCharacter(params.characterId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
