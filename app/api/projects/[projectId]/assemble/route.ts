import { NextResponse } from "next/server";
import { assembleRoughCut } from "@/lib/services/assembly-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: { projectId: string } };

export async function POST(_request: Request, { params }: Params) {
  try {
    const record = await assembleRoughCut(params.projectId);
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}
