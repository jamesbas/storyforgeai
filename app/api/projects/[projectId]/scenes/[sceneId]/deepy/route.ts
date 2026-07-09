import { NextResponse } from "next/server";
import { z } from "zod";
import { DEEPY_ACTIONS, runDeepy } from "@/lib/deepy/deepy";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: { projectId: string; sceneId: string } };

const bodySchema = z.object({
  action: z.enum(DEEPY_ACTIONS),
  target: z.string().optional(),
});

export async function POST(request: Request, { params }: Params) {
  try {
    const body = bodySchema.parse(await request.json());
    const result = runDeepy(body.action, body.target ?? params.sceneId);
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
