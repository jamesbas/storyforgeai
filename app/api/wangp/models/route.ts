import { NextResponse } from "next/server";
import { listWangpModels, resetWangpModelCache } from "@/lib/services/wangp-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;

    // A listing is otherwise answered from the cached catalogue and re-read
    // behind the caller, so the picker's Refresh button needs a way to say it
    // wants to wait for the current truth — a model that has just finished
    // downloading, most often.
    if (params.get("refresh") === "1") resetWangpModelCache();

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
