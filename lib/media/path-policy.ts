import fs from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";

/**
 * Filesystem containment policy for served media.
 *
 * Ported from easynediacreator `lib/security/path-policy.ts`. Generated media
 * lives outside the web root (WanGP writes to its own outputs folder), so every
 * path that reaches a streaming route must be proven to sit inside an approved
 * root. Both a lexical check and a symlink-resolved check are applied, which
 * blocks `../` traversal and symlink escapes.
 */

export class MediaAccessError extends Error {
  readonly code = "MEDIA_ACCESS_DENIED";
}

export function isPathInsideRoot(candidate: string, approvedRoot: string): boolean {
  if (!approvedRoot) return false;
  const root = path.resolve(approvedRoot);
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathOrNull(candidate: string): string | null {
  try {
    return fs.realpathSync.native(path.resolve(candidate));
  } catch {
    return null;
  }
}

/** Roots media may be served from: the project data dir and the WanGP outputs dir. */
export function approvedMediaRoots(): string[] {
  return [config.dataDir, config.wangp.outputDir].filter((root) => Boolean(root));
}

/**
 * Validate `candidate` against the approved roots and return its canonical path.
 *
 * Paths that do not exist yet still pass the lexical check (demo-mode mock paths
 * and not-yet-written outputs); the caller gets a 404 from the filesystem rather
 * than a policy error.
 */
export function assertPathInsideRoots(candidate: string, roots = approvedMediaRoots()): string {
  const configured = roots.filter(Boolean);
  if (!configured.length) throw new MediaAccessError("No approved media root is configured.");

  if (!configured.some((root) => isPathInsideRoot(candidate, root))) {
    throw new MediaAccessError("Media path is outside the approved roots.");
  }

  const canonicalTarget = realpathOrNull(candidate);
  if (!canonicalTarget) return path.resolve(candidate);

  const canonicalRoots = configured
    .map(realpathOrNull)
    .filter((root): root is string => root !== null);
  if (canonicalRoots.length && !canonicalRoots.some((root) => isPathInsideRoot(canonicalTarget, root))) {
    throw new MediaAccessError("Media path resolves outside the approved roots.");
  }
  return canonicalTarget;
}

/** Non-throwing variant for building listings. */
export function safeResolveMediaPath(candidate: string, roots = approvedMediaRoots()): string | null {
  try {
    return assertPathInsideRoots(candidate, roots);
  } catch {
    return null;
  }
}
