import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * jsdom cannot implement `<dialog>` modality, focus containment or the top
 * layer, so the parts of the confirmation that depend on a real browser are
 * asserted here rather than in the component tests.
 */

async function createProject(page: Page, concept: string) {
  await page.goto("/projects/new");
  await page.getByLabel(/concept/i).fill(concept);
  await page.getByLabel(/duration/i).fill("20");
  await page.getByRole("button", { name: /create storyboard/i }).click();
  await expect(page).toHaveURL(/\/storyboard\//);
}

test("the skip link jumps a keyboard user past the navigation", async ({ page }) => {
  await page.goto("/projects");

  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: /skip to main content/i });
  await expect(skip).toBeFocused();
  // Off-screen until focused, then visible — otherwise it is no use to a
  // sighted keyboard user.
  await expect(skip).toBeInViewport();

  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});

test("the delete confirmation contains focus and closes on Escape", async ({ page }) => {
  await createProject(page, "A courier crosses a frozen lake at dusk.");
  await page.goto("/projects");

  const trigger = page.getByRole("button", { name: /^delete /i }).first();
  await trigger.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();

  // Tabbing must never reach the page behind the dialog. Chromium's wrap point
  // reads as `body` for one step, which is the trap closing the loop rather
  // than focus escaping into the content.
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    const where = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return "wrap";
      return el.closest("dialog") ? "dialog" : `escaped: ${el.tagName}`;
    });
    expect(where, `tab ${i + 1} left the dialog`).not.toContain("escaped");
  }

  // And the rest of the page is genuinely inert, not merely skipped.
  const backgroundTookFocus = await page.evaluate(() => {
    const behind = document.querySelector<HTMLElement>("main a, main button");
    if (!behind) return false;
    behind.focus();
    return document.activeElement === behind;
  });
  expect(backgroundTookFocus, "content behind the modal should be inert").toBe(false);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // And focus comes back to where it started, not to the top of the document.
  await expect(trigger).toBeFocused();
});

test("the confirmation deletes only when confirmed", async ({ page }) => {
  await createProject(page, "A watchmaker repairs a clock that runs backwards.");
  await page.goto("/projects");

  // One delete button per project row — and this waits for the list to load,
  // which a bare count would not.
  const rows = page.getByRole("button", { name: /^delete /i });
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();

  const trigger = rows.first();
  await trigger.click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await rows.count()).toBe(before);

  await trigger.click();
  await page.getByRole("button", { name: /delete permanently/i }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(rows).toHaveCount(before - 1);
});

test("project actions are usable on a phone-sized viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createProject(page, "A baker opens the shutters on the first day of spring.");
  await page.goto("/projects");

  // There is no hover on touch, so these must be visible and big enough
  // without one.
  for (const name of [/^rename /i, /^copy /i, /^delete /i]) {
    const button = page.getByRole("button", { name }).first();
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box, "action button should be laid out").not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(24);
    expect(box!.height).toBeGreaterThanOrEqual(24);
  }

  await page.getByRole("button", { name: /^delete /i }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: /delete permanently/i })).toBeInViewport();
});

test("Projects has no detectable axe violations, idle or confirming", async ({ page }) => {
  await createProject(page, "A diver photographs a shipwreck in clear water.");
  await page.goto("/projects");

  const idle = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(idle.violations).toEqual([]);

  await page.getByRole("button", { name: /^delete /i }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();

  const confirming = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(confirming.violations).toEqual([]);
});
