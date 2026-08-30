import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SystemPromptSettingsForm } from "@/components/settings/system-prompt-settings";

const saved = {
  version: 1 as const,
  agenticCanvas: "Favor visual causality.",
  storyboard: "Record undressing as a wardrobe change.",
  renderPrompts: "Keep render prompts concise.",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ settings: saved })));
});

describe("SystemPromptSettingsForm", () => {
  it("starts collapsed so the settings page stays scannable", async () => {
    render(<SystemPromptSettingsForm />);
    await screen.findByLabelText("Agentic Canvas system prompt");

    expect(screen.getByTestId("system-prompts-section")).not.toHaveAttribute("open");
  });

  it("loads every saved prompt", async () => {
    render(<SystemPromptSettingsForm />);

    expect(await screen.findByLabelText("Agentic Canvas system prompt")).toHaveValue(
      "Favor visual causality.",
    );
    expect(screen.getByLabelText("Storyboard system prompt")).toHaveValue(
      "Record undressing as a wardrobe change.",
    );
    expect(screen.getByLabelText("Render prompt system prompt")).toHaveValue(
      "Keep render prompts concise.",
    );
  });

  /** Misuse is silent at render time, so the warning has to be on the form itself. */
  it("warns about misuse and links to the full guidance", async () => {
    render(<SystemPromptSettingsForm />);
    await screen.findByLabelText("Agentic Canvas system prompt");

    expect(screen.getByText(/degrade every project/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /full guidance in Help/i })).toHaveAttribute(
      "href",
      "/help#systemprompts",
    );
  });

  it("refuses a partial save before calling the API", async () => {
    render(<SystemPromptSettingsForm />);
    const renderPrompts = await screen.findByLabelText("Render prompt system prompt");
    await userEvent.clear(renderPrompts);
    await userEvent.click(screen.getByRole("button", { name: "Save system prompts" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/all three system prompts/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("saves the complete set together", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(response({ settings: saved }))
      .mockResolvedValueOnce(
        response({ settings: { ...saved, renderPrompts: "New render policy" } }),
      );
    render(<SystemPromptSettingsForm />);
    const renderPrompts = await screen.findByLabelText("Render prompt system prompt");
    await userEvent.clear(renderPrompts);
    await userEvent.type(renderPrompts, "New render policy");
    await userEvent.click(screen.getByRole("button", { name: "Save system prompts" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      agenticCanvas: "Favor visual causality.",
      storyboard: "Record undressing as a wardrobe change.",
      renderPrompts: "New render policy",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Custom system prompts saved.");
  });

  it("clears every prompt in one request", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(response({ settings: saved }))
      .mockResolvedValueOnce(
        response({ settings: { version: 1, updatedAt: "2026-08-29T00:01:00.000Z" } }),
      );
    render(<SystemPromptSettingsForm />);
    await screen.findByLabelText("Agentic Canvas system prompt");
    await userEvent.click(screen.getByRole("button", { name: "Clear custom prompts" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      agenticCanvas: "",
      storyboard: "",
      renderPrompts: "",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Using built-in system prompts.");
  });
});