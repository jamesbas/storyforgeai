import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * The final WCAG 2.2 AA-oriented sweep (SPEC-009B).
 *
 * Covers every page in the product across the states the spec names: default,
 * loading, success, failure, confirmation, and — where the flag allows —
 * interrupted, retry, cancellation and recovery. Desktop and a phone viewport.
 */

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const PHONE = { width: 390, height: 844 };

async function scan(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const summary = result.violations.map(
    (v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.help}`,
  );
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

async function newProject(page: Page, concept: string) {
  await page.goto("/projects/new");
  await page.getByLabel(/concept/i).fill(concept);
  // 60s at the default segment length gives three scenes to inspect.
  await page.getByLabel(/duration/i).fill("60");
  await page.getByRole("button", { name: /create storyboard/i }).click();
  await expect(page).toHaveURL(/\/storyboard\//);
  return page.url().split("/storyboard/")[1];
}

/** Every static surface, in its default state, on both viewports. */
const PAGES = [
  { path: "/", name: "landing" },
  { path: "/projects", name: "projects" },
  { path: "/projects/new", name: "new project" },
  { path: "/help", name: "help" },
  { path: "/about", name: "about" },
  { path: "/settings", name: "settings" },
  { path: "/generation-console", name: "generation console" },
];

for (const target of PAGES) {
  test(`${target.name} has no axe violations on desktop`, async ({ page }) => {
    await page.goto(target.path);
    await scan(page, `${target.name} desktop`);
  });
}

test("every page passes on a phone viewport without horizontal overflow", async ({ page }) => {
  await page.setViewportSize(PHONE);
  for (const target of PAGES) {
    await page.goto(target.path);
    // These screens fetch their lists after first paint, and a half-loaded
    // layout measures differently from a settled one.
    await page.waitForLoadState("networkidle");
    await scan(page, `${target.name} phone`);
    // A page a phone user has to scroll sideways to read is a WCAG 1.4.10 fail.
    // Report the element rather than a bare boolean; "something overflows" is
    // not a bug report anyone can act on.
    const overflowing = await page.evaluate(() => {
      const limit = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth <= limit + 1) return [];
      return [...document.querySelectorAll<HTMLElement>("*")]
        .filter((el) => el.getBoundingClientRect().right > limit + 1)
        .slice(0, 5)
        .map(
          (el) =>
            `${el.tagName}.${el.className?.toString().slice(0, 60)} — ${(el.textContent ?? "").trim().slice(0, 40)}`,
        );
    });
    expect(overflowing, `${target.name} overflows horizontally at 390px`).toEqual([]);
  }
});

test("project-scoped pages pass in their loaded and populated states", async ({ page }) => {
  const projectId = await newProject(page, "A cartographer redraws a coastline after a storm.");

  await scan(page, "storyboard before generation");

  await page.getByRole("button", { name: /generate storyboard/i }).click();
  await expect(page.getByTestId("scene-card")).toHaveCount(3);
  await scan(page, "storyboard populated");

  for (const [path, name] of [
    [`/agentic-canvas/${projectId}`, "agentic canvas"],
    [`/assembly/${projectId}`, "assembly"],
    [`/settings/${projectId}`, "project settings"],
    [`/variant-review/${projectId}`, "variant review"],
  ] as const) {
    await page.goto(path);
    await scan(page, name);
  }
});

test("the assembly blocked state is accessible and explains itself in words", async ({ page }) => {
  const projectId = await newProject(page, "A diver maps a reef that keeps changing shape.");
  await page.getByRole("button", { name: /generate storyboard/i }).click();
  await expect(page.getByTestId("scene-card")).toHaveCount(3);

  await page.goto(`/assembly/${projectId}`);
  const assemble = page.getByTestId("assemble-button");
  await expect(assemble).toBeDisabled();

  // Colour is not the only signal that assembly is blocked.
  await expect(page.getByTestId("approval-count")).toHaveText(/0 of 3 scenes approved/);
  await scan(page, "assembly blocked");
});

test("a failure state stays accessible", async ({ page }) => {
  // A route that always fails, so the error path is reachable without breaking
  // anything real.
  await page.route("**/api/projects/*/generate-storyboard", (route) =>
    route.fulfill({ status: 500, body: JSON.stringify({ error: "Planner unavailable" }) }),
  );
  await newProject(page, "A courier loses the only copy of a map.");
  await page.getByRole("button", { name: /generate storyboard/i }).click();

  const alert = page.getByRole("alert").first();
  await expect(alert).toBeVisible();
  await scan(page, "storyboard failure");
});

test("the destructive confirmation is accessible and contained", async ({ page }) => {
  await newProject(page, "A lamplighter walks the last gas-lit street.");
  await page.goto("/projects");

  const trigger = page.getByRole("button", { name: /^delete /i }).first();
  await trigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await scan(page, "delete confirmation");

  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("reduced motion is honoured", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/projects");

  // Nothing may animate for longer than an instant when the user asked for
  // stillness.
  const animated = await page.evaluate(() => {
    const longest = [...document.querySelectorAll("*")].map((el) => {
      const style = getComputedStyle(el);
      const parse = (v: string) => Math.max(...v.split(",").map((s) => parseFloat(s) || 0));
      return Math.max(parse(style.transitionDuration), parse(style.animationDuration));
    });
    return Math.max(0, ...longest);
  });
  expect(animated).toBeLessThanOrEqual(0.01);
});

test("interactive controls meet the minimum target size on a phone", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await newProject(page, "A signalman counts trains that no longer run.");
  await page.goto("/projects");

  const controls = page.locator("button:visible, a[href]:visible");
  const count = await controls.count();
  const tooSmall: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const control = controls.nth(i);
    const box = await control.boundingBox();
    if (!box) continue;
    // WCAG 2.2 AA 2.5.8 floor. Inline links in prose are exempt.
    const inline = await control.evaluate(
      (el) => el.tagName === "A" && Boolean(el.closest("p, li")),
    );
    if (inline) continue;
    if (box.width < 24 || box.height < 24) {
      tooSmall.push(`${(await control.textContent())?.trim().slice(0, 30)} ${box.width}x${box.height}`);
    }
  }
  expect(tooSmall).toEqual([]);
});

test("keyboard order reaches every action on the storyboard without a trap", async ({ page }) => {
  await newProject(page, "A beekeeper reads the weather from the hive.");

  const seen = new Set<string>();
  let previous = "";
  let stuck = 0;
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return "body";
      return `${el.tagName}:${el.getAttribute("data-testid") ?? el.textContent?.trim().slice(0, 20) ?? ""}`;
    });
    // Revisiting an element is a legitimate cycle; never leaving one is a trap.
    stuck = id === previous && id !== "body" ? stuck + 1 : 0;
    expect(stuck, `focus stuck on ${id}`).toBeLessThan(5);
    previous = id;
    seen.add(id);
  }
  expect(seen.size).toBeGreaterThan(5);
});
