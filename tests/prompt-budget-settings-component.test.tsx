import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptBudgetSettingsForm } from "@/components/settings/prompt-budget-settings";
import { DEFAULT_PROMPT_BUDGET_SETTINGS } from "@/lib/schemas/prompt-budget-settings";

const settings = DEFAULT_PROMPT_BUDGET_SETTINGS;
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

async function openForm() {
  render(<PromptBudgetSettingsForm />);
  await screen.findByLabelText("Image words, one person");
  await userEvent.click(screen.getByText("Prompt length limits"));
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ settings })));
});

describe("PromptBudgetSettingsForm", () => {
  it("shows the saved limits, with empty boxes where the model default applies", async () => {
    await openForm();
    expect(screen.getByLabelText("Image words, one person")).toHaveValue(null);
    expect(screen.getByLabelText("Extra image words per additional person")).toHaveValue(20);
    expect(screen.getByLabelText("Image words, never more than")).toHaveValue(200);
    expect(screen.getByLabelText("Video words, any clip length")).toHaveValue(null);
  });

  it("saves edited limits, sending an empty box as the model default", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ settings }))
      .mockResolvedValueOnce(response({
        settings: { ...settings, imageWords: 140, wordsPerExtraPerson: 30 },
      }));
    await openForm();
    await userEvent.type(screen.getByLabelText("Image words, one person"), "140");
    const perPerson = screen.getByLabelText("Extra image words per additional person");
    await userEvent.clear(perPerson);
    await userEvent.type(perPerson, "30");
    await userEvent.click(screen.getByRole("button", { name: "Save limits" }));

    expect(fetch).toHaveBeenNthCalledWith(2, "/api/settings/prompt-budgets", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        imageWords: 140, wordsPerExtraPerson: 30, imageMaxWords: 200, videoWords: null,
      }),
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
    expect(screen.getByLabelText("Image words, one person")).toHaveValue(140);
  });

  it("reports a rejected save and keeps what was typed", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ settings }))
      .mockResolvedValueOnce(response({ error: "Too small" }, false));
    await openForm();
    await userEvent.type(screen.getByLabelText("Video words, any clip length"), "100");
    await userEvent.click(screen.getByRole("button", { name: "Save limits" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too small");
    expect(screen.getByLabelText("Video words, any clip length")).toHaveValue(100);
  });

  it("reports load failures without showing editable defaults", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Settings unavailable"));
    render(<PromptBudgetSettingsForm />);
    await userEvent.click(screen.getByText("Prompt length limits"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings unavailable");
    expect(screen.queryByLabelText("Image words, one person")).not.toBeInTheDocument();
  });
});
