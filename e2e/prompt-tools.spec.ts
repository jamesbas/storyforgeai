import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { ProjectRecord } from "../lib/schemas/storyboard";

test("bulk prompt tools target frames, preview without saving, and apply checked results", async ({ page, request }) => {
  const created = await request.post("/api/projects", {
    data: { concept: "A courier opens a red door and enters a courtyard.", requestedDurationSeconds: 40 },
  });
  expect(created.status()).toBe(201);
  const { project } = await created.json() as { project: { id: string } };
  const base = `/api/projects/${project.id}`;
  expect((await request.post(`${base}/generate-storyboard`)).ok()).toBe(true);
  const original = await (await request.get(base)).json() as ProjectRecord;

  await page.goto(`/storyboard/${project.id}`);
  const tools = page.getByTestId("bulk-prompt-tools");
  await expect(tools).toBeVisible();
  await tools.locator("summary", { hasText: "Add text to image prompts" }).click();
  const add = tools.locator("details").filter({ has: page.locator("summary", { hasText: "Add text to image prompts" }) });
  await add.getByLabel("Scene 2", { exact: true }).check();
  await add.getByLabel("Image frames").selectOption("end");
  await add.getByLabel("Placement").selectOption("prepend");
  await add.getByLabel("Text to add").fill("A blue sign marks the doorway.");
  await add.getByRole("button", { name: "Apply text to image prompts" }).click();
  await expect(tools.getByRole("status")).toContainText("Text added");

  const added = await (await request.get(base)).json() as ProjectRecord;
  expect(added.storyboard!.scenes[0]).toEqual(original.storyboard!.scenes[0]);
  expect(added.storyboard!.scenes[1]!.prompts).toEqual({
    ...original.storyboard!.scenes[1]!.prompts,
    endFramePrompt: `A blue sign marks the doorway.\n${original.storyboard!.scenes[1]!.prompts.endFramePrompt}`,
  });

  // Only the LLM preview response is simulated; saves use the real API and stale checks.
  const scene = added.storyboard!.scenes[1]!;
  await page.route(`**${base}/prompts/simplify`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      json: {
        results: [
          { sceneId: scene.id, sceneNumber: 2, field: "startFramePrompt", sourceHash: createHash("sha256").update(JSON.stringify(scene)).digest("hex"), before: scene.prompts.startFramePrompt, after: "The courier stands by the red door.", status: "ready" },
          { sceneId: scene.id, sceneNumber: 2, field: "endFramePrompt", sourceHash: createHash("sha256").update(JSON.stringify(scene)).digest("hex"), before: scene.prompts.endFramePrompt, after: "The courier stands in the courtyard.", status: "ready" },
        ],
      },
    });
  });
  await tools.locator("summary", { hasText: "Simplify image and video prompts" }).click();
  const simplify = tools.locator("details").filter({ has: page.locator("summary", { hasText: "Simplify image and video prompts" }) });
  await simplify.getByRole("combobox", { name: /^Scenes/ }).selectOption("selected");
  await simplify.getByLabel("Scene 2", { exact: true }).check();
  await simplify.getByLabel("Prompts to simplify").selectOption("image");
  await simplify.getByRole("button", { name: "Preview simplified prompts" }).click();
  await expect(simplify.getByRole("checkbox", { name: "Apply Scene 2 · Start frame" })).toBeVisible();
  expect(await (await request.get(base)).json()).toEqual(added);
  await simplify.getByRole("checkbox", { name: "Apply Scene 2 · End frame" }).uncheck();
  await simplify.getByRole("button", { name: "Apply 1 selected prompt" }).click();
  await expect(tools.getByRole("status")).toContainText("Applied 1 simplified prompt");
  const saved = await (await request.get(base)).json() as ProjectRecord;
  expect(saved.storyboard!.scenes[1]!.prompts).toEqual({
    ...scene.prompts,
    startFramePrompt: "The courier stands by the red door.",
  });
  expect(saved.storyboard!.scenes[0]).toEqual(original.storyboard!.scenes[0]);
  await page.reload();
  const secondCard = page.getByTestId("scene-card").nth(1);
  await secondCard.locator("summary").filter({ hasText: /^Prompts/ }).click();
  await expect(secondCard.getByRole("textbox", { name: /^Start frame/ })).toHaveValue("The courier stands by the red door.");
});
