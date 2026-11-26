import { NextResponse } from "next/server";
import { generateAudioPlan } from "@/lib/services/project-service";
import { toErrorResponse } from "@/lib/http";
import { assertManualRunAllowed } from "@/lib/services/generation-busy";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(_request: Request, props: Params) {
  const params = await props.params;
  try {
    assertManualRunAllowed("generate-audio-plan");
    const record = await generateAudioPlan(params.projectId);
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}
