import { approveAllScenes } from "@/lib/services/media-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(_request: Request, props: Params) {
  const params = await props.params;
  try {
    const { record, result } = await approveAllScenes(params.projectId);
    return Response.json({ record, result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
