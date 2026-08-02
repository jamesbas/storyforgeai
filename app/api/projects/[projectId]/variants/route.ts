import { NextResponse } from "next/server";
import { getVariants } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, props: Params) {
  const params = await props.params;
  try {
    const variants = await getVariants(params.projectId);
    return NextResponse.json({ variants });
  } catch (err) {
    return toErrorResponse(err);
  }
}
