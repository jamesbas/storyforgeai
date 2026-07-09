import { NextResponse } from "next/server";
import { listExports } from "@/lib/services/assembly-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: { projectId: string } };

export async function GET(_request: Request, { params }: Params) {
  try {
    const exports = await listExports(params.projectId);
    return NextResponse.json({ exports });
  } catch (err) {
    return toErrorResponse(err);
  }
}
