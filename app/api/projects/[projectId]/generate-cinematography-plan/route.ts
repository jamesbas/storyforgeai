import { NextResponse } from "next/server";
import { generateCinematographyPlan } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";
import { assertManualRunAllowed } from "@/lib/services/generation-busy";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(_request: Request, props: Params) {
  const params = await props.params;
  try {
    assertManualRunAllowed("generate-cinematography-plan");
    const record = await generateCinematographyPlan(params.projectId);
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}
