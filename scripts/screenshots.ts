/**
 * Capture the screenshots used by README.md and docs/architecture.md.
 *
 * Run against a normal local server with a real, finished project — not the
 * e2e server, which runs in demo mode with an empty in-memory store and would
 * photograph placeholder text and dead media players.
 *
 *   npm start                    # or npm run dev
 *   npm run docs:screenshots -- --project <projectId>
 *
 * Images land in `public/screenshots`, which is both committed (so GitHub
 * renders them) and served by the app (so the Help page could use the same
 * files rather than a second copy).
 */
import { chromium, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

type Shot = {
  /** Output file, without extension. */
  name: string;
  /** Route, with `{id}` replaced by the project id. */
  route: string;
  caption: string;
  /** Something that proves the page has rendered its content, not its skeleton. */
  waitFor?: string;
  /** Long pages read better whole; dense ones read better cropped to a screen. */
  fullPage?: boolean;
  /**
   * Photograph one element instead of the page.
   *
   * The storyboard and the console run to several thousand pixels; scaled to a
   * document's width they become an unreadable ribbon. One card shows the same
   * thing legibly.
   */
  element?: string;
};

const SHOTS: Shot[] = [
  {
    name: "new-project",
    route: "/projects/new",
    caption: "New project intake",
    waitFor: "form",
  },
  {
    name: "agentic-canvas",
    route: "/agentic-canvas/{id}",
    caption: "Agentic canvas — the creative team and their plans",
    waitFor: "[data-testid='agent-card']",
    fullPage: true,
  },
  {
    name: "storyboard",
    route: "/storyboard/{id}",
    caption: "Storyboard — a scene card with its keyframes and clip",
    waitFor: "[data-testid='scene-media']",
    element: "[data-testid='scene-card']",
  },
  {
    name: "generation-console",
    route: "/generation-console/{id}",
    caption: "Generation console",
    waitFor: "main",
  },
  {
    name: "assembly",
    route: "/assembly/{id}",
    caption: "Assembly — the rough cut",
    waitFor: "main",
    fullPage: true,
  },
];

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * Show a frame rather than a black rectangle.
 *
 * A `<video>` that has never played paints nothing, so every clip in a
 * screenshot would be an empty box — the one thing the screenshot is there to
 * show. Seeking a little way in also avoids a first frame that is often a fade.
 *
 * Everything here is an inline argument, never a named function: esbuild's
 * keepNames rewrites those into `__name(...)`, and that helper does not exist
 * in the page.
 */
async function primeVideos(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      Promise.all(
        Array.from(document.querySelectorAll("video")).map(
          (video) =>
            new Promise<void>((resolve) => {
              video.pause();
              video.addEventListener("seeked", () => resolve(), { once: true });
              video.addEventListener(
                "loadeddata",
                () => {
                  video.currentTime = Number.isFinite(video.duration)
                    ? Math.min(1, video.duration / 4)
                    : 0.5;
                },
                { once: true },
              );
              if (video.readyState >= 2) {
                video.currentTime = Number.isFinite(video.duration)
                  ? Math.min(1, video.duration / 4)
                  : 0.5;
              }
              // A clip that will not load must not hold the whole run up.
              setTimeout(() => resolve(), 3000);
            }),
        ),
      ).then(() => undefined),
  );
}

async function main(): Promise<void> {
  const base = arg("--base", "http://127.0.0.1:3200")!;
  const projectId = arg("--project");
  const outDir = path.resolve(arg("--out", "public/screenshots")!);

  if (!projectId) {
    console.error("Pass --project <projectId>. Use a finished project: the screenshots are of its media.");
    process.exit(1);
  }

  try {
    const health = await fetch(`${base}/api/health`, { headers: { "Sec-Fetch-Site": "same-origin" } });
    if (!health.ok) throw new Error(`health ${health.status}`);
  } catch {
    console.error(`No app answering at ${base}. Start one with \`npm start\` or \`npm run dev\` first.`);
    process.exit(1);
  }

  await fs.mkdir(outDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    // 1x keeps the committed images to a few hundred KB each; these are read at
    // a document's width, not zoomed into.
    deviceScaleFactor: 1,
    colorScheme: "dark",
    // The app refuses a request whose origin it does not recognise.
    baseURL: base,
  });
  const page = await context.newPage();

  const failures: string[] = [];
  for (const shot of SHOTS) {
    const route = shot.route.replace("{id}", projectId);
    const file = path.join(outDir, `${shot.name}.png`);
    try {
      await page.goto(route, { waitUntil: "networkidle", timeout: 30_000 });
      if (shot.waitFor) await page.waitForSelector(shot.waitFor, { timeout: 15_000 });
      await primeVideos(page);
      // Let images decode and any entry transition finish before the shutter.
      await page.waitForTimeout(500);
      if (shot.element) await page.locator(shot.element).first().screenshot({ path: file });
      else await page.screenshot({ path: file, fullPage: shot.fullPage ?? false });
      const { size } = await fs.stat(file);
      console.log(`  ${shot.name.padEnd(20)} ${route.padEnd(48)} ${Math.round(size / 1024)} KB`);
    } catch (err) {
      failures.push(`${shot.name}: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`  ${shot.name.padEnd(20)} FAILED`);
    }
  }

  await browser.close();

  if (failures.length) {
    console.error(`\n${failures.length} screenshot(s) failed:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`\nWrote ${SHOTS.length} screenshots to ${path.relative(process.cwd(), outDir)}`);
}

void main();
