import { test, expect } from "@playwright/test";

test("generation console lists WanGP models and runs a job", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel(/concept/i).fill("A drone races through a canyon.");
  await page.getByLabel(/duration/i).fill("40");
  await page.getByRole("button", { name: /create storyboard/i }).click();
  await expect(page).toHaveURL(/\/storyboard\//);

  await page.getByRole("link", { name: /generation console/i }).click();
  await expect(page).toHaveURL(/\/generation-console\//);

  // Models discovered from the mock client.
  await expect(page.getByTestId("wangp-model").first()).toBeVisible();
  await expect(page.getByTestId("wangp-status")).toContainText(/online/i);

  // Submit and observe a job.
  await page.getByRole("button", { name: /submit test job/i }).click();
  await expect(page.getByTestId("wangp-job")).toHaveCount(1);
});
