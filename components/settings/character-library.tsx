"use client";

import { useCallback, useRef, useState } from "react";
import {
  MAX_FACE_SWAP_PROMPT,
  MAX_FACE_SWAP_STEPS,
  MIN_FACE_SWAP_STEPS,
  MAX_REFERENCE_IMAGES,
  faceSwapPromptOf,
  referenceImagesOf,
} from "@/lib/schemas/character";
import {
  DEFAULT_FACE_SWAP_METHOD,
  DEFAULT_FACE_SWAP_SUBJECT,
  FACE_SWAP_METHODS,
  FACE_SWAP_STEP_HINT,
  FACE_SWAP_SUBJECTS,
  faceSwapPromptFor,
  isDefaultFaceSwapPrompt,
  type FaceSwapMethod,
  type FaceSwapSubject,
} from "@/lib/wangp/face-swap-preset";
import { useLoadEffect } from "@/components/shared/use-load-effect";
import type { Character } from "@/lib/schemas/character";

type CharactersResponse = { characters: Character[] };

/** What each engine is good at, in the terms someone choosing has to decide on. */
const FACE_SWAP_METHOD_CHOICES: { value: FaceSwapMethod; title: string; detail: string }[] = [
  {
    value: "krea",
    title: "Krea Identity Edit (Turbo)",
    detail:
      "A model built for identity transfer, run bare with no LoRAs. Tests better on likeness and is the recommended choice.",
  },
  {
    value: "qwen",
    title: "Qwen Image Edit + head LoRA",
    detail:
      "The original recipe: a head-swap LoRA on a 4-step Lightning schedule. Worth trying where Krea drifts on a difficult face.",
  },
];

const EMPTY_DRAFT = {
  name: "",
  description: "",
  facialDescription: "",
  wardrobe: "",
  negativePrompt: "",
  faceSwap: false,
  faceSwapPromptKrea: "",
  faceSwapPromptQwen: "",
  faceSwapStepsKrea: "",
  faceSwapStepsQwen: "",
  faceSwapMethod: DEFAULT_FACE_SWAP_METHOD as FaceSwapMethod,
  faceSwapSubject: DEFAULT_FACE_SWAP_SUBJECT as FaceSwapSubject,
};

type Draft = typeof EMPTY_DRAFT;

const STEPS_FIELD = {
  krea: "faceSwapStepsKrea",
  qwen: "faceSwapStepsQwen",
} as const satisfies Record<FaceSwapMethod, keyof Draft>;

const PROMPT_FIELD = {
  krea: "faceSwapPromptKrea",
  qwen: "faceSwapPromptQwen",
} as const satisfies Record<FaceSwapMethod, keyof Draft>;

/**
 * Re-seed whichever boxes are still showing a default.
 *
 * Changing the subject is a statement about who the character is, so it has to
 * reach the wording — otherwise picking "man" leaves two prompts talking about
 * a woman. It must not reach wording someone typed themselves, which is the
 * only thing separating a helpful default from losing their work.
 */
function withSubject(draft: Draft, subject: FaceSwapSubject): Draft {
  const next = { ...draft, faceSwapSubject: subject };
  for (const method of FACE_SWAP_METHODS) {
    const field = PROMPT_FIELD[method];
    if (isDefaultFaceSwapPrompt(draft[field])) next[field] = faceSwapPromptFor(method, subject);
  }
  return next;
}

