import { test, expect } from "@playwright/test";

test("generate 3 variants, select one, then generate a storyboard", async ({ page }) => {
  await page.goto("/projects/new");

  await page.getByLabel(/concept/i).fill("A street musician gathers a crowd at dusk.");
  await page.getByLabel(/duration/i).fill("60");
  await page.getByRole("button", { name: /create storyboard/i }).click();
  await expect(page).toHaveURL(/\/storyboard\//);

  // Go to variant review from the storyboard header.
  await page.getByRole("link", { name: /variant review/i }).click();
  await expect(page).toHaveURL(/\/variant-review\//);

  await page.getByRole("button", { name: /generate variants/i }).click();
  await expect(page.getByTestId("variant-card")).toHaveCount(3);

  // Three directions are only a choice if they differ on a named axis.
  await expect(page.getByText("different story")).toBeVisible();
  await expect(page.getByText("different opening")).toBeVisible();
  await expect(page.getByText("different look")).toBeVisible();
  const changes = await page.getByTestId("variant-changes").allTextContents();
  expect(new Set(changes).size).toBe(3);

  // Demo mode says it built these itself, and does not read as a failure.
  const provenance = page.getByTestId("variant-provenance");
  await expect(provenance).toContainText("Deterministic");
  await expect(provenance).not.toContainText(/could not|wrong shape|returned nothing/i);

  // Select the first direction.
  await page.getByTestId("variant-card").first().getByRole("button", { name: /select direction/i }).click();
  await expect(page.getByRole("button", { name: /selected/i })).toBeVisible();

  // Return to the storyboard and generate it from the selected variant.
  await page.getByRole("link", { name: /go to storyboard/i }).click();
  await expect(page).toHaveURL(/\/storyboard\//);
  await page.getByRole("button", { name: /generate storyboard/i }).click();
  await expect(page.getByTestId("scene-card")).toHaveCount(3);
});

test("run core agents converges without a manual refresh", async ({ page }) => {
  await page.goto("/projects/new");
  await page.getByLabel(/concept/i).fill("A night ferry crosses a flooded city.");
  await page.getByLabel(/duration/i).fill("60");
  await page.getByRole("button", { name: /create storyboard/i }).click();
  await expect(page).toHaveURL(/\/storyboard\//);

  await page.getByRole("link", { name: "Agentic canvas", exact: true }).click();
  await expect(page).toHaveURL(/\/agentic-canvas\//);
  await expect(page.getByTestId("agent-card")).toHaveCount(8);
  await expect(page.getByRole("button", { name: "Regenerate" })).toHaveCount(0);

  // A marker that only survives if the page is never reloaded or navigated.
  await page.evaluate(() => {
    (window as unknown as { __noReload?: boolean }).__noReload = true;
  });

  await page.getByRole("button", { name: /run core agents/i }).click();

  // Whether the run ends inside the POST or a later poll, the page must
  // converge on its own. Generous timeout: the dev server compiles the route on
  // first use, which dominates the deterministic run itself.
  await expect(page.getByTestId("canvas-queue-complete")).toContainText(
    "Run complete — 5 of 5 agents finished.",
    { timeout: 30000 },
  );
  await expect(page.getByRole("button", { name: "Regenerate" })).toHaveCount(5);
  await expect(page.getByTestId("canvas-queue-running")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /run core agents/i })).toBeEnabled();

  expect(
    await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
  ).toBe(true);
});
