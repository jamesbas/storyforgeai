import { test, expect } from "@playwright/test";

/**
 * A planning provider that cannot be reached must degrade visibly.
 *
 * The dev server for this spec points OPENAI_BASE_URL at a closed local port,
 * so every planning call fails at the socket. Nothing leaves the machine and no
 * paid provider is involved; the point is that the artifact still appears and
 * says how it was really made.
 */
test("a provider that cannot be reached degrades visibly", async ({ page }) => {
  await page.goto("/projects/new");
  await page.getByLabel(/concept/i).fill("A signalman mis-reads a lantern.");
  await page.getByLabel(/duration/i).fill("20");
  await page.getByRole("button", { name: /create storyboard/i }).click();
  await expect(page).toHaveURL(/\/storyboard\//);

  await page.getByRole("button", { name: /generate storyboard/i }).click();
  await expect(page.getByTestId("scene-card")).toHaveCount(1);

  await page.getByRole("link", { name: "Agentic canvas", exact: true }).click();
  await expect(page).toHaveURL(/\/agentic-canvas\//);

  // The storyboard exists, and admits it was not written by the model.
  const badge = page.getByTestId("execution-badge").first();
  await expect(badge).toBeVisible();
  await expect(badge).toContainText(/Deterministic|Hybrid/);
  await expect(badge).toContainText(/could not be reached|returned nothing usable/);
});
