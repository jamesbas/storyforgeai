/**
 * What a rerun says about the scenes around the ones you picked.
 *
 * Shared by the Storyboard screen and the Scheduler so a run reads the same
 * whichever of them started it.
 */

export const CASCADE_NOTICE =
  "This project continues each clip from the previous one, so every scene after the earliest you picked was included too. Leaving them alone would have left them continuing from a clip that no longer exists.";

/** Scenes left showing a start frame copied from a re-rendered scene's old end frame. */
export function followOnNotice(followOn: readonly number[]): string {
  const one = followOn.length === 1;
  return (
    `This project carries each scene's end frame into the next one's start frame. ` +
    `Scene${one ? "" : "s"} ${followOn.join(", ")} still show${one ? "s" : ""} ` +
    `the old frame and ${one ? "was" : "were"} not included — ` +
    `pick ${one ? "it" : "them"} too if the seam matters.`
  );
}
