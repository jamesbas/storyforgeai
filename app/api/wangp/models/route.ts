import { NextResponse } from "next/server";
import { listWangpModels, resetWangpModelCache } from "@/lib/services/wangp-service";
import { toErrorResponse } from "@/lib/http";
import { isInstalled } from "@/lib/wangp/model-router";

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
    const availabilityKnown = models.some((model) => model.metadata.availability !== undefined);

    // V1 reports availability; V2 deliberately does not. Exclude only models
    // proved missing so a V2 server cannot turn a healthy catalogue into an
    // empty picker.
    if (params.get("installed") === "1") {
      const installed = models.filter(isInstalled);
      return NextResponse.json({ models: installed, total: models.length, availabilityKnown });
    }
    return NextResponse.json({ models, total: models.length, availabilityKnown });
  } catch (err) {
    return toErrorResponse(err);
  }
}
