"use client";

import { useCallback, useRef, useState } from "react";
import type { ConceptFidelityReport, ConceptVisuals } from "@/lib/schemas/agents";
import type { ConceptImage, ConceptImageKind } from "@/lib/schemas/project";

const MAX_CONCEPT_IMAGES = 6;

/**
 * Concept images for a project, split by where they came from.
 *
 * References are pictures from outside the project whose look we want; they are
 * read once into text that the planning agents use. Renders are frames this
 * pipeline produced; they are only ever compared against the concept, and
 * nothing written about them reaches a prompt.
 *
 * The two are kept visibly apart because the difference is invisible in the
 * pixels and expensive to get wrong: a render described back into the Visual
 * Bible teaches the next generation to repeat whatever the last one failed to
 * deliver.
 */
export function ConceptImages({
  projectId,
  initial,
  initialVisuals,
  initialFidelity,
}: {
  projectId: string;
  initial: readonly ConceptImage[];
  initialVisuals?: ConceptVisuals;
  initialFidelity?: ConceptFidelityReport;
}) {
  const [images, setImages] = useState<ConceptImage[]>([...initial]);
  const [visuals, setVisuals] = useState<ConceptVisuals | undefined>(initialVisuals);
  const [fidelity, setFidelity] = useState<ConceptFidelityReport | undefined>(initialFidelity);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<ConceptImageKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const referenceInput = useRef<HTMLInputElement>(null);
  const renderInput = useRef<HTMLInputElement>(null);

  const upload = useCallback(
    async (files: FileList | null, kind: ConceptImageKind) => {
      if (!files?.length) return;
      setBusy(true);
      setError(null);
      try {
        for (const file of Array.from(files)) {
          const form = new FormData();
          form.append("file", file);
          form.append("kind", kind);
          const res = await fetch(`/api/projects/${projectId}/concept-images`, {
            method: "POST",
            body: form,
          });
          const body = (await res.json().catch(() => null)) as
            | { conceptImages?: ConceptImage[]; error?: string }
            | null;
          if (!res.ok) throw new Error(body?.error ?? `Failed to upload ${file.name}`);
          setImages(body?.conceptImages ?? []);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setBusy(false);
        // Uploading the same file twice is a legitimate retry, so the inputs are
        // cleared after every attempt or the change event never fires again.
        if (referenceInput.current) referenceInput.current.value = "";
        if (renderInput.current) renderInput.current.value = "";
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
          | { conceptImages?: ConceptImage[]; error?: string }
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

  const run = useCallback(
    async (kind: ConceptImageKind) => {
      setRunning(kind);
      setError(null);
      const path = kind === "reference" ? "read-concept-images" : "concept-fidelity";
      try {
        const res = await fetch(`/api/projects/${projectId}/${path}`, { method: "POST" });
        const body = (await res.json().catch(() => null)) as
          | { conceptVisuals?: ConceptVisuals; conceptFidelity?: ConceptFidelityReport; error?: string }
          | null;
        if (!res.ok) throw new Error(body?.error ?? "Failed");
        if (kind === "reference") setVisuals(body?.conceptVisuals);
        else setFidelity(body?.conceptFidelity);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed");
      } finally {
        setRunning(null);
      }
    },
    [projectId],
  );

  const references = images.filter((image) => image.kind === "reference");
  const renders = images.filter((image) => image.kind === "render");
  const full = images.length >= MAX_CONCEPT_IMAGES;

  return (
    <section className="space-y-5 rounded-lg border border-white/10 bg-panel/40 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">
          Concept images <span className="text-xs font-normal text-slate-500">— optional</span>
        </h2>
        <span className="text-[11px] text-slate-500">
          {images.length} of {MAX_CONCEPT_IMAGES}
        </span>
      </div>
      <p className="text-xs text-slate-500">
        The project&apos;s written concept leads and always will. Add none and nothing changes: the
        pipeline runs exactly as it does today.
      </p>

      {error ? (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      <Group
        title="Reference images"
        blurb="Pictures from outside this project whose look you want — a set, a palette, a jacket, a
          quality of light. Read once into a written description the planning agents use. The images
          themselves never reach the image generator."
        action="Read references"
        kind="reference"
        images={references}
        projectId={projectId}
        inputRef={referenceInput}
        busy={busy}
        full={full}
        running={running}
        onUpload={upload}
        onRemove={remove}
        onRun={run}
      />
      {visuals ? <VisualsReport visuals={visuals} /> : null}

      <Group
        title="Concept fidelity check"
        blurb="Frames this project generated, compared against what you originally typed. This is not
          the QC agent: QC grades a render against its scene card, so it passes a faithful render of
          a card that already lost the plot. Only the concept still holds what you asked for.
          Nothing written about these frames is ever fed back into the pipeline."
        action="Check against concept"
        kind="render"
        images={renders}
        projectId={projectId}
        inputRef={renderInput}
        busy={busy}
        full={full}
        running={running}
        onUpload={upload}
        onRemove={remove}
        onRun={run}
      />
      {fidelity ? <FidelityReport report={fidelity} /> : null}

      {full ? (
        <p className="text-[11px] text-slate-500">
          Limit reached across both groups. Remove one before uploading another.
        </p>
      ) : null}
    </section>
  );
}

function Group({
  title,
  blurb,
  action,
  kind,
  images,
  projectId,
  inputRef,
  busy,
  full,
  running,
  onUpload,
  onRemove,
  onRun,
}: {
  title: string;
  blurb: string;
  action: string;
  kind: ConceptImageKind;
  images: readonly ConceptImage[];
  projectId: string;
  inputRef: React.RefObject<HTMLInputElement>;
  busy: boolean;
  full: boolean;
  running: ConceptImageKind | null;
  onUpload: (files: FileList | null, kind: ConceptImageKind) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
  onRun: (kind: ConceptImageKind) => Promise<void>;
}) {
  return (
    <div className="space-y-3 rounded-md border border-white/5 bg-black/10 p-3">
      <h3 className="text-sm font-medium text-slate-200">{title}</h3>
      <p className="text-xs text-slate-400">{blurb}</p>

      {images.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          {images.map((image) => (
            <figure key={image.name} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element -- local file served by our own route */}
              <img
                src={`/api/projects/${projectId}/concept-images?name=${encodeURIComponent(image.name)}`}
                alt={image.name}
                className="h-24 w-24 rounded-md border border-white/10 object-cover"
              />
              <button
                type="button"
                onClick={() => void onRemove(image.name)}
                disabled={busy}
                aria-label={`Remove ${image.name}`}
                className="absolute -right-2 -top-2 rounded-full border border-white/20 bg-panel px-2 text-xs text-slate-300 hover:text-red-300"
              >
                ×
              </button>
            </figure>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          disabled={busy || full}
          aria-label={`Add ${title.toLowerCase()}`}
          onChange={(e) => void onUpload(e.target.files, kind)}
          className="text-xs text-slate-400 file:mr-3 file:rounded-md file:border file:border-white/10 file:bg-panel/60 file:px-3 file:py-1.5 file:text-xs file:text-slate-200"
        />
        <button
          type="button"
          onClick={() => void onRun(kind)}
          disabled={running !== null || busy || images.length === 0}
          className="rounded-md border border-white/10 bg-panel/60 px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50"
        >
          {running === kind ? "Working…" : action}
        </button>
      </div>
    </div>
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
            The references and the concept disagree
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

function FidelityReport({ report }: { report: ConceptFidelityReport }) {
  if (report.images.length === 0) {
    return (
      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
        Nothing was looked at, so this is not a clean bill of health. Set OPENAI_VISION_MODEL and
        run it again.
      </p>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-white/10 bg-black/20 p-3">
      <p className="text-[11px] text-slate-500">
        Checked {report.images.length} frame{report.images.length === 1 ? "" : "s"}:{" "}
        {report.images.join(", ")}
      </p>
      {report.findings.length === 0 ? (
        <p className="text-xs text-slate-300">No departures from the concept found.</p>
      ) : (
        <ul className="space-y-2">
          {report.findings.map((finding, index) => (
            <li
              key={`${finding.image}-${index}`}
              className="space-y-0.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px]"
            >
              <p className="font-semibold text-amber-200">{finding.image}</p>
              <p className="text-amber-100/90">
                <span className="text-slate-400">Concept: </span>
                {finding.concept}
              </p>
              <p className="text-amber-100/90">
                <span className="text-slate-400">Frame: </span>
                {finding.shows}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
