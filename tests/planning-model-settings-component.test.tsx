import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanningModelSettingsForm } from "@/components/settings/planning-model-settings";
import { PLANNING_MODELS } from "@/lib/schemas/planning-model-settings";

const DEFAULT_MODEL = "environment-default";
const settings = {
  version: 1, model: null, defaultModel: DEFAULT_MODEL, effectiveModel: DEFAULT_MODEL,
};
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

async function openForm() {
  render(<PlanningModelSettingsForm />);
  await screen.findByLabelText("Planning model");
  await userEvent.click(screen.getByText("AI planning model"));
  return screen.getByRole("combobox", { name: "Planning model" });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ settings })));
});

describe("PlanningModelSettingsForm", () => {
  it("starts collapsed with the environment default and all six model presets", async () => {
    render(<PlanningModelSettingsForm />);
    const picker = await screen.findByLabelText("Planning model");
    expect(screen.getByTestId("planning-model-section")).not.toHaveAttribute("open");
    expect(picker).toHaveValue("");
    await userEvent.click(screen.getByText("AI planning model"));
    expect(screen.getAllByRole("option")).toHaveLength(7);
    expect(screen.getByRole("option", { name: `Use environment default (${DEFAULT_MODEL})` }))
      .toBeInTheDocument();
    for (const model of PLANNING_MODELS) {
      expect(screen.getByRole("option", { name: model })).toHaveValue(model);
    }
  });

  it("loads an existing override instead of replacing it with the environment default", async () => {
    vi.mocked(fetch).mockResolvedValue(response({
      settings: { ...settings, model: PLANNING_MODELS[2], effectiveModel: PLANNING_MODELS[2] },
    }));
    expect(await openForm()).toHaveValue(PLANNING_MODELS[2]);
  });

  it("saves a selection immediately and can switch back to the environment default", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ settings }))
      .mockResolvedValueOnce(response({
        settings: { ...settings, model: PLANNING_MODELS[1], effectiveModel: PLANNING_MODELS[1] },
      }))
      .mockResolvedValueOnce(response({ settings }));
    const picker = await openForm();
    await userEvent.selectOptions(picker, PLANNING_MODELS[1]);
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/settings/planning-model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: PLANNING_MODELS[1] }),
    });
    expect(await screen.findByRole("status")).toHaveTextContent(`will use ${PLANNING_MODELS[1]}`);
    expect(picker).toHaveValue(PLANNING_MODELS[1]);
    await userEvent.selectOptions(picker, "");
    expect(fetch).toHaveBeenNthCalledWith(3, "/api/settings/planning-model", expect.objectContaining({
      body: JSON.stringify({ model: null }),
    }));
    await waitFor(() => expect(picker).toHaveValue(""));
    expect(screen.getByRole("status")).toHaveTextContent(`will use ${DEFAULT_MODEL}`);
  });

  it("keeps the saved choice and reports a failed save", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ settings }))
      .mockResolvedValueOnce(response({ error: "Disk is full" }, false));
    const picker = await openForm();
    await userEvent.selectOptions(picker, PLANNING_MODELS[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk is full");
    expect(picker).toHaveValue("");
    expect(picker).not.toBeDisabled();
  });

  it("reports load failures without presenting a success-shaped default", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Settings unavailable"));
    render(<PlanningModelSettingsForm />);
    await userEvent.click(screen.getByText("AI planning model"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings unavailable");
    expect(screen.queryByLabelText("Planning model")).not.toBeInTheDocument();
  });
});
