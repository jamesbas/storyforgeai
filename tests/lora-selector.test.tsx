import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { LoraSelector } from "@/components/settings/lora-selector";
import type { LoraCatalog, LoraKind, LoraSelection } from "@/lib/schemas/lora";

const catalog: LoraCatalog = {
  supported: true,
  modelType: "example_model",
  directory: "example",
  loras: [
    {
      name: "OPAQUE-7F3A.safetensors",
      label: "Velvet Portrait",
      triggerWords: ["velvet skin", "soft studio light"],
      sizeMb: 144,
    },
    {
      name: "camera-handheld.safetensors",
      label: "Handheld Motion",
      triggerWords: ["documentary shake"],
      sizeMb: 96,
    },
    {
      name: "neon-rain.safetensors",
      label: "Neon Rain",
      triggerWords: [],
      sizeMb: 72,
    },
  ],
};

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function ControlledSelector({ kind = "image" }: { kind?: LoraKind }) {
  const [value, setValue] = useState<LoraSelection[]>([]);
  return (
    <LoraSelector
      projectId="project-1"
      kind={kind}
      value={value}
      onChange={setValue}
      modelType={`${kind}-model`}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(catalog)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searching the installed LoRA catalog", () => {
  it("matches the human label, filename, and trigger words case-insensitively", async () => {
    const user = userEvent.setup();
    render(<ControlledSelector />);

    const search = await screen.findByLabelText("Search available image LoRAs");
    const picker = screen.getByLabelText("Add image LoRA");

    await user.type(search, "HANDHELD");
    expect(picker).toHaveTextContent("Handheld Motion");
    expect(picker).not.toHaveTextContent("Velvet Portrait");

    await user.clear(search);
    await user.type(search, "7f3a");
    expect(picker).toHaveTextContent("Velvet Portrait");
    expect(picker).not.toHaveTextContent("Handheld Motion");

    await user.clear(search);
    await user.type(search, "studio light");
    expect(picker).toHaveTextContent("Velvet Portrait");
    expect(screen.getByText("1 of 3 available LoRAs match.")).toBeInTheDocument();
  });

  it("keeps selected LoRAs visible while filtering only the add catalog", async () => {
    const user = userEvent.setup();
    render(<ControlledSelector />);

    const picker = await screen.findByLabelText("Add image LoRA");
    await user.selectOptions(picker, "OPAQUE-7F3A.safetensors");
    expect(screen.getByText("Velvet Portrait")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search available image LoRAs"), "neon");
    expect(screen.getByText("Velvet Portrait")).toBeInTheDocument();
    expect(picker).toHaveTextContent("Neon Rain");
    expect(picker).not.toHaveTextContent("Handheld Motion");
  });

  it("distinguishes no matches and restores the catalog when cleared", async () => {
    const user = userEvent.setup();
    render(<ControlledSelector />);

    const search = await screen.findByLabelText("Search available image LoRAs");
    const picker = screen.getByLabelText("Add image LoRA");
    await user.type(search, "not installed");

    expect(picker).toBeDisabled();
    expect(picker).toHaveTextContent("No LoRAs match");
    expect(screen.getByText("0 of 3 available LoRAs match.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(search).toHaveValue("");
    expect(picker).toBeEnabled();
    expect(picker).toHaveTextContent("Add a LoRA (3 available)");
  });

  it("keeps image and video searches independent", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ControlledSelector kind="image" />
        <ControlledSelector kind="video" />
      </>,
    );

    const imageSearch = await screen.findByLabelText("Search available image LoRAs");
    const videoSearch = await screen.findByLabelText("Search available video LoRAs");
    await user.type(imageSearch, "velvet");

    expect(imageSearch).toHaveValue("velvet");
    expect(videoSearch).toHaveValue("");
    expect(screen.getByLabelText("Add image LoRA")).toHaveTextContent("1 matching");
    expect(screen.getByLabelText("Add video LoRA")).toHaveTextContent("3 available");
  });
});
