"use client";

import { denouementBudget, earliestClimax } from "@/lib/agents/beat-budget";
import { MAX_AFTERMATH_SCENES, MAX_CLIMAX_CHARACTERS } from "@/lib/types";

export type ClimaxFieldsProps = {
  climax: string;
  /** Closing scenes after the climax; undefined means the automatic budget. */
  aftermath: number | undefined;
  /** Scenes the piece has, so the fields can say where the climax will land. */
  segmentCount: number;
  onClimaxChange: (next: string) => void;
  onAftermathChange: (next: number | undefined) => void;
  disabled?: boolean;
  field: string;
  label: string;
};

/**
 * The user's statement of what the climax is and how much follows it.
 *
 * Left to itself the Story Architect decides which moment the story builds to
 * and where it lands, and both went wrong on the same bar fight: a knockout on
 * scene 8 of 15, then seven scenes of aftermath. Naming the event removes the
 * guess about *what*; the scene count after it removes the guess about *where*.
 */
export function ClimaxFields({
  climax,
  aftermath,
  segmentCount,
  onClimaxChange,
  onAftermathChange,
  disabled,
  field,
  label,
}: ClimaxFieldsProps) {
  const automatic = denouementBudget(segmentCount);
  const landsAt = earliestClimax(segmentCount, aftermath);
  const tooLong = climax.length > MAX_CLIMAX_CHARACTERS;
  // Below three scenes there is no arc to place a climax in, and the Story
  // Architect is told nothing about one.
  const placeable = segmentCount > 2;

  return (
    <div className="space-y-3" data-testid="climax-fields">
      <div>
        <label htmlFor="climax" className={label}>
          Climax <span className="normal-case tracking-normal">— optional</span>
        </label>
        <input
          id="climax"
          value={climax}
          disabled={disabled}
          onChange={(e) => onClimaxChange(e.target.value)}
          placeholder="Marcus drops Dale with one punch"
          className={`mt-1 w-full ${field}`}
        />
        <p className={`mt-1 text-xs ${tooLong ? "text-red-300" : "text-slate-500"}`}>
          The one event the story builds to, in a line. Name something your concept already
          describes — if the two disagree, the model tends to follow the concept. Leave it blank and
          the Story Architect chooses.
          {tooLong ? ` Limited to ${MAX_CLIMAX_CHARACTERS} characters.` : ""}
        </p>
      </div>
      <div>
        <label htmlFor="aftermathScenes" className={label}>
          Scenes after the climax
        </label>
        <select
          id="aftermathScenes"
          value={aftermath === undefined ? "" : String(aftermath)}
          disabled={disabled}
          onChange={(e) =>
            onAftermathChange(e.target.value === "" ? undefined : Number(e.target.value))
          }
          className={`mt-1 w-full ${field}`}
        >
          <option value="">Automatic ({automatic})</option>
          {Array.from({ length: MAX_AFTERMATH_SCENES + 1 }, (_, n) => (
            <option key={n} value={n}>
              {n === 0 ? "0 — end on the climax" : n}
            </option>
          ))}
        </select>
        {placeable ? (
          <p className="mt-1 text-xs text-slate-500" data-testid="climax-position">
            The climax lands at scene {landsAt} of {segmentCount} or later. Everything before it is
            setup and build, which is where the time goes.
          </p>
        ) : (
          <p className="mt-1 text-xs text-slate-500">
            With {segmentCount} scene{segmentCount === 1 ? "" : "s"} there is no arc to place a
            climax in.
          </p>
        )}
      </div>
    </div>
  );
}
