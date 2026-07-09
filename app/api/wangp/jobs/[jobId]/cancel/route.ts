import { NextResponse } from "next/server";
import { cancelJob } from "@/lib/services/wangp-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: { jobId: string } };

export async function POST(_request: Request, { params }: Params) {
  try {
    const job = await cancelJob(params.jobId);
    return NextResponse.json({ job });
  } catch (err) {
    return toErrorResponse(err);
  }
}
