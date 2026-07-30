import type { AspectRatio, ResolutionPreset } from "@/lib/types";

/**
 * The frame size a job should render at.
 *
 * Both inputs were previously inert: every manifest wrote `DEFAULT_RESOLUTION`
 * regardless of the project, so a 9:16 short rendered landscape and the
 * draft/standard/high preset changed nothing at all. The Help page described
 * behaviour the build did not have.
 *
 * Sizes are a fixed table rather than arithmetic. Diffusion resolutions are
 * conventional, need to be multiples of 16, and a computed 1920x1080 is wrong
 * where the convention — and WanGP's own default — is 1920x1088.
 */
const SIZES: Record<Exclude<AspectRatio, "custom">, Record<ResolutionPreset, string>> = {
  "16:9": { draft: "848x480", standard: "1280x720", high: "1920x1088" },
  "9:16": { draft: "480x848", standard: "720x1280", high: "1088x1920" },
  "1:1": { draft: "512x512", standard: "768x768", high: "1024x1024" },
};

/** How much the preset scales the configured step floor. */
const STEP_SCALE: Record<ResolutionPreset, number> = { draft: 0.6, standard: 1, high: 1.5 };

function parse(size: string): { width: number; height: number } | undefined {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim());
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

const orientation = (size: { width: number; height: number }) =>
  size.width === size.height ? "square" : size.width > size.height ? "landscape" : "portrait";

/**
 * Pick the frame size for a job.
 *
 * `allowed` is the model's declared list when it publishes one. Sending a size
 * a model does not offer is a job that fails minutes later, so the target is
 * snapped to the nearest offered size of the same orientation — never to a
 * landscape size for a portrait project, which would be a worse answer than
 * failing.
 */
export function resolveResolution(args: {
  aspectRatio: AspectRatio;
  preset: ResolutionPreset;
  /** Used verbatim for the `custom` aspect ratio, which we cannot infer. */
  fallback: string;
  allowed?: readonly string[];
}): string {
  const target =
    args.aspectRatio === "custom" ? args.fallback : SIZES[args.aspectRatio][args.preset];

  if (!args.allowed?.length) return target;
  if (args.allowed.includes(target)) return target;

  const wanted = parse(target);
  if (!wanted) return args.allowed[0]!;

  const candidates = args.allowed
    .map((size) => ({ size, parsed: parse(size) }))
    .filter((entry): entry is { size: string; parsed: { width: number; height: number } } =>
      entry.parsed !== undefined,
    );
  if (!candidates.length) return target;

  const sameShape = candidates.filter(
    (entry) => orientation(entry.parsed) === orientation(wanted),
  );
  const pool = sameShape.length ? sameShape : candidates;

  const pixels = wanted.width * wanted.height;
  return pool.reduce((best, entry) =>
    Math.abs(entry.parsed.width * entry.parsed.height - pixels) <
    Math.abs(best.parsed.width * best.parsed.height - pixels)
      ? entry
      : best,
  ).size;
}

/**
 * The step floor for a preset.
 *
 * Scales the configured floor rather than replacing it, so `WANGP_MIN_*_STEPS`
 * stays meaningful as the standard-quality baseline. Only the floor moves — a
 * step count named by an accelerator LoRA is a hard requirement of that LoRA
 * and is not something a quality preset gets to overrule.
 */
export function stepFloorFor(preset: ResolutionPreset, floor: number): number {
  return Math.max(1, Math.round(floor * STEP_SCALE[preset]));
}
