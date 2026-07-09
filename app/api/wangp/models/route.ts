import { NextResponse } from "next/server";
import { listWangpModels } from "@/lib/services/wangp-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const output = new URL(request.url).searchParams.get("output");
    const filter = output === "image" || output === "video" || output === "audio" ? output : undefined;
    const models = await listWangpModels(filter);
    return NextResponse.json({ models });
  } catch (err) {
    return toErrorResponse(err);
  }
}
