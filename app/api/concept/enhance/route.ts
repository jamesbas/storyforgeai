import { NextResponse } from "next/server";
import { enhanceConcept } from "@/lib/agents/concept-enhancer";
import { getPlanningProvider, visionAvailable, visionIsSeparateModel } from "@/lib/agents/llm/provider";
import { ValidationError } from "@/lib/errors";
import { toErrorResponse } from "@/lib/http";
import { assertManualRunAllowed } from "@/lib/services/generation-busy";
import { uploadsAsDataUrls } from "@/lib/media/data-url";
import { MAX_CONCEPT_IMAGES } from "@/lib/media/concept-image-files";
import { enhanceConceptSchema } from "@/lib/schemas/intake";
import { logEvent } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

/**
 * Read the form fields from either transport.
 *
 * The form sends multipart when reference images are attached and JSON when
 * they are not, so anything already posting JSON keeps working.
 */
async function readRequest(request: Request): Promise<{ raw: unknown; files: File[] }> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("multipart/form-data")) {
    return { raw: await request.json(), files: [] };
  }

  const form = await request.formData();
  const files = form
    .getAll("images")
    .filter((entry): entry is File => entry instanceof File)
    .slice(0, MAX_CONCEPT_IMAGES);

  return {
    raw: {
      concept: form.get("concept"),
      // Numbers arrive as strings from a form body.
      requestedDurationSeconds: Number(form.get("requestedDurationSeconds")),
      style: form.get("style") ?? undefined,
      tone: form.get("tone") ?? undefined,
      audience: form.get("audience") || undefined,
      creativeMode: form.get("creativeMode") ?? undefined,
    },
    files,
  };
}

/**
 * Expand the concept typed on the New Project form, or — when the box is blank
 * and reference images are attached — write one from the pictures alone. Not
 * project-scoped: the project does not exist yet when this is called.
 *
 * Reference images may be attached. They are encoded for this one call and
 * never stored — the project they would belong to does not exist yet, which is
 * also why nothing here needs cleaning up afterwards.
 *
 * Returns a suggestion for the writer to accept or reject. Nothing is stored,
 * so a refusal costs nothing.
 */
export async function POST(request: Request) {
  try {
    assertManualRunAllowed("concept/enhance");
    const { raw, files } = await readRequest(request);
    const input = enhanceConceptSchema.parse(raw);

    const provider = getPlanningProvider();
    if (!provider) {
      throw new ValidationError(
        "Concept help needs the planning model. Enable AI planning and point OPENAI_BASE_URL at " +
          "your LM Studio server, then try again.",
      );
    }

    // Without a vision model the provider drops images and answers from the text
    // alone, so they are not loaded at all and the caller is told plainly rather
    // than left reading an answer that sounds like the pictures were seen.
    const vision = await visionAvailable();
    const images = vision ? await uploadsAsDataUrls(files, "concept_enhance") : [];

    if (files.length > 0) {
      logEvent("project.concept_enhance_images", {
        supplied: files.length,
        images: images.length,
        mode: vision ? "visual" : "text_only",
      });
    }

    // A blank concept asks for one written from the pictures, so each way of
    // having no pictures to read gets its own answer rather than a generic one.
    const fromImagesOnly = input.concept.trim() === "";
    if (fromImagesOnly) {
      if (files.length === 0) {
        throw new ValidationError(
          "Type a concept to expand, or attach reference images to have one written from them.",
        );
      }
      if (!vision) {
        throw new ValidationError(
          "Writing a concept from images alone needs a vision model. Set OPENAI_VISION_MODEL, or " +
            "type a concept to expand.",
        );
      }
      if (images.length === 0) {
        throw new ValidationError(
          "None of the reference images could be read, so there is nothing to write a concept from.",
        );
      }
    }

    // A separate vision model is often the smaller one, so it only reads the
    // pictures and the planning model writes. One model that does both sees them
    // directly, which keeps detail a description would lose.
    const readFirst = images.length > 0 && (await visionIsSeparateModel());
    const result = await enhanceConcept(input, provider, images, { readFirst });
    if (!result.ok) throw new ValidationError(`${result.reason} Your concept is unchanged.`);

    return NextResponse.json(
      {
        concept: result.concept,
        // What the answer was actually written from, so the screen can say so
        // rather than implying the pictures were read when they were not.
        imagesRead: images.length,
        imagesSupplied: files.length,
        visionAvailable: vision,
        fromImagesOnly,
        readFirst,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
