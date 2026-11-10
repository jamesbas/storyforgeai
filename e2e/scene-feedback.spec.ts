import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import { framePromptBody } from "../lib/agents/scene-cast";
import type { SceneFeedbackPreview, SceneFeedbackProposal } from "../lib/schemas/scene-feedback";
import type { ProjectRecord } from "../lib/schemas/storyboard";

test("scene feedback previews coordinated changes and saves only after acceptance, without rendering", async ({ page, request }) => {
  const created = await request.post("/api/projects", {
    data: {
      concept: "A courier picks up a cup from a table.",
      requestedDurationSeconds: 30,
      generationMode: "video_segments",
      sceneContinuity: "cut",
      imageModel: "flux_test",
      videoModel: "wan_test",
    },
  });
  expect(created.status()).toBe(201);
  const { project } = await created.json() as { project: { id: string } };
  const base = `/api/projects/${project.id}`;
  expect((await request.post(`${base}/generate-storyboard`)).ok()).toBe(true);
  const original = await (await request.get(base)).json() as ProjectRecord;
  const scene = original.storyboard!.scenes[0]!;
  const after = `${framePromptBody(scene.prompts.endFramePrompt)} The courier holds the cup in the left hand.`;
  const proposal: SceneFeedbackProposal = {
    summary: "The courier now holds the cup in the left hand.",
    revisions: [
      { field: "endFramePrompt", after, reason: "Correct the intended closing pose." },
      ...(scene.prompts.endFrameEditPrompt ? [{
        field: "endFrameEditPrompt" as const,
        after: `Edit the supplied reference frame. Desired final still state: ${after}`,
        reason: "Reach the revised destination.",
      }] : []),
      { field: "videoPromptSegment", after: `${scene.prompts.videoPromptSegment} The courier slowly lifts the cup with the left hand.`,
        reason: "The movement reaches the revised closing frame." },
    ],
    videoReview: { needsChange: true, explanation: "The cup must move into the left hand before the closing frame." },
  };
  const sourceHash = createHash("sha256").update(JSON.stringify({
    sceneId: scene.id, project: original.project, storyboard: original.storyboard,
    storyPlan: original.storyPlan, directorialPlan: original.directorialPlan,
    cinematographyPlan: original.cinematographyPlan, cast: [],
    models: [original.project.imageModel, original.project.videoModel],
  })).digest("hex");
  const preview: SceneFeedbackPreview = {
    sceneId: scene.id, scope: "end", sourceHash, proposal, warnings: [],
    changes: proposal.revisions.map((revision) => ({
      sceneId: scene.id, sceneNumber: 1, field: revision.field,
      before: scene.prompts[revision.field] ?? "", after: revision.after, reason: revision.reason,
    })),
  };
  // Simulate only the model preview; acceptance, validation and persistence use the real API.
  await page.route(`**${base}/scenes/${scene.id}/feedback`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    expect(route.request().postDataJSON()).toEqual({ scope: "end", feedback: "The cup should be held in the left hand." });
    await route.fulfill({ json: preview });
  });
  const renderRequests: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/(?:generate|keyframe|queue)$/.test(req.url())) renderRequests.push(req.url());
  });
  await page.goto(`/storyboard/${project.id}`);
  const panel = page.getByTestId("scene-feedback-panel").first();
  await panel.getByText("Refine with feedback", { exact: true }).click();
  await panel.getByLabel("Feedback target").selectOption("end");
  await panel.getByLabel("What should change?").fill("The cup should be held in the left hand.");
  await panel.getByRole("button", { name: "Preview changes" }).click();
  await expect(panel.getByTestId("scene-feedback-preview")).toContainText("Video impact:");
  await expect(panel.getByTestId("scene-feedback-preview")).toContainText("Scene 1: End keyframe");
  expect(await (await request.get(base)).json()).toEqual(original);
  await panel.getByRole("button", { name: "Discard" }).click();
  await expect(panel.getByTestId("scene-feedback-preview")).toHaveCount(0);
  expect(await (await request.get(base)).json()).toEqual(original);
  await panel.getByRole("button", { name: "Preview changes" }).click();
  await panel.getByRole("button", { name: "Accept changes" }).click();
  await expect(panel.getByRole("status")).toContainText("Existing media is unchanged");
  const saved = await (await request.get(base)).json() as ProjectRecord;
  expect(saved.storyboard!.scenes[0]!.prompts.endFramePrompt).toContain("The courier holds the cup in the left hand.");
  expect(saved.storyboard!.scenes[0]!.prompts.startFramePrompt).toBe(scene.prompts.startFramePrompt);
  expect(saved.storyboard!.scenes.slice(1)).toEqual(original.storyboard!.scenes.slice(1));
  expect(saved.attempts).toEqual(original.attempts);
  expect(renderRequests).toEqual([]);
  await page.reload();
  const card = page.getByTestId("scene-card").first();
  await card.locator("summary").filter({ hasText: /^Prompts/ }).click();
  await expect(card.getByRole("textbox", { name: /^End frame(?: Warning:|$)/ })).toHaveValue(/The courier holds the cup in the left hand\./);
});
