import { NextResponse } from "next/server";
import { createCharacter, listCharacters } from "@/lib/services/character-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** The global character library, shared by every project. */
export async function GET() {
  try {
    return NextResponse.json({ characters: await listCharacters() });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const character = await createCharacter(await request.json());
    return NextResponse.json({ character }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