/** Both boxes filled from the defaults, for a character that has none yet. */
function seededPrompts(draft: Draft): Draft {
  const next = { ...draft };
  for (const method of FACE_SWAP_METHODS) {
    const field = PROMPT_FIELD[method];
    if (!next[field].trim()) next[field] = faceSwapPromptFor(method, draft.faceSwapSubject);
  }
  return next;
}

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

  const load = useCallback(async (isCurrent: () => boolean = () => true) => {
    try {
      const res = await fetch("/api/characters");
      if (!res.ok) throw new Error("Failed to load the character library");
      const data = (await res.json()) as CharactersResponse;
      if (isCurrent()) setCharacters(data.characters);
    } catch (e) {
      if (isCurrent()) {
        setError(e instanceof Error ? e.message : "Failed to load the character library");
      }
    } finally {
      if (isCurrent()) setLoaded(true);
    }
  }, []);

  useLoadEffect(load);

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
        facialDescription: draft.facialDescription || undefined,
        wardrobe: draft.wardrobe || undefined,
        negativePrompt: draft.negativePrompt || undefined,
        faceSwap: draft.faceSwap,
        faceSwapPrompts: {
          krea: draft.faceSwapPromptKrea || undefined,
          qwen: draft.faceSwapPromptQwen || undefined,
        },
        faceSwapSteps: {
          krea: Number(draft.faceSwapStepsKrea) || undefined,
          qwen: Number(draft.faceSwapStepsQwen) || undefined,
        },
        faceSwapMethod: draft.faceSwapMethod,
        faceSwapSubject: draft.faceSwapSubject,
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
          <label htmlFor="character-facial" className={label}>
            Facial description (optional)
          </label>
          <textarea
            id="character-facial"
            rows={3}
            maxLength={1000}
            value={draft.facialDescription}
            onChange={(e) => setDraft((d) => ({ ...d, facialDescription: e.target.value }))}
            placeholder="Soft oval face with a gentle jawline, warm brown eyes, a straight nose and high cheekbones."
            className={`mt-1 ${field}`}
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Put face-specific detail here rather than above, and this text is{" "}
            <strong>withheld from image and video prompts once a reference image exists</strong>. A
            written face and a photograph are competing instructions, and the text tends to win —
            which is backwards when you supplied a photo precisely to fix the likeness. Planning
            agents still see it. {counter(draft.facialDescription, 1000)}
          </p>
        </div>
        <div>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={draft.faceSwap}
              onChange={(e) =>
                setDraft((d) =>
                  // Seed both boxes so the wording can be edited rather than
                  // written from nothing. Ticking is when it first matters.
                  e.target.checked
                    ? seededPrompts({ ...d, faceSwap: true })
                    : { ...d, faceSwap: false },
                )
              }
              className="mt-1"
            />
            <span>
              <span className={label}>Face swap generated frames</span>
              <span className="mt-1 block text-[11px] text-slate-500">
                After each keyframe renders, run a dedicated pass that replaces the head with the one
                in this character&apos;s first reference image. Needs a reference image. Where two
                characters in a frame both have this on, one pass runs for each. Adds a short render
                per keyframe per character.
              </span>
            </span>
          </label>
        </div>
        {draft.faceSwap ? (
          <fieldset data-testid="face-swap-method">
            <legend className={label}>Face-swap method</legend>
            <div className="mt-1 space-y-2">
              {FACE_SWAP_METHOD_CHOICES.map((choice) => (
                <label key={choice.value} className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="face-swap-method"
                    value={choice.value}
                    checked={draft.faceSwapMethod === choice.value}
                    onChange={() => setDraft((d) => ({ ...d, faceSwapMethod: choice.value }))}
                    className="mt-1"
                  />
                  <span>
                    <span className="text-xs text-slate-200">{choice.title}</span>
                    <span className="mt-1 block text-[11px] text-slate-500">{choice.detail}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              Each engine keeps its own prompt below, so switching back and forth costs nothing and
              neither wording is lost. If the chosen model is not installed in WanGP the swap is
              skipped rather than run on the other one, since the two produce visibly different
              faces.
            </p>
          </fieldset>
        ) : null}
        {draft.faceSwap ? (
          <div>
            <label htmlFor="character-face-swap-subject" className={label}>
              Refer to this character as
            </label>
            <select
              id="character-face-swap-subject"
              value={draft.faceSwapSubject}
              onChange={(e) => setDraft((d) => withSubject(d, e.target.value as FaceSwapSubject))}
              className={`mt-1 ${field}`}
            >
              {FACE_SWAP_SUBJECTS.map((subject) => (
                <option key={subject} value={subject}>
                  the {subject}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-500">
              Both engines have to name the person they are editing, and neither can be told
              &ldquo;the character&rdquo;. This only rewrites the prompts below while they are still
              the default wording — once you have edited one, it is left alone.
            </p>
          </div>
        ) : null}
        {draft.faceSwap
          ? FACE_SWAP_METHOD_CHOICES.map((choice) => {
              const fieldName = PROMPT_FIELD[choice.value];
              const value = draft[fieldName];
              const fallback = faceSwapPromptFor(choice.value, draft.faceSwapSubject);
              const active = draft.faceSwapMethod === choice.value;
              return (
                <div key={choice.value}>
                  <div className="flex items-baseline justify-between gap-3">
                    <label htmlFor={`character-face-swap-prompt-${choice.value}`} className={label}>
                      {choice.title} prompt{" "}
                      {active ? (
                        <span className="text-accent" data-testid={`prompt-active-${choice.value}`}>
                          — in use
                        </span>
                      ) : null}
                    </label>
                    <button
                      type="button"
                      onClick={() => setDraft((d) => ({ ...d, [fieldName]: fallback }))}
                      disabled={value === fallback}
                      className="text-[11px] text-accent underline underline-offset-2 disabled:no-underline disabled:opacity-40"
                    >
                      Reset to default
                    </button>
                  </div>
                  <textarea
                    id={`character-face-swap-prompt-${choice.value}`}
                    data-testid={`face-swap-prompt-${choice.value}`}
                    rows={choice.value === "krea" ? 4 : 5}
                    maxLength={MAX_FACE_SWAP_PROMPT}
                    value={value}
                    onChange={(e) => setDraft((d) => ({ ...d, [fieldName]: e.target.value }))}
                    className={`mt-1 w-full ${field}`}
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    {choice.value === "krea" ? (
                      <>
                        Krea wants a short edit instruction. It reads the rendered frame as{" "}
                        <strong>the first image</strong> and this character&apos;s reference photo as{" "}
                        <strong>the 2nd reference image</strong>.
                      </>
                    ) : (
                      <>
                        Qwen wants a long transplant instruction. It reads the rendered frame as{" "}
                        <strong>Picture 1</strong> and this character&apos;s reference photo as{" "}
                        <strong>Picture 2</strong>.
                      </>
                    )}{" "}
                    Where two characters share a frame, say which person this one is — &ldquo;the
                    man&rdquo;, &ldquo;the blonde woman&rdquo; — because the model cannot otherwise
                    tell them apart. Clear the box to fall back to the default.{" "}
                    {counter(value, MAX_FACE_SWAP_PROMPT)}
                  </p>
                  <div className="mt-2 flex items-baseline gap-2">
                    <label
                      htmlFor={`character-face-swap-steps-${choice.value}`}
                      className="text-[11px] text-slate-400"
                    >
                      Steps
                    </label>
                    <input
                      id={`character-face-swap-steps-${choice.value}`}
                      data-testid={`face-swap-steps-${choice.value}`}
                      type="number"
                      min={MIN_FACE_SWAP_STEPS}
                      max={MAX_FACE_SWAP_STEPS}
                      value={draft[STEPS_FIELD[choice.value]]}
                      placeholder={String(FACE_SWAP_STEP_HINT[choice.value])}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, [STEPS_FIELD[choice.value]]: e.target.value }))
                      }
                      className={`w-20 ${field}`}
                    />
                    <span className="text-[11px] text-slate-500">
                      {choice.value === "krea" ? (
                        <>
                          Empty uses the model&apos;s own default (
                          {FACE_SWAP_STEP_HINT.krea}). More steps favour keeping the original
                          composition; this is the main dial worth turning here.
                        </>
                      ) : (
                        <>
                          Empty uses {FACE_SWAP_STEP_HINT.qwen}, which is not a free number — the
                          head LoRA expects the accelerator&apos;s four-step schedule, so changing it
                          is an experiment rather than a tuning.
                        </>
                      )}
                    </span>
                  </div>
                </div>
              );
            })
          : null}
        <div>
          <label htmlFor="character-wardrobe" className={label}>
            Default wardrobe (optional)
          </label>
          <textarea
            id="character-wardrobe"
            rows={2}
            maxLength={500}
            value={draft.wardrobe}
            onChange={(e) => setDraft((d) => ({ ...d, wardrobe: e.target.value }))}
            placeholder="Only for a signature look — a uniform, a mascot costume. Most characters should be left blank."
            className={`mt-1 ${field}`}
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Costume belongs to the story, not the person, so wardrobe is normally set{" "}
            <strong>per project</strong> when you pick the cast — the same character can wear
            something different in the next one. Fill this in only for a character whose outfit never
            changes; a project&apos;s own wardrobe always overrides it. {counter(draft.wardrobe, 500)}
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
            className="rounded-md bg-accent-solid px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
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
            className="flex flex-wrap gap-3 rounded-md border border-white/10 bg-canvas/40 p-3"
          >
            {referenceImagesOf(character).length ? (
              <div className="flex flex-none gap-1">
                {referenceImagesOf(character).map((_, index) => (
                  // eslint-disable-next-line @next/next/no-img-element -- served from a local API route, not an optimizable static asset
                  <img
                    key={index}
                    src={`/api/characters/${character.id}/image?index=${index}&v=${encodeURIComponent(character.updatedAt)}`}
                    alt={`Reference ${index + 1} for ${character.name}`}
                    className="h-20 w-20 rounded-md object-cover"
                  />
                ))}
              </div>
            ) : (
              <div className="flex h-20 w-20 flex-none items-center justify-center rounded-md border border-dashed border-white/15 text-[10px] text-slate-500">
                No image
              </div>
            )}

            {/* basis-48 so the text drops below the thumbnails rather than
                being squeezed to zero width and pushing its buttons off-screen. */}
            <div className="min-w-0 flex-1 basis-48">
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
              {character.wardrobe ? (
                <p
                  className="mt-1 line-clamp-2 break-words text-xs text-slate-400"
                  title={character.wardrobe}
                >
                  Default wardrobe: {character.wardrobe}
                </p>
              ) : null}
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
                      facialDescription: character.facialDescription ?? "",
                      wardrobe: character.wardrobe ?? "",
                      negativePrompt: character.negativePrompt ?? "",
                      faceSwap: Boolean(character.faceSwap),
                      // A character saved before the split kept one prompt, and
                      // it was written against Qwen, so it opens as Qwen's.
                      faceSwapPromptKrea: faceSwapPromptOf(character, "krea"),
                      faceSwapPromptQwen: faceSwapPromptOf(character, "qwen"),
                      faceSwapStepsKrea: String(character.faceSwapSteps?.krea ?? ""),
                      faceSwapStepsQwen: String(character.faceSwapSteps?.qwen ?? ""),
                      faceSwapMethod: character.faceSwapMethod ?? DEFAULT_FACE_SWAP_METHOD,
                      faceSwapSubject: character.faceSwapSubject ?? DEFAULT_FACE_SWAP_SUBJECT,
                    });
                  }}
                  className="text-accent hover:underline disabled:opacity-50"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy || referenceImagesOf(character).length >= MAX_REFERENCE_IMAGES}
                  onClick={() => fileInputs.current[character.id]?.click()}
                  className="text-accent hover:underline disabled:opacity-50"
                  title={
                    referenceImagesOf(character).length >= MAX_REFERENCE_IMAGES
                      ? `At most ${MAX_REFERENCE_IMAGES} reference images — remove one first`
                      : undefined
                  }
                >
                  {referenceImagesOf(character).length
                    ? `Add reference image (${referenceImagesOf(character).length}/${MAX_REFERENCE_IMAGES})`
                    : "Add reference image"}
                </button>
                {referenceImagesOf(character).map((_, index) => (
                  <button
                    key={index}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void request(
                        `/api/characters/${character.id}/image?index=${index}`,
                        { method: "DELETE" },
                        "Failed to remove the reference image",
                      )
                    }
                    className="text-slate-400 hover:text-white disabled:opacity-50"
                  >
                    Remove image {index + 1}
                  </button>
                ))}
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
