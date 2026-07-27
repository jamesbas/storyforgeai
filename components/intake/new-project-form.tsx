"use client";

import { useState } from "react";
import {
  ASPECT_RATIOS,
  CREATIVE_MODES,
  GENERATION_MODES,
  MAX_SEGMENT_SECONDS,
  MIN_SEGMENT_SECONDS,
  RESOLUTION_PRESETS,
  SEGMENT_SECONDS,
} from "@/lib/types";
import type { CreateProjectInput } from "@/lib/schemas/intake";

export type NewProjectFormProps = {
  onSubmit: (values: CreateProjectInput) => Promise<void> | void;
  submitting?: boolean;
};

export function NewProjectForm({ onSubmit, submitting = false }: NewProjectFormProps) {
  const [concept, setConcept] = useState("");
  const [duration, setDuration] = useState(60);
  const [segmentSeconds, setSegmentSeconds] = useState<number>(SEGMENT_SECONDS);
  const [aspectRatio, setAspectRatio] = useState<(typeof ASPECT_RATIOS)[number]>("16:9");
  const [resolutionPreset, setResolutionPreset] =
    useState<(typeof RESOLUTION_PRESETS)[number]>("standard");
  const [style, setStyle] = useState("cinematic");
  const [tone, setTone] = useState("inspirational");
  const [audience, setAudience] = useState("");
  const [creativeMode, setCreativeMode] = useState<(typeof CREATIVE_MODES)[number]>("film_short");
  const [generationMode, setGenerationMode] =
    useState<(typeof GENERATION_MODES)[number]>("storyboard_only");
  const [narrationRequired, setNarration] = useState(false);
  const [dialogueRequired, setDialogue] = useState(false);
  const [musicRequired, setMusic] = useState(false);
  const [sfxRequired, setSfx] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    await onSubmit({
      concept,
      requestedDurationSeconds: Number(duration),
      segmentSeconds: Number(segmentSeconds),
      aspectRatio,
      resolutionPreset,
      style,
      tone,
      audience: audience || undefined,
      creativeMode,
      generationMode,
      narrationRequired,
      dialogueRequired,
      musicRequired,
      sfxRequired,
    });
  }

  const field = "rounded-md border border-white/10 bg-canvas px-3 py-2 text-sm outline-none focus:border-accent";
  const label = "block text-xs font-medium uppercase tracking-wide text-slate-400";

  return (
    <form onSubmit={handleSubmit} className="space-y-5" aria-label="New project">
      <div>
        <label htmlFor="concept" className={label}>
          Concept
        </label>
        <textarea
          id="concept"
          name="concept"
          required
          value={concept}
          onChange={(e) => setConcept(e.target.value)}
          rows={4}
          placeholder="A short film about a lighthouse keeper who befriends a storm."
          className={`mt-1 w-full ${field}`}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="duration" className={label}>
            Duration (seconds)
          </label>
          <input
            id="duration"
            name="requestedDurationSeconds"
            type="number"
            min={1}
            max={3600}
            required
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className={`mt-1 w-full ${field}`}
          />
        </div>
        <div>
          <label htmlFor="segmentSeconds" className={label}>
            Clip length (seconds)
          </label>
          <input
            id="segmentSeconds"
            name="segmentSeconds"
            type="number"
            min={MIN_SEGMENT_SECONDS}
            max={MAX_SEGMENT_SECONDS}
            required
            value={segmentSeconds}
            onChange={(e) => setSegmentSeconds(Number(e.target.value))}
            className={`mt-1 w-full ${field}`}
          />
          <p className="mt-1 text-[11px] text-slate-500">
            {MIN_SEGMENT_SECONDS}–{MAX_SEGMENT_SECONDS}s per clip.{" "}
            {segmentSeconds >= MIN_SEGMENT_SECONDS && segmentSeconds <= MAX_SEGMENT_SECONDS && duration > 0
              ? `${Math.ceil(duration / segmentSeconds)} scenes to generate.`
              : ""}
          </p>
        </div>
        <div>
          <label htmlFor="aspectRatio" className={label}>
            Aspect ratio
          </label>
          <select
            id="aspectRatio"
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value as (typeof ASPECT_RATIOS)[number])}
            className={`mt-1 w-full ${field}`}
          >
            {ASPECT_RATIOS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="style" className={label}>
            Style
          </label>
          <input
            id="style"
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            className={`mt-1 w-full ${field}`}
          />
        </div>
        <div>
          <label htmlFor="tone" className={label}>
            Tone
          </label>
          <input
            id="tone"
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            className={`mt-1 w-full ${field}`}
          />
        </div>
        <div>
          <label htmlFor="audience" className={label}>
            Audience
          </label>
          <input
            id="audience"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            className={`mt-1 w-full ${field}`}
          />
        </div>
        <div>
          <label htmlFor="resolutionPreset" className={label}>
            Resolution
          </label>
          <select
            id="resolutionPreset"
            value={resolutionPreset}
            onChange={(e) =>
              setResolutionPreset(e.target.value as (typeof RESOLUTION_PRESETS)[number])
            }
            className={`mt-1 w-full ${field}`}
          >
            {RESOLUTION_PRESETS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="creativeMode" className={label}>
            Creative mode
          </label>
          <select
            id="creativeMode"
            value={creativeMode}
            onChange={(e) => setCreativeMode(e.target.value as (typeof CREATIVE_MODES)[number])}
            className={`mt-1 w-full ${field}`}
          >
            {CREATIVE_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="generationMode" className={label}>
            Generation mode
          </label>
          <select
            id="generationMode"
            value={generationMode}
            onChange={(e) =>
              setGenerationMode(e.target.value as (typeof GENERATION_MODES)[number])
            }
            className={`mt-1 w-full ${field}`}
          >
            {GENERATION_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={narrationRequired} onChange={(e) => setNarration(e.target.checked)} />
          Narration
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={dialogueRequired} onChange={(e) => setDialogue(e.target.checked)} />
          Dialogue
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={musicRequired} onChange={(e) => setMusic(e.target.checked)} />
          Music
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={sfxRequired} onChange={(e) => setSfx(e.target.checked)} />
          SFX
        </label>
      </fieldset>

      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {submitting ? "Creating…" : "Create Storyboard"}
      </button>
    </form>
  );
}
