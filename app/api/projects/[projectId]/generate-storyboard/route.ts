import { NextResponse } from "next/server";
import { generateStoryboard } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(_request: Request, props: Params) {
  const params = await props.params;
  try {
    const record = await generateStoryboard(params.projectId);
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}
