import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { NotFoundError, ValidationError } from "@/lib/errors";

/**
 * Map thrown errors to JSON responses with the correct status.
 * Returns `{ error, details }` on validation failures (generic-build-spec 2.3).
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: "Validation failed", details: err.flatten() },
      { status: 400 },
    );
  }
  if (err instanceof ValidationError) {
    return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
  }
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : "Internal server error";
  return NextResponse.json({ error: message }, { status: 500 });
}
