import { NextResponse } from "next/server";
import { getWangpModelSchema } from "@/lib/services/wangp-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ modelType: string }> };

export async function GET(_request: Request, props: Params) {
  const params = await props.params;
  try {
    const schema = await getWangpModelSchema(params.modelType);
    return NextResponse.json(schema);
  } catch (err) {
    return toErrorResponse(err);
  }
}
