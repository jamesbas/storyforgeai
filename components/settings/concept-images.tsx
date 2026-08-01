"use client";

import { useCallback, useRef, useState } from "react";
import type { ConceptVisuals } from "@/lib/schemas/agents";

const MAX_CONCEPT_IMAGES = 6;

/**
 * Concept images for a project, and the reading taken from them.
 *
 * A photograph of the set, the wardrobe or the lighting carries more than a
 * paragraph describing it. The images are not sent to the storyboard agents
 * directly — the Concept Reader turns them into text once, and that text is what
 * the rest of the pipeline uses.
 */
export function ConceptImages({
  projectId,
  initial,
  initialVisuals,
}: {
  projectId: string;
  initial: readonly string[];
  initialVisuals?: ConceptVisuals;
}) {
  const [images, setImages] = useState<string[]>([...initial]);
  const [visuals, setVisuals] = useState<ConceptVisuals | undefined>(initialVisuals);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Uploading the same file twice is a legitimate retry, so the input is
  // cleared after every attempt or the change event never fires again.
  const resetInput = () => {
    if (fileInput.current) fileInput.current.value = "";
  };

  const upload = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      setBusy(true);
      setError(null);
      try {
        for (const file of Array.from(files)) {
          const form = new FormData();
          form.append("file", file);
          const res = await fetch(`/api/projects/${projectId}/concept-images`, {
            method: "POST",
            body: form,
          });
          const body = (await res.json().catch(() => null)) as
            | { conceptImages?: string[]; error?: string }
            | null;
          if (!res.ok) throw new Error(body?.error ?? `Failed to upload ${file.name}`);
          setImages(body?.conceptImages ?? []);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setBusy(false);
        resetInput();
      }
    },
    [projectId],
  );

  const remove = useCallback(
    async (name: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/concept-images?name=${encodeURIComponent(name)}`,
          { method: "DELETE" },
        );
        const body = (await res.json().catch(() => null)) as
          | { conceptImages?: string[]; error?: string }
          | null;
        if (!res.ok) throw new Error(body?.error ?? "Failed to remove image");
        setImages(body?.conceptImages ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Remove failed");
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const read = useCallback(async () => {
    setReading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/read-concept-images`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { conceptVisuals?: ConceptVisuals; error?: string }
        | null;
      if (!res.ok) throw new Error(body?.error ?? "Failed to read concept images");
      setVisuals(body?.conceptVisuals);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Read failed");
    } finally {
      setReading(false);
    }
  }, [projectId]);

  const full = images.length >= MAX_CONCEPT_IMAGES;

  return (
    <section className="space-y-4 rounded-lg border border-white/10 bg-panel/40 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">
          Concept images <span className="text-xs font-normal text-slate-500">— optional</span>
        </h2>
        <span className="text-[11px] text-slate-500">
          {images.length} of {MAX_CONCEPT_IMAGES}
        </span>
      </div>
      <p className="text-xs text-slate-400">
        Reference photographs of the setting, wardrobe, lighting or mood. They are read once into a
        written description that the planning agents use — the images themselves are never sent to
        the image generator.
      </p>
      <p className="text-xs text-slate-500">
        The project&apos;s written concept leads and always will. These add detail a sentence carries
        badly — a palette, a room, a particular jacket. Add none and nothing changes: the pipeline
        runs exactly as it does today.
      </p>

      {error ? (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {images.map((name) => (
          <figure key={name} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element -- local file served by our own route */}
            <img
              src={`/api/projects/${projectId}/concept-images?name=${encodeURIComponent(name)}`}
              alt={name}
              className="h-24 w-24 rounded-md border border-white/10 object-cover"
            />
            <button
              type="button"
              onClick={() => void remove(name)}
              disabled={busy}
              aria-label={`Remove ${name}`}
              className="absolute -right-2 -top-2 rounded-full border border-white/20 bg-panel px-2 text-xs text-slate-300 hover:text-red-300"
            >
              ×
            </button>
          </figure>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          disabled={busy || full}
          onChange={(e) => void upload(e.target.files)}
          className="text-xs text-slate-400 file:mr-3 file:rounded-md file:border file:border-white/10 file:bg-panel/60 file:px-3 file:py-1.5 file:text-xs file:text-slate-200"
        />
        <button
          type="button"
          onClick={() => void read()}
          disabled={reading || busy || images.length === 0}
          className="rounded-md border border-white/10 bg-panel/60 px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50"
        >
          {reading ? "Reading…" : "Read images"}
        </button>
      </div>
      {full ? (
        <p className="text-[11px] text-slate-500">
          Limit reached. Remove one before uploading another.
        </p>
      ) : null}

      {visuals ? <VisualsReport visuals={visuals} /> : null}
    </section>
  );
}

function VisualsReport({ visuals }: { visuals: ConceptVisuals }) {
  const rows: [string, string][] = [
    ["Setting", visuals.setting],
    ["Lighting", visuals.lighting],
    ["Mood", visuals.mood],
    ["Subjects", visuals.subjects.join("; ")],
    ["Wardrobe", visuals.wardrobe.join("; ")],
    ["Palette", visuals.palette.join(", ")],
    ["Details", visuals.notableDetails.join("; ")],
  ];
  return (
    <div className="space-y-2 rounded-md border border-white/10 bg-black/20 p-3">
      {!visuals.fromImages ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
          Written from the typed concept, not the images. Set OPENAI_VISION_MODEL to have the
          pictures actually looked at.
        </p>
      ) : null}
      <dl className="space-y-1 text-xs">
        {rows
          .filter(([, value]) => value.trim().length > 0)
          .map(([label, value]) => (
            <div key={label} className="flex gap-2">
              <dt className="w-20 shrink-0 text-slate-500">{label}</dt>
              <dd className="text-slate-300">{value}</dd>
            </div>
          ))}
      </dl>
      {visuals.contradictions.length > 0 ? (
        <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
          <p className="text-[11px] font-semibold text-amber-200">
            The images and the concept disagree
          </p>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-amber-100/90">
            {visuals.contradictions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
