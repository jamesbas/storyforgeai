import { NextResponse } from "next/server";
import { z } from "zod";
import {
  approveAudioCue,
  generateAudioCue,
  removeAudioCue,
  updateAudioCue,
} from "@/lib/services/audio-service";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; cueId: string }> };

const patchSchema = z.object({
  prompt: z.string().min(1).optional(),
  startSeconds: z.number().nonnegative().optional(),
  durationSeconds: z.number().positive().optional(),
  gainDb: z.number().optional(),
  fadeInSeconds: z.number().nonnegative().optional(),
  fadeOutSeconds: z.number().nonnegative().optional(),
  duckNativeDb: z.number().max(0).optional(),
});

const actionSchema = z.object({
  action: z.enum(["generate", "approve", "unapprove"]),
});

export async function PATCH(request: Request, props: Params) {
  const params = await props.params;
  try {
    const body = patchSchema.parse(await request.json());
    return NextResponse.json(await updateAudioCue(params.projectId, params.cueId, body));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: Params) {
  const params = await props.params;
  try {
    const { action } = actionSchema.parse(await request.json());
    const record =
      action === "generate"
        ? await generateAudioCue(params.projectId, params.cueId)
        : await approveAudioCue(params.projectId, params.cueId, action === "approve");
    return NextResponse.json(record);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: Params) {
  const params = await props.params;
  try {
    return NextResponse.json(await removeAudioCue(params.projectId, params.cueId));
  } catch (err) {
    return toErrorResponse(err);
  }
}
