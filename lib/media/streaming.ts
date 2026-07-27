import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

/**
 * HTTP range streaming for local media files.
 *
 * Ported from easynediacreator `app/api/assets/[id]/content/route.ts`. Range
 * support is what makes `<video>` scrubbing work; without a 206 response the
 * browser can only play a clip from the start.
 *
 * Callers must have already validated the path against the media root policy.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export type ParsedRange = { start: number; end: number };

/** Parse a single-range `bytes=` header. Returns null when unsatisfiable. */
export function parseRangeHeader(header: string, size: number): ParsedRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  // Suffix form: `bytes=-500` means the last 500 bytes.
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end };
}

function sanitizeFilename(name: string): string {
  return name.replace(/["\r\n]/g, "_");
}

/**
 * Adapt a Node read stream to a web stream.
 *
 * `Readable.toWeb` is not used here: when the client aborts a range request the
 * web controller closes while the file stream keeps emitting, and the resulting
 * `enqueue` on a closed controller surfaces as an uncaughtException that can
 * take the process down. A `<video>` element aborts constantly while scrubbing,
 * so this is the common path rather than an edge case. Enqueuing is guarded and
 * cancellation destroys the file handle.
 */
function toWebStream(nodeStream: Readable): ReadableStream<Uint8Array> {
  let closed = false;
  const finish = (fn: () => void) => {
    if (closed) return;
    closed = true;
    try {
      fn();
    } catch {
      // Controller already torn down by an abort; nothing left to report to.
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          // Client went away mid-chunk: stop reading and release the handle.
          closed = true;
          nodeStream.destroy();
          return;
        }
        if (controller.desiredSize !== null && controller.desiredSize <= 0) nodeStream.pause();
      });
      nodeStream.on("end", () => finish(() => controller.close()));
      nodeStream.on("error", (error) => finish(() => controller.error(error)));
    },
    pull() {
      nodeStream.resume();
    },
    cancel() {
      closed = true;
      nodeStream.destroy();
    },
  });
}

/**
 * Stream a file, honouring `Range` and an optional `?download=1` attachment.
 * Returns 404 when the file is missing, 416 for an unsatisfiable range.
 */
export async function streamFile(filePath: string, request: Request): Promise<Response> {
  let size: number;
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) return new Response("Media file was not found.", { status: 404 });
    size = stats.size;
  } catch {
    return new Response("Media file was not found.", { status: 404 });
  }

  const download = new URL(request.url).searchParams.get("download") === "1";
  const baseHeaders: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Content-Type": contentTypeFor(filePath),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=0, must-revalidate",
    ...(download
      ? { "Content-Disposition": `attachment; filename="${sanitizeFilename(path.basename(filePath))}"` }
      : {}),
  };

  const rangeHeader = request.headers.get("range");
  if (rangeHeader) {
    const range = parseRangeHeader(rangeHeader, size);
    if (!range) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const stream = toWebStream(createReadStream(filePath, { start: range.start, end: range.end }));
    return new Response(stream, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      },
    });
  }

  const stream = toWebStream(createReadStream(filePath));
  return new Response(stream, { headers: { ...baseHeaders, "Content-Length": String(size) } });
}
