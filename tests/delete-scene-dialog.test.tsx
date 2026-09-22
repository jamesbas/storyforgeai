import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeleteSceneDialog } from "@/components/storyboard/delete-scene-dialog";
import type { OrderImpact } from "@/lib/storyboard/order-impact";

/**
 * The one confirmation in this feature that precedes real loss.
 *
 * Its job is to be specific about what goes and — just as important — about
 * what does not: the rendered files stay on disk, which is the thing people
 * assume the opposite of.
 */

const clean: OrderImpact = {
  inheritedFrames: [],
  promptSeams: [],
  wardrobe: [],
  staleArtifacts: [],
  clean: true,
};

function open(props: Partial<React.ComponentProps<typeof DeleteSceneDialog>> = {}) {
  render(
    <DeleteSceneDialog
      open
      sceneNumber={3}
      title="The Ritual"
      impact={clean}
      hadMedia={false}
      cues={0}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      {...props}
    />,
  );
}

describe("deleting a scene", () => {
  it("names the scene it is about to remove", () => {
    open();
    expect(screen.getByText(/Delete scene 3 — The Ritual\?/)).toBeTruthy();
  });

  it("says the rendered files stay on disk", () => {
    open({ hadMedia: true });
    expect(screen.getByTestId("delete-media-note").textContent).toMatch(/project folder/i);
  });

  it("says nothing about media when the scene never rendered any", () => {
    open({ hadMedia: false });
    expect(screen.queryByTestId("delete-media-note")).toBeNull();
  });

  it("counts the audio cues that go with it", () => {
    open({ cues: 1 });
    expect(screen.getByTestId("delete-cue-note").textContent).toMatch(/One audio cue is/);
  });

  it("pluralises more than one cue", () => {
    open({ cues: 3 });
    expect(screen.getByTestId("delete-cue-note").textContent).toMatch(/3 audio cues are/);
  });

  it("warns when a following scene loses the frame it opens on", () => {
    open({
      impact: {
        ...clean,
        clean: false,
        inheritedFrames: [{ id: "s4", sceneNumber: 4, title: "The Arrival" }],
      },
    });
    expect(screen.getByTestId("delete-follower-note").textContent).toContain("4");
  });

  it("shows it is still working out the impact", () => {
    open({ impact: null });
    expect(screen.getByText(/working out what this would affect/i)).toBeTruthy();
    expect(screen.queryByTestId("delete-consequences")).toBeNull();
  });

  /** Focus starts on Cancel: the destructive button is one Tab away. */
  it("keeps the destructive button out of the way of a stray Enter", () => {
    open();
    expect(document.activeElement?.textContent).toBe("Cancel");
  });
});
