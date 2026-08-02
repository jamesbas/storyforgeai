import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import { useLoadEffect } from "@/components/shared/use-load-effect";

/** Resolves when the test says so, so response ordering can be controlled. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Loading from an effect has two failure modes the old
 * `useEffect(() => { void load(); })` shape had no answer for: a response that
 * lands after the component is gone, and a slow response from an older run
 * overwriting a newer one.
 */
describe("useLoadEffect", () => {
  it("applies a response that is still current", async () => {
    function Screen() {
      const [value, setValue] = useState("initial");
      const load = useCallback(async (isCurrent: () => boolean = () => true) => {
        await Promise.resolve();
        if (isCurrent()) setValue("loaded");
      }, []);
      useLoadEffect(load);
      return <p data-testid="value">{value}</p>;
    }

    render(<Screen />);
    await waitFor(() => expect(screen.getByTestId("value")).toHaveTextContent("loaded"));
  });

  it("drops a response that arrives after unmount", async () => {
    const applied = vi.fn();
    const gate = deferred<void>();

    function Screen() {
      const load = useCallback(async (isCurrent: () => boolean = () => true) => {
        await gate.promise;
        if (isCurrent()) applied();
      }, []);
      useLoadEffect(load);
      return <p>screen</p>;
    }

    const view = render(<Screen />);
    view.unmount();
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(applied).not.toHaveBeenCalled();
  });

  it("keeps the newer result when two runs resolve out of order", async () => {
    const first = deferred<string>();
    const second = deferred<string>();

    function Screen({ which }: { which: "first" | "second" }) {
      const [value, setValue] = useState("none");
      const load = useCallback(
        async (isCurrent: () => boolean = () => true) => {
          const next = await (which === "first" ? first.promise : second.promise);
          if (isCurrent()) setValue(next);
        },
        [which],
      );
      useLoadEffect(load);
      return <p data-testid="value">{value}</p>;
    }

    const view = render(<Screen which="first" />);
    // The second run starts before the first has answered.
    view.rerender(<Screen which="second" />);

    second.resolve("second");
    await waitFor(() => expect(screen.getByTestId("value")).toHaveTextContent("second"));

    // The stale first response must not overwrite it.
    first.resolve("first");
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByTestId("value")).toHaveTextContent("second");
  });

  it("applies a manual reload, which carries no currency check", async () => {
    let reload!: () => Promise<void>;

    function Screen() {
      const [value, setValue] = useState("initial");
      const load = useCallback(async (isCurrent: () => boolean = () => true) => {
        await Promise.resolve();
        if (isCurrent()) setValue((v) => (v === "initial" ? "loaded" : "reloaded"));
      }, []);
      useLoadEffect(load);
      reload = () => load();
      return <p data-testid="value">{value}</p>;
    }

    render(<Screen />);
    await waitFor(() => expect(screen.getByTestId("value")).toHaveTextContent("loaded"));

    await reload();
    await waitFor(() => expect(screen.getByTestId("value")).toHaveTextContent("reloaded"));
  });
});
