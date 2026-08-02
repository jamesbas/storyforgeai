import { test, expect } from "@playwright/test";

test("approve scene media then assemble a rough cut with Deepy inspection", async ({ page }) => {
  await page.goto("/projects/new");
  await page.getByLabel(/concept/i).fill("A comet streaks over a village.");
  await page.getByLabel(/duration/i).fill("20");
  await page.getByRole("button", { name: /create storyboard/i }).click();
  await expect(page).toHaveURL(/\/storyboard\//);

  await page.getByRole("button", { name: /generate storyboard/i }).click();
  await expect(page.getByTestId("scene-card")).toHaveCount(1);

  await page.getByRole("button", { name: /generate media/i }).click();
  await expect(page.getByTestId("scene-video-path")).toContainText(/\.wangp-mock/);
  const approve = page.getByRole("button", { name: /approve attempt/i });
  await approve.click();
  // The button goes once the attempt is approved; navigating before the POST
  // lands loses the approval and assembly is then correctly refused.
  await expect(approve).toHaveCount(0);

  // Assemble.
  await page.getByRole("link", { name: /^assembly$/i }).click();
  await expect(page).toHaveURL(/\/assembly\//);
  await page.getByRole("button", { name: /assemble rough cut/i }).click();
  await expect(page.getByTestId("rough-cut-path")).toContainText(/rough-cut\.mp4/);

  // Deepy inspection.
  await page.getByRole("button", { name: /ask deepy/i }).first().click();
  await expect(page.getByTestId("deepy-result")).toBeVisible();

  // Export package has a downloadable storyboard.
  await expect(page.getByTestId("export-link").first()).toBeVisible();
});

test("assembly stays blocked until every scene has an approved take", async ({ page }) => {
  await page.goto("/projects/new");
  await page.getByLabel(/concept/i).fill("Three ferries cross a wide harbour at dawn.");
  await page.getByLabel(/duration/i).fill("60");
  await page.getByRole("button", { name: /create storyboard/i }).click();
  await expect(page).toHaveURL(/\/storyboard\//);

  await page.getByRole("button", { name: /generate storyboard/i }).click();
  await expect(page.getByTestId("scene-card")).toHaveCount(3);

  // Generate media for each scene; the label flips to "Regenerate media" once done.
  const generate = page.getByRole("button", { name: /^generate media$/i });
  for (let i = 0; i < 3; i += 1) {
    await generate.first().click();
    await expect(generate).toHaveCount(2 - i);
  }
  await expect(page.getByTestId("scene-video-path")).toHaveCount(3);

  // Approve only the first scene.
  const approve = page.getByRole("button", { name: /approve attempt/i });
  await expect(approve).toHaveCount(3);
  await approve.first().click();
  await expect(approve).toHaveCount(2);

  await page.getByRole("link", { name: /^assembly$/i }).click();
  await expect(page).toHaveURL(/\/assembly\//);
  await expect(page.getByTestId("approval-count")).toHaveText("1 of 3 scenes approved");
  await expect(page.getByTestId("missing-approval")).toHaveCount(2);
  await expect(page.getByTestId("assemble-button")).toBeDisabled();
  await expect(page.getByTestId("assembly-result")).toHaveCount(0);

  // Recover through the per-scene review link, then approve what is left.
  await page.getByRole("link", { name: /review scene/i }).first().click();
  await expect(page).toHaveURL(/\/storyboard\//);
  const remaining = page.getByRole("button", { name: /approve attempt/i });
  await expect(remaining).toHaveCount(2);
  await remaining.first().click();
  await expect(remaining).toHaveCount(1);
  await remaining.first().click();
  await expect(remaining).toHaveCount(0);

  await page.getByRole("link", { name: /^assembly$/i }).click();
  await expect(page.getByTestId("approval-count")).toHaveText("3 of 3 scenes approved");
  await expect(page.getByTestId("missing-approval")).toHaveCount(0);
  await expect(page.getByTestId("assemble-button")).toBeEnabled();

  await page.getByTestId("assemble-button").click();
  await expect(page.getByTestId("rough-cut-path")).toContainText(/rough-cut\.mp4/);
  await expect(page.getByTestId("clip-attempt-id")).toHaveCount(3);
});
