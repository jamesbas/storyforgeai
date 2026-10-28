import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { addImagePromptText } from "@/lib/services/prompt-tools-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params;
  try {
    const record = await addImagePromptText(projectId, await request.json());
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Send valid JSON." }, { status: 400 });
    }
    return toErrorResponse(error);
  }
}
