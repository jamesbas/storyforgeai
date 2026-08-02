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
      testIgnore: /provenance\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Same app, but with a planning provider that cannot be reached.
      name: "chromium-degraded",
      testMatch: /provenance\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:3101" },
    },
  ],
  webServer: [
    {
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
        // Its own build directory. Sharing `.next` with a running `next start`
        // silently breaks that server: it resolves each route's module on first
        // request, so routes nobody had hit yet vanish underneath it.
        NEXT_DIST_DIR: ".next-e2e",
      },
    },
    {
      // Planning enabled but pointed at a closed local port, so every call fails
      // at the socket. Nothing leaves the machine and no paid provider is used;
      // this exists to prove a failed run degrades visibly rather than silently.
      command: "next dev -p 3101",
      url: "http://127.0.0.1:3101",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        STORYFORGE_PERSISTENCE: "memory",
        AI_PLANNING_ENABLED: "true",
        OPENAI_BASE_URL: "http://127.0.0.1:59999/v1",
        OPENAI_API_KEY: "not-a-real-key",
        OPENAI_MODEL: "unreachable-model",
        WANGP_MCP_ENABLED: "false",
        FFMPEG_ENABLED: "false",
        DEEPY_ASSIST_ENABLED: "false",
        NEXT_DIST_DIR: ".next-e2e-degraded",
      },
    },
  ],
});
