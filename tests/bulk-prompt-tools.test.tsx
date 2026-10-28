import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BulkPromptTools } from "@/components/storyboard/bulk-prompt-tools";
import { createProject, generateStoryboard } from "@/lib/services/project-service";
import type { ProjectRecord } from "@/lib/schemas/storyboard";
import type { PromptPreview } from "@/lib/schemas/prompt-tools";

let record: ProjectRecord;
const saved = vi.fn();
const busy = vi.fn();

beforeEach(async () => {
  saved.mockClear();
  busy.mockClear();
  const project = await createProject({ concept: "A courier opens a red door.", requestedDurationSeconds: 40 });
  record = await generateStoryboard(project.id);
});

function show() {
  return render(<BulkPromptTools projectId={record.project.id} scenes={record.storyboard!.scenes} disabled={false} onSaved={saved} onBusyChange={busy} />);
}

function panel(label: string) {
  const summary = screen.getByText(label, { selector: "summary" });
  fireEvent.click(summary);
  return within(summary.parentElement!);
}

function preview(): PromptPreview {
  return {
    results: [
      { sceneId: record.storyboard!.scenes[0]!.id, sceneNumber: 1, field: "startFramePrompt", sourceHash: "source", before: "Mara stands next to the red door with her hand on the handle.", after: "Mara stands by the door, hand on its handle.", status: "ready" },
      { sceneId: record.storyboard!.scenes[0]!.id, sceneNumber: 1, field: "endFramePrompt", sourceHash: "source", before: "Mara stands next to the fountain in the courtyard in soft warm evening light.", after: "Mara stands beside the courtyard fountain.", status: "ready" },
    ],
  };
}

describe("bulk prompt tools", () => {
  it("sends literal text, selected scenes, frame choice and prepend placement", async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json(record));
    vi.stubGlobal("fetch", fetch);
    show();
    const add = panel("Add text to image prompts");
    expect(add.getByRole("button", { name: "Apply text to image prompts" })).toBeDisabled();
    await userEvent.click(add.getByLabelText("Scene 2"));
    await userEvent.selectOptions(add.getByLabelText("Image frames"), "end");
    await userEvent.selectOptions(add.getByLabelText("Placement"), "prepend");
    await userEvent.type(add.getByLabelText("Text to add"), "A blue sign.");
    await userEvent.click(add.getByRole("button", { name: "Apply text to image prompts" }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(record));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/prompts/add-text"), expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      scope: "selected", sceneIds: [record.storyboard!.scenes[1]!.id],
      frames: "end", placement: "prepend", text: "A blue sign.",
    });
    expect(busy.mock.calls).toEqual([[true], [false]]);
    expect(screen.getByRole("status")).toHaveTextContent("Existing media is unchanged");
  });

  it("previews without saving, then applies only checked results", async () => {
    const rows = preview();
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => Response.json(init?.method === "PATCH" ? record : rows));
    vi.stubGlobal("fetch", fetch);
    show();
    const simplify = panel("Simplify image and video prompts");
    await userEvent.selectOptions(simplify.getByLabelText("Scenes"), "selected");
    expect(simplify.getByRole("button", { name: "Preview simplified prompts" })).toBeDisabled();
    await userEvent.click(simplify.getByLabelText("Scene 1"));
    await userEvent.selectOptions(simplify.getByLabelText("Prompts to simplify"), "image");
    await userEvent.click(simplify.getByRole("button", { name: "Preview simplified prompts" }));
    await screen.findByRole("checkbox", { name: "Apply Scene 1 · Start frame" });
    expect(saved).not.toHaveBeenCalled();
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
      scope: "selected", sceneIds: [record.storyboard!.scenes[0]!.id], target: "image", frames: "both",
    });
    expect(screen.getByDisplayValue(rows.results[0]!.before)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Apply Scene 1 · End frame" }));
    await userEvent.click(screen.getByRole("button", { name: "Apply 1 selected prompt" }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(record));
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({ results: [rows.results[0]] });
    expect(screen.queryByRole("button", { name: "Discard preview" })).not.toBeInTheDocument();
  });

  it("discards a preview without a write request", async () => {
    const fetch = vi.fn(async () => Response.json(preview()));
    vi.stubGlobal("fetch", fetch);
    show();
    const simplify = panel("Simplify image and video prompts");
    await userEvent.click(simplify.getByRole("button", { name: "Preview simplified prompts" }));
    await userEvent.click(await screen.findByRole("button", { name: "Discard preview" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(saved).not.toHaveBeenCalled();
  });

  it("shows failed preview rows and does not allow applying them", async () => {
    const rows = preview();
    const first = rows.results[0]!;
    const failed: PromptPreview = { results: [{
      sceneId: first.sceneId, sceneNumber: first.sceneNumber, field: first.field,
      sourceHash: first.sourceHash, before: first.before, status: "error", error: "Model unavailable.",
    }] };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(failed)));
    show();
    const simplify = panel("Simplify image and video prompts");
    await userEvent.click(simplify.getByRole("button", { name: "Preview simplified prompts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Model unavailable");
    expect(screen.getByRole("button", { name: "Apply 0 selected prompts" })).toBeDisabled();
  });

  it("surfaces API errors without changing the displayed saved prompts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Scene changed since this preview." }, { status: 409 })));
    show();
    const simplify = panel("Simplify image and video prompts");
    await userEvent.click(simplify.getByRole("button", { name: "Preview simplified prompts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Scene changed");
    expect(saved).not.toHaveBeenCalled();
  });

  it("disables prompt actions while generation is running", () => {
    render(<BulkPromptTools projectId={record.project.id} scenes={record.storyboard!.scenes} disabled onSaved={saved} onBusyChange={busy} />);
    const simplify = panel("Simplify image and video prompts");
    expect(simplify.getByRole("button", { name: "Preview simplified prompts" })).toBeDisabled();
    expect(screen.getByText(/unavailable while generation/)).toBeInTheDocument();
  });
});
