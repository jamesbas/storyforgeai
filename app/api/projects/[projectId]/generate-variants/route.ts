import { NextResponse } from "next/server";
import { generateVariants } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";
import { assertManualRunAllowed } from "@/lib/services/generation-busy";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(_request: Request, props: Params) {
  const params = await props.params;
  try {
    assertManualRunAllowed("generate-variants");
    const record = await generateVariants(params.projectId);
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}
