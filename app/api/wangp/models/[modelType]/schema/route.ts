import { NextResponse } from "next/server";
import { getWangpModelSchema } from "@/lib/services/wangp-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: { modelType: string } };

export async function GET(_request: Request, { params }: Params) {
  try {
    const schema = await getWangpModelSchema(params.modelType);
    return NextResponse.json(schema);
  } catch (err) {
    return toErrorResponse(err);
  }
}
