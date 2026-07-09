import { NextResponse } from "next/server";
import { getWangpStatus } from "@/lib/services/wangp-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getWangpStatus());
  } catch (err) {
    return toErrorResponse(err);
  }
}
