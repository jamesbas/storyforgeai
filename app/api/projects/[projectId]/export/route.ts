import { getProjectRecord } from "@/lib/services/project-service";
import {
  storyboardToJson,
  storyboardToMarkdown,
  generationManifestToJson,
} from "@/lib/export/serialize";
import { exportContentDisposition } from "@/lib/export/file-name";
import { toErrorResponse } from "@/lib/http";
import { ValidationError } from "@/lib/errors";
import { logEvent } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, props: Params) {
  const params = await props.params;
  try {
    const record = await getProjectRecord(params.projectId);
    const format = new URL(request.url).searchParams.get("format") ?? "json";
    logEvent("storyboard.exported", { projectId: params.projectId, format });

    const title = record.project.title;
    const attachment = (base: string, extension: string) =>
      exportContentDisposition(base, title, extension);

    if (format === "md" || format === "markdown") {
      const markdown = storyboardToMarkdown(record);
      return new Response(markdown, {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": attachment("storyboard", "md"),
        },
      });
    }

    if (format === "animatic") {
      if (!record.animaticPlan) {
        throw new ValidationError("No animatic plan has been generated");
      }
      return new Response(JSON.stringify(record.animaticPlan, null, 2), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": attachment("animatic-plan", "json"),
        },
      });
    }

    if (format === "manifest") {
      return new Response(generationManifestToJson(record), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": attachment("generation-manifest", "json"),
        },
      });
    }

    if (format === "final-cut") {
      if (!record.assembly) {
        throw new ValidationError("No assembly has been produced");
      }
      return new Response(JSON.stringify(record.assembly.plan, null, 2), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": attachment("final-cut-plan", "json"),
        },
      });
    }

    const json = storyboardToJson(record);
    return new Response(json, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": attachment("storyboard", "json"),
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
