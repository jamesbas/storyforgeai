"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ASPECT_RATIOS,
  CREATIVE_MODES,
  GENERATION_MODES,
  MAX_SEGMENT_SECONDS,
  MIN_SEGMENT_SECONDS,
  RESOLUTION_PRESETS,
  SEGMENT_SECONDS,
} from "@/lib/types";
import {
  AUDIENCE_PRESETS,
  CUSTOM_PRESET_VALUE,
  STYLE_PRESETS,
  TONE_PRESETS,
  type PresetOption,
} from "@/lib/presets";
import type { CreateProjectInput } from "@/lib/schemas/intake";
import type { Character } from "@/lib/schemas/character";

export type NewProjectFormProps = {
  /**
   * `references` are uploaded after the project exists — the upload route is
   * keyed by project id, so there is nowhere to put them until then.
   */
  onSubmit: (values: CreateProjectInput, references: File[]) => Promise<void> | void;
  submitting?: boolean;
};

export function NewProjectForm({ onSubmit, submitting = false }: NewProjectFormProps) {
  const [concept, setConcept] = useState("");
  const [references, setReferences] = useState<File[]>([]);
  const [duration, setDuration] = useState(60);
  const [segmentSeconds, setSegmentSeconds] = useState<number>(SEGMENT_SECONDS);
  const [aspectRatio, setAspectRatio] = useState<(typeof ASPECT_RATIOS)[number]>("16:9");
  const [resolutionPreset, setResolutionPreset] =
    useState<(typeof RESOLUTION_PRESETS)[number]>("standard");
  const [style, setStyle] = useState("cinematic");
  const [tone, setTone] = useState("inspirational");
  const [audience, setAudience] = useState("general audience");
  const [creativeMode, setCreativeMode] = useState<(typeof CREATIVE_MODES)[number]>("film_short");
  const [generationMode, setGenerationMode] =
    useState<(typeof GENERATION_MODES)[number]>("video_segments");
  const [narrationRequired, setNarration] = useState(false);
  const [dialogueRequired, setDialogue] = useState(false);
  const [musicRequired, setMusic] = useState(false);
  const [sfxRequired, setSfx] = useState(false);
  const [useCharacterLibrary, setUseCharacterLibrary] = useState(false);
  const [characterIds, setCharacterIds] = useState<string[]>([]);
  const [characterWardrobe, setCharacterWardrobe] = useState<Record<string, string>>({});
  const [characters, setCharacters] = useState<Character[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/characters");
        if (res.ok) setCharacters(((await res.json()) as { characters: Character[] }).characters);
      } catch {
        // non-fatal: the library is optional, the form still works without it
      }
    })();
  }, []);

  const toggleCharacter = useCallback((id: string) => {
    setCharacterIds((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    await onSubmit(
      {
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
        useCharacterLibrary,
        characterIds: useCharacterLibrary ? characterIds : [],
        // Only send wardrobe for characters actually in this project.
        characterWardrobe: useCharacterLibrary
          ? Object.fromEntries(
              characterIds
                .map((id) => [id, characterWardrobe[id]?.trim() ?? ""])
                .filter(([, value]) => value !== ""),
            )
          : {},
      },
      references,
    );
  }

  const field = "rounded-md border border-white/10 bg-canvas px-3 py-2 text-sm outline-none focus:border-accent";
  const label = "block text-xs font-medium uppercase tracking-wide text-slate-400";

  /**
   * Preset dropdown with a free-text escape hatch.
   *
   * These fields are interpolated verbatim into image and video prompts, so any
   * wording is valid — the presets exist to make the useful values one click
   * away, not to restrict them.
   */
  const presetPicker = (
    id: string,
    labelText: string,
    presets: readonly PresetOption[],
    value: string,
    onChange: (next: string) => void,
  ) => {
    const isPreset = presets.some((p) => p.value === value);
    return (
      <div>
        <label htmlFor={id} className={label}>
          {labelText}
        </label>
        <select
          id={id}
          value={isPreset ? value : CUSTOM_PRESET_VALUE}
          onChange={(e) => onChange(e.target.value === CUSTOM_PRESET_VALUE ? "" : e.target.value)}
          className={`mt-1 w-full ${field}`}
        >
          {presets.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
          <option value={CUSTOM_PRESET_VALUE}>Custom…</option>
        </select>
        {!isPreset && (
          <input
            aria-label={`${labelText} (custom)`}
            required
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={`Describe the ${labelText.toLowerCase()} in your own words`}
            className={`mt-2 w-full ${field}`}
          />
        )}
      </div>
    );
  };

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

      <div>
        <label htmlFor="references" className={label}>
          Reference images <span className="normal-case tracking-normal">— optional</span>
        </label>
        <p className="mt-1 text-xs text-slate-500">
          Pictures whose look you want, from outside this project. They are read into a written
          description the planning agents use; the concept above still leads. Add none and nothing
          changes.
        </p>
        <input
          id="references"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          onChange={(e) => setReferences(Array.from(e.target.files ?? []).slice(0, 6))}
          className={`mt-2 text-xs text-slate-400 file:mr-3 file:rounded-md file:border file:border-white/10 file:bg-panel/60 file:px-3 file:py-1.5 file:text-xs file:text-slate-200`}
        />
        {references.length > 0 ? (
          <p className="mt-1 text-xs text-slate-400">
            {references.length} image{references.length === 1 ? "" : "s"} will be uploaded once the
            project is created.
          </p>
        ) : null}
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
        {presetPicker("style", "Style", STYLE_PRESETS, style, setStyle)}
        {presetPicker("tone", "Tone", TONE_PRESETS, tone, setTone)}
        {presetPicker("audience", "Audience", AUDIENCE_PRESETS, audience, setAudience)}
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

      {/*
        `min-w-0` is load-bearing: a <fieldset> defaults to `min-inline-size:
        min-content`, so without it the element refuses to shrink and a long
        character description drags the whole page wider than the viewport,
        pushing the sidebar off screen.
      */}
      <fieldset className="min-w-0 space-y-3 rounded-md border border-white/10 bg-canvas/40 p-3">
        <legend className="px-1 text-xs font-medium uppercase tracking-wide text-slate-400">
          Characters
        </legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={useCharacterLibrary}
            onChange={(e) => setUseCharacterLibrary(e.target.checked)}
          />
          Use saved character descriptions
        </label>
        <p className="text-[11px] text-slate-500">
          Locks the selected characters&apos; appearance into the visual bible, the scene cards, and
          every image and video prompt, so the same person looks the same in every clip. Wardrobe is
          set per project — the same character can wear something different in the next story.
        </p>

        {useCharacterLibrary ? (
          characters.length === 0 ? (
            <p className="text-xs text-slate-400">
              No characters saved yet.{" "}
              <Link href="/settings" className="text-accent underline underline-offset-2">
                Add one in Settings
              </Link>
              .
            </p>
          ) : (
            <ul className="space-y-2">
              {characters.map((character) => (
                <li key={character.id} className="min-w-0">
                  <label className="flex min-w-0 items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 flex-none"
                      checked={characterIds.includes(character.id)}
                      onChange={() => toggleCharacter(character.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{character.name}</span>
                      {/*
                        Clamped rather than truncated: these descriptions run to
                        several hundred words, and `truncate` sets
                        `white-space: nowrap`, which makes the min-content width
                        the full length of the text. No `block` here — the
                        line-clamp utility supplies its own `display`, and a
                        display utility alongside it wins and cancels the clamp.
                      */}
                      <span
                        className="line-clamp-2 break-words text-xs text-slate-500"
                        title={character.description}
                      >
                        {character.description}
                      </span>
                    </span>
                  </label>
                  {characterIds.includes(character.id) ? (
                    <div className="ml-6 mt-1">
                      <input
                        aria-label={`Wardrobe for ${character.name}`}
                        maxLength={500}
                        value={characterWardrobe[character.id] ?? character.wardrobe ?? ""}
                        onChange={(e) =>
                          setCharacterWardrobe((current) => ({
                            ...current,
                            [character.id]: e.target.value,
                          }))
                        }
                        placeholder={`What ${character.name} wears in this story — e.g. a fitted white tank top, black tailored trousers, black ankle boots`}
                        className={`w-full ${field}`}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </fieldset>

      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-accent-solid px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {submitting ? "Creating…" : "Create Storyboard"}
      </button>
    </form>
  );
}
