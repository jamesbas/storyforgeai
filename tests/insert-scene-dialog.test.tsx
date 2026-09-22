import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InsertSceneDialog } from "@/components/storyboard/insert-scene-dialog";
import type { OrderImpact } from "@/lib/storyboard/order-impact";

/**
 * The form that adds a scene.
 *
 * Its job is to make the two expensive choices explicit — whether to spend a
 * model call on the prompts, and whether to replace the following scene's
 * opening — while refusing to create a card that cannot produce a shot.
 */

const clean: OrderImpact = {
  inheritedFrames: [],
  promptSeams: [],
  wardrobe: [],
  staleArtifacts: [],
  clean: true,
};

const withSeam: OrderImpact = {
  inheritedFrames: [{ id: "s4", sceneNumber: 4, title: "The Arrival" }],
  promptSeams: [{ id: "s4", sceneNumber: 4, title: "The Arrival" }],
  wardrobe: [],
  staleArtifacts: [],
  clean: false,
};

function open(props: Partial<React.ComponentProps<typeof InsertSceneDialog>> = {}) {
  const onSubmit = vi.fn();
  render(
    <InsertSceneDialog
      open
      anchorSceneNumber={3}
      side="after"
      impact={clean}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
      {...props}
    />,
  );
  return onSubmit;
}

function fill() {
  fireEvent.change(screen.getByLabelText(/^Title$/i), { target: { value: "The Bridge" } });
  fireEvent.change(screen.getByLabelText(/Visual/i), { target: { value: "A flooded underpass." } });
  fireEvent.change(screen.getByLabelText(/Action/i), { target: { value: "She wades through." } });
}

describe("adding a scene", () => {
  it("says where the scene will go", () => {
    open();
    expect(screen.getByText(/Add a scene after scene 3/i)).toBeTruthy();
  });

  it("refuses a card with nothing to render", () => {
    const onSubmit = open();
    fireEvent.click(screen.getByRole("button", { name: /add the scene/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("insert-missing")).toBeTruthy();
  });

  it("submits the card once the three required fields are filled", () => {
    const onSubmit = open();
    fill();
    fireEvent.click(screen.getByRole("button", { name: /add the scene/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "The Bridge",
        visualDescription: "A flooded underpass.",
        actionDescription: "She wades through.",
      }),
      { writePrompts: false, rewriteFollower: false },
    );
  });

  /** A model call is a choice, not a toll on adding a card. */
  it("leaves the model off by default", () => {
    open();
    expect((screen.getByTestId("insert-write-prompts") as HTMLInputElement).checked).toBe(false);
  });

  it("passes the model choice through when asked", () => {
    const onSubmit = open();
    fill();
    fireEvent.click(screen.getByTestId("insert-write-prompts"));
    fireEvent.click(screen.getByRole("button", { name: /add the scene/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ writePrompts: true }),
    );
  });

  /** Only offered where there is actually a following scene to disturb. */
  it("offers the follower rewrite only when an opening is affected", () => {
    open();
    expect(screen.queryByTestId("insert-rewrite-follower")).toBeNull();
  });

  it("offers it unticked when an opening is affected", () => {
    open({ impact: withSeam });
    const checkbox = screen.getByTestId("insert-rewrite-follower") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it("warns that a carried frame will no longer match", () => {
    open({ impact: withSeam });
    expect(screen.getByTestId("insert-frame-warning").textContent).toContain("Scene 4");
  });

  it("says nothing alarming when the insertion costs nothing", () => {
    open();
    expect(screen.queryByTestId("insert-frame-warning")).toBeNull();
  });

  it("trims whitespace and drops the optional fields left empty", () => {
    const onSubmit = open();
    fireEvent.change(screen.getByLabelText(/^Title$/i), { target: { value: "  Padded  " } });
    fireEvent.change(screen.getByLabelText(/Visual/i), { target: { value: " a shot " } });
    fireEvent.change(screen.getByLabelText(/Action/i), { target: { value: " an action " } });
    fireEvent.click(screen.getByRole("button", { name: /add the scene/i }));

    const [card] = onSubmit.mock.calls[0]!;
    expect(card).toEqual({
      title: "Padded",
      visualDescription: "a shot",
      actionDescription: "an action",
    });
  });
});
