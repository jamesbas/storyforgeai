"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Character } from "@/lib/schemas/character";

type CharactersResponse = { characters: Character[] };

const EMPTY_DRAFT = { name: "", description: "", negativePrompt: "" };

/**
 * The global character library.
 *
 * Characters are deliberately not scoped to a project: the value of a saved
 * description is that the same person can appear across unrelated stories and
 * still look the same. Projects opt in per-project on the New Project form.
 */
export function CharacterLibrary() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/characters");
      if (!res.ok) throw new Error("Failed to load the character library");
      setCharacters(((await res.json()) as CharactersResponse).characters);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the character library");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const request = useCallback(
    async (url: string, init: RequestInit, failure: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(url, init);
        if (!res.ok) {
          // A server-side crash returns an HTML error page, not JSON, so the
          // parse fails and the message would otherwise be a bare "failed to
          // save" with nothing to act on. Surfacing the status separates a
          // rejected payload (400) from a broken server (500).
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `${failure} (HTTP ${res.status} ${res.statusText})`);
        }
        await load();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : failure);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const body = JSON.stringify({
        name: draft.name,
        description: draft.description,
        negativePrompt: draft.negativePrompt || undefined,
      });
      const ok = editingId
        ? await request(
            `/api/characters/${editingId}`,
            { method: "PATCH", headers: { "content-type": "application/json" }, body },
            "Failed to save the character",
          )
        : await request(
            "/api/characters",
            { method: "POST", headers: { "content-type": "application/json" }, body },
            "Failed to create the character",
          );
      if (ok) {
        setDraft(EMPTY_DRAFT);
        setEditingId(null);
      }
    },
    [draft, editingId, request],
  );

  const uploadImage = useCallback(
    async (id: string, file: File) => {
      const body = new FormData();
      body.append("file", file);
      await request(
        `/api/characters/${id}/image`,
        { method: "POST", body },
        "Failed to upload the reference image",
      );
    },
    [request],
  );

  const field =
    "w-full rounded-md border border-white/10 bg-canvas px-3 py-2 text-sm outline-none focus:border-accent";
  const label = "block text-xs font-medium uppercase tracking-wide text-slate-400";

  /**
   * Live length readout.
   *
   * `maxLength` makes the browser silently drop the overflow when a longer
   * prompt is pasted — no error, no visual cue, and the tail is simply gone.
   * Showing the count (and flagging it once the cap is reached) is what makes
   * that failure visible.
   */
  const counter = (value: string, max: number) => (
    <span className={value.length >= max ? "text-amber-400" : "text-slate-500"}>
      {value.length} / {max}
      {value.length >= max ? " — limit reached, extra text is discarded" : ""}
    </span>
  );

  return (
    <section className="space-y-4 rounded-lg border border-white/10 bg-panel/40 p-4">
      <div>
        <h2 className="font-semibold">Character library</h2>
        <p className="mt-1 text-xs text-slate-500">
          Describe a character once and reuse them across projects. When a project opts in, these
          descriptions are locked into the visual bible, the scene cards, and every image and video
          prompt — which is what keeps a face from changing between clips.
        </p>
      </div>

      {error ? (
        <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      <form onSubmit={submit} className="space-y-3 rounded-md border border-white/10 bg-canvas/40 p-3">
        <div>
          <label htmlFor="character-name" className={label}>
            Name
          </label>
          <input
            id="character-name"
            required
            maxLength={80}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="Elena"
            className={`mt-1 ${field}`}
          />
        </div>
        <div>
          <label htmlFor="character-description" className={label}>
            Physical description
          </label>
          <textarea
            id="character-description"
            required
            rows={4}
            maxLength={2000}
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            placeholder="A woman in her mid-thirties, tall and lean, with shoulder-length dark curly hair, warm brown eyes, olive skin and a small scar above her left eyebrow."
            className={`mt-1 ${field}`}
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Write it as prompt-ready prose, not a biography — this text is concatenated verbatim into
            image and video prompts. Age, build, hair, face, skin and distinguishing features carry
            the most weight. {counter(draft.description, 2000)}
          </p>
        </div>
        <div>
          <label htmlFor="character-negative" className={label}>
            Negative prompt terms (optional)
          </label>
          <textarea
            id="character-negative"
            rows={3}
            maxLength={1000}
            value={draft.negativePrompt}
            onChange={(e) => setDraft((d) => ({ ...d, negativePrompt: e.target.value }))}
            placeholder="no glasses, no beard, not elderly"
            className={`mt-1 ${field}`}
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Traits to actively suppress for this character. Appended to the negative prompt of every
            scene they appear in. {counter(draft.negativePrompt, 1000)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {editingId ? "Save character" : "Add character"}
          </button>
          {editingId ? (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setDraft(EMPTY_DRAFT);
              }}
              className="text-sm text-slate-400 hover:text-white"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </form>

      <ul className="space-y-3">
        {loaded && characters.length === 0 ? (
          <li className="text-sm text-slate-500">No characters saved yet.</li>
        ) : null}
        {characters.map((character) => (
          <li
            key={character.id}
            className="flex gap-3 rounded-md border border-white/10 bg-canvas/40 p-3"
          >
            {character.referenceImage ? (
              // eslint-disable-next-line @next/next/no-img-element -- served from a local API route, not an optimizable static asset
              <img
                src={`/api/characters/${character.id}/image?v=${encodeURIComponent(character.updatedAt)}`}
                alt={`Reference for ${character.name}`}
                className="h-20 w-20 flex-none rounded-md object-cover"
              />
            ) : (
              <div className="flex h-20 w-20 flex-none items-center justify-center rounded-md border border-dashed border-white/15 text-[10px] text-slate-500">
                No image
              </div>
            )}

            <div className="min-w-0 flex-1">
              <p className="font-medium">{character.name}</p>
              {/*
                Prompt-ready descriptions run to several hundred words, so the
                list shows a preview and Edit reveals the full text. Without a
                clamp a handful of characters buries every control below a wall
                of prose. No `block`/`text-sm` display utility alongside the
                clamp — line-clamp supplies its own `display`.
              */}
              <p
                className="mt-1 line-clamp-3 break-words text-sm text-slate-300"
                title={character.description}
              >
                {character.description}
              </p>
              {character.negativePrompt ? (
                <p
                  className="mt-1 line-clamp-2 break-words text-xs text-slate-500"
                  title={character.negativePrompt}
                >
                  Avoid: {character.negativePrompt}
                </p>
              ) : null}

              <div className="mt-2 flex flex-wrap gap-3 text-xs">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditingId(character.id);
                    setDraft({
                      name: character.name,
                      description: character.description,
                      negativePrompt: character.negativePrompt ?? "",
                    });
                  }}
                  className="text-accent hover:underline disabled:opacity-50"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileInputs.current[character.id]?.click()}
                  className="text-accent hover:underline disabled:opacity-50"
                >
                  {character.referenceImage ? "Replace image" : "Add reference image"}
                </button>
                {character.referenceImage ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void request(
                        `/api/characters/${character.id}/image`,
                        { method: "DELETE" },
                        "Failed to remove the reference image",
                      )
                    }
                    className="text-slate-400 hover:text-white disabled:opacity-50"
                  >
                    Remove image
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`Delete "${character.name}" from the library?`)) return;
                    void request(
                      `/api/characters/${character.id}`,
                      { method: "DELETE" },
                      "Failed to delete the character",
                    );
                  }}
                  className="text-red-400 hover:underline disabled:opacity-50"
                >
                  Delete
                </button>
              </div>

              <input
                ref={(el) => {
                  fileInputs.current[character.id] = el;
                }}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void uploadImage(character.id, file);
                }}
              />
            </div>
          </li>
        ))}
      </ul>

      <p className="text-[11px] text-slate-500">
        Reference images are stored locally alongside your projects and are sent to the generation
        backend as reference input when it renders the start and end frames, which is what carries a
        face across scenes. This needs an image model that accepts reference images — Flux 2 Klein
        and Qwen Image Edit both do. The video clip inherits the identity from those two frames, so
        nothing extra is needed there.
      </p>
    </section>
  );
}
