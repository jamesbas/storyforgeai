import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SceneLoraPanel } from "@/components/storyboard/scene-lora-panel";
import type { SceneLoraOverride } from "@/lib/schemas/lora";

// The real selector fetches the installed-LoRA catalogue on mount; the panel's
// own behaviour is the subject here.
vi.mock("@/components/settings/lora-selector", () => ({
  LoraSelector: ({ kind, value }: { kind: string; value: { name: string }[] }) => (
    <div data-testid={`selector-${kind}`}>{value.map((v) => v.name).join(",")}</div>
  ),
}));

const previous: SceneLoraOverride = {
  mode: "override",
  image: [{ name: "noir.safetensors", strength: 1 }],
  video: [{ name: "handheld.safetensors", strength: 0.8 }],
};

function open() {
  const details = screen.getByText("LoRAs").closest("details");
  if (details) details.open = true;
}

describe("SceneLoraPanel copy-previous option", () => {
  it("is hidden when the previous scene inherits", () => {
    render(<SceneLoraPanel projectId="p1" onSave={vi.fn()} />);
    open();
    expect(screen.queryByLabelText("Copy previous scene's LoRAs")).toBeNull();
  });

  it("is hidden when there is no previous scene override to copy", () => {
    render(
      <SceneLoraPanel
        projectId="p1"
        previousLoras={{ mode: "inherit", image: [], video: [] }}
        onSave={vi.fn()}
      />,
    );
    open();
    expect(screen.queryByLabelText("Copy previous scene's LoRAs")).toBeNull();
  });

  it("copies both kinds from the previous scene and saves as an override", async () => {
    const onSave = vi.fn();
    render(<SceneLoraPanel projectId="p1" previousLoras={previous} onSave={onSave} />);
    open();

    await userEvent.click(screen.getByLabelText("Copy previous scene's LoRAs"));

    expect(screen.getByTestId("selector-image")).toHaveTextContent("noir.safetensors");
    expect(screen.getByTestId("selector-video")).toHaveTextContent("handheld.safetensors");
    expect(screen.getByTestId("lora-copied-note")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save scene LoRAs" }));
    expect(onSave).toHaveBeenCalledWith({
      mode: "override",
      image: previous.image,
      video: previous.video,
    });
  });

  it("snapshots the selection rather than sharing the previous scene's arrays", async () => {
    const onSave = vi.fn();
    render(<SceneLoraPanel projectId="p1" previousLoras={previous} onSave={onSave} />);
    open();

    await userEvent.click(screen.getByLabelText("Copy previous scene's LoRAs"));
    await userEvent.click(screen.getByRole("button", { name: "Save scene LoRAs" }));

    const saved = onSave.mock.calls[0][0] as SceneLoraOverride;
    expect(saved.image).not.toBe(previous.image);
    expect(saved.video).not.toBe(previous.video);
  });

  it("goes back to inheriting without keeping the copied selection", async () => {
    const onSave = vi.fn();
    render(<SceneLoraPanel projectId="p1" previousLoras={previous} onSave={onSave} />);
    open();

    await userEvent.click(screen.getByLabelText("Copy previous scene's LoRAs"));
    await userEvent.click(screen.getByLabelText("Use storyboard LoRAs"));
    await userEvent.click(screen.getByRole("button", { name: "Save scene LoRAs" }));

    expect(onSave.mock.calls[0][0]).toMatchObject({ mode: "inherit" });
  });
});
