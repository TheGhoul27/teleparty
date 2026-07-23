import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests. Starts both the signaling server and the web app.
 * Screen-capture itself cannot be driven headlessly in a realistic way, so
 * capture is covered by unit tests plus docs/manual-qa.md; these tests cover
 * the room, join, and chat flows in a real browser.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: "http://localhost:3100",
    trace: "on-first-retry"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command:
        "npm run dev -w apps/signaling",
      cwd: "../..",
      port: 4100,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: "4100",
        ALLOWED_ORIGINS: "http://localhost:3100",
        ROOM_TOKEN_SECRET: "e2e-test-secret-at-least-16-chars",
        NODE_ENV: "development"
      }
    },
    {
      command: "npm run dev -w apps/web -- -p 3100",
      cwd: "../..",
      port: 3100,
      reuseExistingServer: !process.env.CI,
      env: {
        NEXT_PUBLIC_SIGNALING_URL: "http://localhost:4100"
      }
    }
  ]
});
