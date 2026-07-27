import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev:e2e",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // E2E exercises demo mode. Pin every integration off so a developer's
    // .env.local (live WanGP, real ffmpeg) cannot change the expected results.
    env: {
      STORYFORGE_PERSISTENCE: "memory",
      AI_PLANNING_ENABLED: "false",
      WANGP_MCP_ENABLED: "false",
      FFMPEG_ENABLED: "false",
      DEEPY_ASSIST_ENABLED: "false",
    },
  },
});
