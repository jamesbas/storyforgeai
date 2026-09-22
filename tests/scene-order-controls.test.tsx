import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SceneOrderControls } from "@/components/storyboard/scene-order-controls";
import { OrderImpactDialog } from "@/components/storyboard/order-impact-dialog";
import type { OrderImpact } from "@/lib/storyboard/order-impact";

/**
 * The controls that rearrange a storyboard.
 *
 * Position is the entire meaning of these buttons, so the accessible names
 * carry the scene number: four identically-named buttons per card, on a
 * twenty-scene board, would leave a screen reader with eighty indistinguishable
 * controls.
 */

const clean: OrderImpact = {
  inheritedFrames: [],
  promptSeams: [],
  wardrobe: [],
  staleArtifacts: [],
  clean: true,
};

describe("the scene order controls", () => {
  it("names the scene in every control", () => {
    render(<SceneOrderControls sceneNumber={7} isFirst={false} isLast={false} />);

    expect(screen.getByRole("button", { name: "Move scene 7 up" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move scene 7 down" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Insert a scene before scene 7" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Insert a scene after scene 7" })).toBeTruthy();
  });

  it("cannot move the first scene up", () => {
    render(<SceneOrderControls sceneNumber={1} isFirst isLast={false} onMove={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Move scene 1 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move scene 1 down" })).not.toBeDisabled();
  });

  it("cannot move the last scene down", () => {
    render(<SceneOrderControls sceneNumber={9} isFirst={false} isLast onMove={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Move scene 9 down" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move scene 9 up" })).not.toBeDisabled();
  });

  /** Inserting stays reachable at both ends — that is how you prepend and append. */
  it("leaves both insert controls enabled at the ends of the list", () => {
    render(
      <SceneOrderControls sceneNumber={1} isFirst isLast={false} onInsert={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Insert a scene before scene 1" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Insert a scene after scene 1" })).not.toBeDisabled();
  });

  it("reports the direction it was asked for", () => {
    const onMove = vi.fn();
    render(<SceneOrderControls sceneNumber={4} isFirst={false} isLast={false} onMove={onMove} />);

    fireEvent.click(screen.getByRole("button", { name: "Move scene 4 up" }));
    expect(onMove).toHaveBeenCalledWith("up");

    fireEvent.click(screen.getByRole("button", { name: "Move scene 4 down" }));
    expect(onMove).toHaveBeenCalledWith("down");
  });

  it("locks everything while a queue is running, and says why", () => {
    render(
      <SceneOrderControls
        sceneNumber={4}
        isFirst={false}
        isLast={false}
        queueActive
        onMove={vi.fn()}
        onInsert={vi.fn()}
      />,
    );

    const panel = screen.getByTestId("scene-order-controls");
    for (const control of within(panel).getAllByRole("button")) {
      expect(control).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Move scene 4 up" }).title).toMatch(/queue/i);
  });

  it("locks everything while the scene is busy", () => {
    render(
      <SceneOrderControls sceneNumber={4} isFirst={false} isLast={false} busy onMove={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Move scene 4 up" })).toBeDisabled();
  });

  /** Insertion is not built yet; the pair holds its place rather than moving in later. */
  it("disables the insert pair when no handler is supplied", () => {
    render(<SceneOrderControls sceneNumber={4} isFirst={false} isLast={false} onMove={vi.fn()} />);
    const insert = screen.getByRole("button", { name: "Insert a scene after scene 4" });
    expect(insert).toBeDisabled();
    expect(insert.title).toMatch(/coming soon/i);
  });
});

describe("the confirmation", () => {
  const noop = { onConfirm: vi.fn(), onCancel: vi.fn(), onRewritePromptsChange: vi.fn() };

  it("says plainly when a move costs nothing", () => {
    render(
      <OrderImpactDialog
        open
        title="Move scene 3 up?"
        confirmLabel="Move the scene"
        impact={clean}
        rewritePrompts={false}
        {...noop}
      />,
    );

    expect(screen.getByTestId("impact-clean")).toBeTruthy();
    expect(screen.queryByTestId("rewrite-prompts")).toBeNull();
  });

  it("lists the consequences it found", () => {
    render(
      <OrderImpactDialog
        open
        title="Move scene 3 up?"
        confirmLabel="Move the scene"
        impact={{
          inheritedFrames: [{ id: "s8", sceneNumber: 8, title: "The Arrival" }],
          promptSeams: [{ id: "s8", sceneNumber: 8, title: "The Arrival" }],
          wardrobe: [{ id: "s9", sceneNumber: 9, title: "The Exit" }],
          staleArtifacts: ["assembly"],
          clean: false,
        }}
        rewritePrompts={false}
        {...noop}
      />,
    );

    const body = screen.getByTestId("impact-consequences");
    expect(within(body).getByText(/Frames already rendered/)).toBeTruthy();
    expect(within(body).getByText(/Wardrobe/)).toBeTruthy();
    expect(body.textContent).toContain("8 (The Arrival)");
    expect(body.textContent).toContain("9 (The Exit)");
    expect(body.textContent).toContain("the assembled cut");
  });

  /** Opt-in: offered, unticked, and only where there is a seam to repair. */
  it("offers the rewrite unticked when openings are affected", () => {
    render(
      <OrderImpactDialog
        open
        title="Move scene 3 up?"
        confirmLabel="Move the scene"
        impact={{
          inheritedFrames: [],
          promptSeams: [{ id: "s4", sceneNumber: 4, title: "The Bridge" }],
          wardrobe: [],
          staleArtifacts: [],
          clean: false,
        }}
        rewritePrompts={false}
        {...noop}
      />,
    );

    const checkbox = screen.getByTestId("rewrite-prompts") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it("shows it is still working out the impact", () => {
    render(
      <OrderImpactDialog
        open
        title="Move scene 3 up?"
        confirmLabel="Move the scene"
        impact={null}
        rewritePrompts={false}
        {...noop}
      />,
    );
    expect(screen.getByText(/working out what this would affect/i)).toBeTruthy();
  });
});
