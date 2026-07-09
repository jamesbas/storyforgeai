import { test, expect } from "@playwright/test";

test("generate 3 variants, select one, then generate a storyboard", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel(/concept/i).fill("A street musician gathers a crowd at dusk.");
  await page.getByLabel(/duration/i).fill("60");
  await page.getByRole("button", { name: /create storyboard/i }).click();
  await expect(page).toHaveURL(/\/storyboard\//);

  // Go to variant review from the storyboard header.
  await page.getByRole("link", { name: /variant review/i }).click();
  await expect(page).toHaveURL(/\/variant-review\//);

  await page.getByRole("button", { name: /generate variants/i }).click();
  await expect(page.getByTestId("variant-card")).toHaveCount(3);

  // Select the first direction.
  await page.getByTestId("variant-card").first().getByRole("button", { name: /select direction/i }).click();
  await expect(page.getByRole("button", { name: /selected/i })).toBeVisible();

  // Return to the storyboard and generate it from the selected variant.
  await page.getByRole("link", { name: /go to storyboard/i }).click();
  await expect(page).toHaveURL(/\/storyboard\//);
  await page.getByRole("button", { name: /generate storyboard/i }).click();
  await expect(page.getByTestId("scene-card")).toHaveCount(3);
});
