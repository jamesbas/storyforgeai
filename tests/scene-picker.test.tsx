import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScenePicker } from "@/components/storyboard/scene-picker";
import type { Scene } from "@/lib/schemas/storyboard";

const scenes = [1, 2, 3].map(
  (sceneNumber) => ({ id: `p1-scene-00${sceneNumber}`, sceneNumber }) as Scene,
);

function picker(picked: string[]) {
  const onChange = vi.fn();
  render(<ScenePicker scenes={scenes} picked={picked} onChange={onChange} />);
  return onChange;
}

describe("picking scenes to act on", () => {
  it("takes the lot", () => {
    const onChange = picker([]);
    screen.getByText("Select all").click();
    expect(onChange).toHaveBeenCalledWith(scenes.map((s) => s.id));
  });

  it("drops the lot", () => {
    const onChange = picker(scenes.map((s) => s.id));
    screen.getByText("Clear all").click();
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("adds one without disturbing the others", () => {
    const onChange = picker(["p1-scene-001"]);
    screen.getByLabelText("Scene 3").click();
    expect(onChange).toHaveBeenCalledWith(["p1-scene-001", "p1-scene-003"]);
  });

  it("removes one without disturbing the others", () => {
    const onChange = picker(["p1-scene-001", "p1-scene-002"]);
    screen.getByLabelText("Scene 1").click();
    expect(onChange).toHaveBeenCalledWith(["p1-scene-002"]);
  });

  /** Both buttons are no-ops at the extremes, and an enabled no-op reads as broken. */
  it("disables each button where it would do nothing", () => {
    const { unmount } = render(
      <ScenePicker scenes={scenes} picked={[]} onChange={vi.fn()} />,
    );
    expect(screen.getByText("Clear all")).toBeDisabled();
    expect(screen.getByText("Select all")).toBeEnabled();
    unmount();

    render(<ScenePicker scenes={scenes} picked={scenes.map((s) => s.id)} onChange={vi.fn()} />);
    expect(screen.getByText("Select all")).toBeDisabled();
    expect(screen.getByText("Clear all")).toBeEnabled();
  });
});
