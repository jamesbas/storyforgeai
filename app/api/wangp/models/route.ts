import { NextResponse } from "next/server";
import { listWangpModels } from "@/lib/services/wangp-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const output = params.get("output");
    const filter = output === "image" || output === "video" || output === "audio" ? output : undefined;
    const models = await listWangpModels(filter);

    // WanGP accepts a job for a model it does not have and downloads the
    // weights first — tens of gigabytes with no progress signal. A picker
    // should default to what can actually render now.
    if (params.get("installed") === "1") {
      const installed = models.filter((m) => m.metadata.availability === "available");
      return NextResponse.json({ models: installed, total: models.length });
    }
    return NextResponse.json({ models, total: models.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
