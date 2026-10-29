import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanningModelSettingsForm } from "@/components/settings/planning-model-settings";
import { PLANNING_MODELS } from "@/lib/schemas/planning-model-settings";

const DEFAULT_MODEL = "environment-default";
const stages = { storyboard: null, agentic_canvas: null, render_prompts: null };
const settings = {
  version: 2,
  model: null,
  stages,
  defaultModel: DEFAULT_MODEL,
  effectiveModel: DEFAULT_MODEL,
  effectiveStages: {
    storyboard: DEFAULT_MODEL, agentic_canvas: DEFAULT_MODEL, render_prompts: DEFAULT_MODEL,
  },
};
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

async function openForm() {
  render(<PlanningModelSettingsForm />);
  await screen.findByLabelText("Planning model");
  await userEvent.click(screen.getByText("AI planning models"));
}

const picker = (name: string) => screen.getByRole("combobox", { name });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ settings, available: [] })));
});

describe("PlanningModelSettingsForm", () => {
  it("starts collapsed with every picker on its default", async () => {
    render(<PlanningModelSettingsForm />);
    await screen.findByLabelText("Planning model");
    expect(screen.getByTestId("planning-model-section")).not.toHaveAttribute("open");
    expect(picker("Planning model")).toHaveValue("");
    expect(
      within(picker("Planning model")).getByRole("option", {
        name: `Use environment default (${DEFAULT_MODEL})`,
      }),
    ).toBeInTheDocument();
    for (const label of ["Story and storyboard", "Creative plans", "Prompt writing"]) {
      expect(picker(label)).toHaveValue("");
      expect(
        within(picker(label)).getByRole("option", {
          name: `Same as planning model (${DEFAULT_MODEL})`,
        }),
      ).toBeInTheDocument();
    }
  });

  it("lists the server's models and the presets in every picker, with a way to type another", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ settings, available: ["installed-llm"] }));
    await openForm();
    for (const label of ["Planning model", "Story and storyboard", "Prompt writing"]) {
      const options = within(picker(label)).getAllByRole("option").map((o) => o.textContent);
      expect(options).toContain("installed-llm");
      for (const model of PLANNING_MODELS) expect(options).toContain(model);
      expect(options.at(-1)).toBe("Other model id…");
    }
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("does not list a preset twice when the server also reports it", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response({ settings, available: [PLANNING_MODELS[0], "installed-llm"] }),
    );
    await openForm();
    const options = within(picker("Planning model")).getAllByRole("option").map((o) => o.textContent);
    expect(options.filter((name) => name === PLANNING_MODELS[0])).toHaveLength(1);
  });

  it("loads saved choices instead of replacing them with defaults", async () => {
    vi.mocked(fetch).mockResolvedValue(response({
      settings: {
        ...settings, model: PLANNING_MODELS[4], stages: { ...stages, render_prompts: PLANNING_MODELS[3] },
      },
      available: [],
    }));
    await openForm();
    expect(picker("Planning model")).toHaveValue(PLANNING_MODELS[4]);
    expect(picker("Prompt writing")).toHaveValue(PLANNING_MODELS[3]);
    expect(picker("Creative plans")).toHaveValue("");
  });

  it("saves a stage picked from the dropdown, sending untouched ones as null", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ settings, available: [] }))
      .mockResolvedValueOnce(response({
        settings: { ...settings, stages: { ...stages, storyboard: PLANNING_MODELS[5] } },
      }));
    await openForm();
    await userEvent.selectOptions(picker("Story and storyboard"), PLANNING_MODELS[5]);
    await userEvent.click(screen.getByRole("button", { name: "Save models" }));

    expect(fetch).toHaveBeenNthCalledWith(2, "/api/settings/planning-model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: null,
        stages: { storyboard: PLANNING_MODELS[5], agentic_canvas: null, render_prompts: null },
      }),
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
    expect(picker("Story and storyboard")).toHaveValue(PLANNING_MODELS[5]);
  });

  it("offers a typed id as an extra choice, and saves it", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ settings, available: [] }))
      .mockResolvedValueOnce(response({
        settings: { ...settings, stages: { ...stages, storyboard: "next-year-model" } },
      }));
    await openForm();
    await userEvent.selectOptions(picker("Story and storyboard"), "Other model id…");
    const box = screen.getByRole("textbox", { name: "Story and storyboard, model id" });
    await userEvent.type(box, "next-year-model");
    await userEvent.click(screen.getByRole("button", { name: "Save models" }));

    expect(fetch).toHaveBeenNthCalledWith(2, "/api/settings/planning-model", expect.objectContaining({
      body: JSON.stringify({
        model: null,
        stages: { storyboard: "next-year-model", agentic_canvas: null, render_prompts: null },
      }),
    }));
    // A saved id that is in neither list stays visible as typed text.
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
    expect(picker("Story and storyboard")).toHaveValue("__custom__");
    expect(screen.getByRole("textbox", { name: "Story and storyboard, model id" }))
      .toHaveValue("next-year-model");
  });

  it("shows a saved id that is not in any list as typed text instead of dropping it", async () => {
    vi.mocked(fetch).mockResolvedValue(response({
      settings: { ...settings, model: "somebody-elses-model" }, available: [],
    }));
    await openForm();
    expect(picker("Planning model")).toHaveValue("__custom__");
    expect(screen.getByRole("textbox", { name: "Planning model, model id" }))
      .toHaveValue("somebody-elses-model");
  });

  it("returns to the default when its option is picked again", async () => {
    vi.mocked(fetch).mockResolvedValue(response({
      settings: { ...settings, stages: { ...stages, render_prompts: PLANNING_MODELS[3] } },
      available: [],
    }));
    await openForm();
    await userEvent.selectOptions(picker("Prompt writing"), "");
    await userEvent.click(screen.getByRole("button", { name: "Save models" }));
    expect(vi.mocked(fetch).mock.calls[1]![1]).toMatchObject({
      body: JSON.stringify({
        model: null,
        stages: { storyboard: null, agentic_canvas: null, render_prompts: null },
      }),
    });
  });

  it("reports a rejected save and keeps what was typed", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ settings, available: [] }))
      .mockResolvedValueOnce(response({ error: "Not a valid model id" }, false));
    await openForm();
    await userEvent.selectOptions(picker("Planning model"), "Other model id…");
    await userEvent.type(screen.getByRole("textbox", { name: "Planning model, model id" }), "bad id");
    await userEvent.click(screen.getByRole("button", { name: "Save models" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not a valid model id");
    expect(screen.getByRole("textbox", { name: "Planning model, model id" })).toHaveValue("bad id");
    expect(picker("Planning model")).not.toBeDisabled();
  });

  it("reports load failures without presenting a success-shaped default", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Settings unavailable"));
    render(<PlanningModelSettingsForm />);
    await userEvent.click(screen.getByText("AI planning models"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings unavailable");
    expect(screen.queryByLabelText("Planning model")).not.toBeInTheDocument();
  });
});
