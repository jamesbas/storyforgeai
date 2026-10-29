"use client";

import { useCallback, useState } from "react";
import { AsyncStatus } from "@/components/shared/async-status";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { useLoadEffect } from "@/components/shared/use-load-effect";
import {
  PROMPT_BUDGET_LIMITS,
  type PromptBudgetSettings,
} from "@/lib/schemas/prompt-budget-settings";

type Fields = {
  imageWords: string;
  wordsPerExtraPerson: string;
  imageMaxWords: string;
  videoWords: string;
};

const toFields = (settings: PromptBudgetSettings): Fields => ({
  imageWords: settings.imageWords?.toString() ?? "",
  wordsPerExtraPerson: String(settings.wordsPerExtraPerson),
  imageMaxWords: String(settings.imageMaxWords),
  videoWords: settings.videoWords?.toString() ?? "",
});

/** An empty box means "use the model's default"; anything else is sent as a number. */
const optionalNumber = (value: string) => (value.trim() === "" ? null : Number(value));

const inputClass =
  "w-full rounded-md border border-white/10 bg-panel/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent";

export function PromptBudgetSettingsForm() {
  const [fields, setFields] = useState<Fields | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<string | null>("Loading prompt lengths...");

  const load = useCallback(async (isCurrent: () => boolean = () => true) => {
    try {
      const res = await fetch("/api/settings/prompt-budgets", { cache: "no-store" });
      const body = (await res.json()) as { settings: PromptBudgetSettings; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not load prompt length settings.");
      if (!isCurrent()) return;
      setFields(toFields(body.settings));
      setStatus(null);
    } catch (error) {
      if (!isCurrent()) return;
      setFailed(true);
      setStatus(error instanceof Error ? error.message : "Could not load prompt length settings.");
    }
  }, []);

  useLoadEffect(load);

  const set = (key: keyof Fields) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setFields((current) => (current ? { ...current, [key]: event.target.value } : current));

  const save = async (next: Fields) => {
    setBusy(true);
    setFailed(false);
    setStatus("Saving...");
    try {
      const res = await fetch("/api/settings/prompt-budgets", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          imageWords: optionalNumber(next.imageWords),
          wordsPerExtraPerson: Number(next.wordsPerExtraPerson),
          imageMaxWords: Number(next.imageMaxWords),
          videoWords: optionalNumber(next.videoWords),
        }),
      });
      const body = (await res.json()) as { settings: PromptBudgetSettings; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save prompt length settings.");
      setFields(toFields(body.settings));
      setStatus("Saved. Prompts written from now on use these limits.");
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : "Could not save prompt length settings.");
    } finally {
      setBusy(false);
    }
  };

  const limits = PROMPT_BUDGET_LIMITS;

  return (
    <CollapsibleSection
      testId="prompt-budget-section"
      title="Prompt length limits"
      description="Word ceilings for the image and video prompts the planner writes, for every project. Shorter, more direct image prompts tend to render better, so raise these only where a scene needs the room. Existing prompts are unchanged until rewritten."
    >
      {fields ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save(fields);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="budget-image-words" className="block text-sm font-medium">
                Image words, one person
              </label>
              <input
                id="budget-image-words"
                type="number"
                className={inputClass}
                min={limits.imageWords.min}
                max={limits.imageWords.max}
                placeholder="Model default (120, Qwen 140)"
                value={fields.imageWords}
                disabled={busy}
                onChange={set("imageWords")}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="budget-per-person" className="block text-sm font-medium">
                Extra image words per additional person
              </label>
              <input
                id="budget-per-person"
                type="number"
                className={inputClass}
                min={limits.wordsPerExtraPerson.min}
                max={limits.wordsPerExtraPerson.max}
                value={fields.wordsPerExtraPerson}
                disabled={busy}
                onChange={set("wordsPerExtraPerson")}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="budget-image-max" className="block text-sm font-medium">
                Image words, never more than
              </label>
              <input
                id="budget-image-max"
                type="number"
                className={inputClass}
                min={limits.imageMaxWords.min}
                max={limits.imageMaxWords.max}
                value={fields.imageMaxWords}
                disabled={busy}
                onChange={set("imageMaxWords")}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="budget-video-words" className="block text-sm font-medium">
                Video words, any clip length
              </label>
              <input
                id="budget-video-words"
                type="number"
                className={inputClass}
                min={limits.videoWords.min}
                max={limits.videoWords.max}
                placeholder="Model default (about 85-150 for 20 s)"
                value={fields.videoWords}
                disabled={busy}
                onChange={set("videoWords")}
              />
            </div>
          </div>
          <p className="text-xs text-slate-400">
            Words, not tokens (roughly 1.3 tokens each). The image ceiling counts the style, cast
            and wardrobe text StoryForge appends after the model&apos;s answer, and grows by the
            per-person amount for every person beyond the first in the frame, up to the maximum.
            Spoken dialogue is not counted against the video limit. Leave the one-person image
            and video boxes empty to keep each model&apos;s built-in default.
          </p>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Save limits
          </button>
        </form>
      ) : null}
      <AsyncStatus
        testId="prompt-budget-status"
        message={status}
        failed={failed}
        busy={busy || (!fields && !failed)}
      />
    </CollapsibleSection>
  );
}
