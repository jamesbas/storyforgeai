import { test, expect } from "@playwright/test";

test("create a project, generate a storyboard, and export", async ({ page }) => {
  await page.goto("/projects/new");

  await page.getByLabel(/concept/i).fill("A lighthouse keeper befriends a passing storm.");
  await page.getByLabel(/duration/i).fill("60");
  await page.getByRole("button", { name: /create storyboard/i }).click();

  // Navigated to the storyboard page.
  await expect(page).toHaveURL(/\/storyboard\//);

  await page.getByRole("button", { name: /generate storyboard/i }).click();

  // 3 scene cards for a 60s project.
  await expect(page.getByTestId("scene-card")).toHaveCount(3);

  // Export links appear once a storyboard exists.
  await expect(page.getByRole("link", { name: /export json/i })).toBeVisible();
});
