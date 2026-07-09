import { NextResponse } from "next/server";
import { getVariants } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: { projectId: string } };

export async function GET(_request: Request, { params }: Params) {
  try {
    const variants = await getVariants(params.projectId);
    return NextResponse.json({ variants });
  } catch (err) {
    return toErrorResponse(err);
  }
}
