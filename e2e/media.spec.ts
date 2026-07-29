import { test, expect } from "@playwright/test";

test("generate scene media, display it, and approve the attempt", async ({ page }) => {
  await page.goto("/projects/new");
  await page.getByLabel(/concept/i).fill("A firefly lights a forest path.");
  await page.getByLabel(/duration/i).fill("20");
  await page.getByRole("button", { name: /create storyboard/i }).click();
  await expect(page).toHaveURL(/\/storyboard\//);

  await page.getByRole("button", { name: /generate storyboard/i }).click();
  await expect(page.getByTestId("scene-card")).toHaveCount(1);

  await page.getByRole("button", { name: /generate media/i }).click();
  await expect(page.getByTestId("scene-video-path")).toContainText(/\.wangp-mock/);

  await page.getByRole("button", { name: /approve attempt/i }).click();
  await expect(page.getByTestId("scene-media")).toContainText(/approved/i);
});
