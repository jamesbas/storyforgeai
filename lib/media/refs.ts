import fs from "node:fs";
import path from "node:path";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import { safeResolveMediaPath } from "@/lib/media/path-policy";

/**
 * Opaque media references.
 *
 * Browsers never receive a filesystem path. They receive an asset id built from
 * app-level identifiers (scene id, attempt id, role), and the server resolves
 * that back to a path through the persisted `ProjectRecord`. This is the
 * opaque-id indirection easynediacreator uses, but backed by durable project
 * state instead of an in-memory registry, so handles survive a restart.
 */

export const MEDIA_ROLES = ["start_frame", "end_frame", "video"] as const;
export type MediaRole = (typeof MEDIA_ROLES)[number];

export type MediaRef =
  | { kind: "scene"; sceneId: string; attemptId: string; role: MediaRole }
  | { kind: "cue"; cueId: string }
  | { kind: "rough_cut" }
  | { kind: "final_cut" };

const SEP = "~";
const ROUGH_CUT_ID = "rough-cut";
const FINAL_CUT_ID = "final-cut";
/** Ids are app-generated (UUIDs / slugs); reject anything that could be a path. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function encodeMediaRef(ref: MediaRef): string {
  if (ref.kind === "rough_cut") return ROUGH_CUT_ID;
  if (ref.kind === "final_cut") return FINAL_CUT_ID;
  if (ref.kind === "cue") return ["cue", ref.cueId].join(SEP);
  return ["scene", ref.sceneId, ref.attemptId, ref.role].join(SEP);
}

export function parseMediaRef(assetId: string): MediaRef | null {
  if (assetId === ROUGH_CUT_ID) return { kind: "rough_cut" };
  if (assetId === FINAL_CUT_ID) return { kind: "final_cut" };

  const parts = assetId.split(SEP);
  if (parts[0] === "cue") {
    if (parts.length !== 2 || !SAFE_ID.test(parts[1]!)) return null;
    return { kind: "cue", cueId: parts[1]! };
  }
  if (parts.length !== 4 || parts[0] !== "scene") return null;
  const [, sceneId, attemptId, role] = parts;
  if (!SAFE_ID.test(sceneId!) || !SAFE_ID.test(attemptId!)) return null;
  if (!(MEDIA_ROLES as readonly string[]).includes(role!)) return null;
  return { kind: "scene", sceneId: sceneId!, attemptId: attemptId!, role: role as MediaRole };
}

function attemptPath(record: ProjectRecord, ref: Extract<MediaRef, { kind: "scene" }>) {
  const attempt = record.attempts?.[ref.sceneId]?.find((a) => a.id === ref.attemptId);
  if (!attempt) return undefined;
  if (ref.role === "start_frame") return attempt.startImagePath;
  if (ref.role === "end_frame") return attempt.endImagePath;
  return attempt.videoPath;
}

/** Resolve a reference to a policy-approved absolute path, or null. */
export function resolveMediaPath(record: ProjectRecord, ref: MediaRef): string | null {
  const raw =
    ref.kind === "scene"
      ? attemptPath(record, ref)
      : ref.kind === "cue"
        ? record.audioPlan?.cues.find((c) => c.id === ref.cueId)?.generatedPath
        : ref.kind === "rough_cut"
          ? record.assembly?.roughCutPath
          : record.assembly?.finalPath;
  if (!raw) return null;
  return safeResolveMediaPath(raw);
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".mkv"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".flac", ".ogg", ".opus"]);

export function mediaKindFor(filePath: string): "image" | "video" | "audio" {
  const ext = path.extname(filePath).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return "image";
}

export type MediaDescriptor = {
  assetId: string;
  label: string;
  kind: "image" | "video" | "audio";
  url: string;
  downloadUrl: string;
  available: boolean;
  sizeBytes?: number;
  sceneId?: string;
  attemptId?: string;
  cueId?: string;
  role: string;
};

export function mediaUrl(projectId: string, assetId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(assetId)}`;
}

function describe(
  projectId: string,
  record: ProjectRecord,
  ref: MediaRef,
  label: string,
  role: string,
  extra: { sceneId?: string; attemptId?: string; cueId?: string } = {},
): MediaDescriptor | null {
  const resolved = resolveMediaPath(record, ref);
  if (!resolved) return null;

  let available = false;
  let sizeBytes: number | undefined;
  try {
    const stats = fs.statSync(resolved);
    available = stats.isFile();
    sizeBytes = available ? stats.size : undefined;
  } catch {
    available = false;
  }

  const assetId = encodeMediaRef(ref);
  const url = mediaUrl(projectId, assetId);
  return {
    assetId,
    label,
    kind: mediaKindFor(resolved),
    url,
    downloadUrl: `${url}?download=1`,
    available,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...extra,
    role,
  };
}

/**
 * Every servable asset for a project, with an `available` flag so the UI can
 * render players only for media that actually exists on disk (demo-mode mock
 * paths report unavailable).
 */
export function listProjectMedia(record: ProjectRecord): MediaDescriptor[] {
  const projectId = record.project.id;
  const out: MediaDescriptor[] = [];

  for (const scene of record.storyboard?.scenes ?? []) {
    const attempts = record.attempts?.[scene.id] ?? [];
    const attempt = attempts.find((a) => a.approved) ?? attempts[attempts.length - 1];
    if (!attempt) continue;

    const common = { sceneId: scene.id, attemptId: attempt.id };
    const entries: [MediaRole, string][] = [
      ["start_frame", `Scene ${scene.sceneNumber} start frame`],
      ["end_frame", `Scene ${scene.sceneNumber} end frame`],
      ["video", `Scene ${scene.sceneNumber} clip`],
    ];
    for (const [role, label] of entries) {
      const descriptor = describe(
        projectId,
        record,
        { kind: "scene", sceneId: scene.id, attemptId: attempt.id, role },
        label,
        role,
        common,
      );
      if (descriptor) out.push(descriptor);
    }
  }

  const roughCut = describe(projectId, record, { kind: "rough_cut" }, "Rough cut", "rough_cut");
  if (roughCut) out.push(roughCut);
  const finalCut = describe(projectId, record, { kind: "final_cut" }, "Final cut", "final_cut");
  if (finalCut) out.push(finalCut);

  for (const cue of record.audioPlan?.cues ?? []) {
    const descriptor = describe(
      projectId,
      record,
      { kind: "cue", cueId: cue.id },
      `${cue.kind === "music" ? "Music" : "SFX"} cue`,
      `cue_${cue.kind}`,
      { sceneId: cue.sceneId, cueId: cue.id },
    );
    if (descriptor) out.push(descriptor);
  }

  return out;
}
