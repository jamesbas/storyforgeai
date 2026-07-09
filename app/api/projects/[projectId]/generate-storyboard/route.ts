import { NextResponse } from "next/server";
import { generateStoryboard } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: { projectId: string } };

export async function POST(_request: Request, { params }: Params) {
  try {
    const record = await generateStoryboard(params.projectId);
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}
