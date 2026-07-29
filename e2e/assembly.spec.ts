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
  await page.getByRole("button", { name: /approve attempt/i }).click();

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
