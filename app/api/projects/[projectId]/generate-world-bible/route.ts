import { NextResponse } from "next/server";
import { generateWorldBible } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: { projectId: string } };

export async function POST(_request: Request, { params }: Params) {
  try {
    const record = await generateWorldBible(params.projectId);
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}
