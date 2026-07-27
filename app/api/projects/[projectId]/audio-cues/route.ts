import { NextResponse } from "next/server";
import { z } from "zod";
import { addAudioCue } from "@/lib/services/audio-service";
import { getProjectRecord } from "@/lib/services/project-service";
import { AUDIO_CUE_KINDS } from "@/lib/schemas/audio";
import { toErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: { projectId: string } };

const createSchema = z.object({
  sceneId: z.string().min(1),
  kind: z.enum(AUDIO_CUE_KINDS),
  prompt: z.string().min(1),
  startSeconds: z.number().nonnegative().optional(),
  durationSeconds: z.number().positive().optional(),
  gainDb: z.number().optional(),
  fadeInSeconds: z.number().nonnegative().optional(),
  fadeOutSeconds: z.number().nonnegative().optional(),
  duckNativeDb: z.number().max(0).optional(),
});

export async function GET(_request: Request, { params }: Params) {
  try {
    const record = await getProjectRecord(params.projectId);
    return NextResponse.json({ cues: record.audioPlan?.cues ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const body = createSchema.parse(await request.json());
    return NextResponse.json(await addAudioCue(params.projectId, body));
  } catch (err) {
    return toErrorResponse(err);
  }
}
