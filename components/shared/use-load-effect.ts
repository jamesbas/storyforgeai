"use client";

import { useEffect } from "react";

/** A loader that can test whether its result is still wanted before applying it. */
export type Loader = (isCurrent: () => boolean) => Promise<void>;

/**
 * Run `load` on mount and whenever it changes, discarding a response that
 * arrives after the component unmounted or after a newer run started.
 *
 * The call is wrapped in an async function on purpose: it puts the state update
 * after a suspension point rather than synchronously inside the effect body,
 * which is what `react-hooks/set-state-in-effect` asks for and what makes the
 * currency check meaningful. Without it, two runs of the same loader can
 * resolve out of order and the slower, older response wins.
 */
export function useLoadEffect(load: Loader): void {
  useEffect(() => {
    let current = true;
    void (async () => {
      await load(() => current);
    })();
    return () => {
      current = false;
    };
  }, [load]);
}
