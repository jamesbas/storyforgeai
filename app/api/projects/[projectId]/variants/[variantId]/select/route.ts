import { NextResponse } from "next/server";
import { selectVariant } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: { projectId: string; variantId: string } };

export async function POST(_request: Request, { params }: Params) {
  try {
    const record = await selectVariant(params.projectId, params.variantId);
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}
