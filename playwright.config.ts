import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.APP_PORT ?? 3100);

export default defineConfig({
  testDir: "./tests",
  // Generated tests are drafts until a human promotes them; they only run when asked for.
  // The same goes for the Triager's demo red build (Chapter 8).
  testIgnore: process.env.QA_RUN_GENERATED ? [] : ["**/generated/**", "**/triage-demo/**"],
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run app",
    // The assistant (Chapter 14) is scripted unless you point it at a model: ASSISTANT_MODEL_PROVIDER, ASSISTANT_MODEL...
    env: {
      PORT: String(PORT),
      ASSISTANT_MODEL_PROVIDER: process.env.ASSISTANT_MODEL_PROVIDER ?? "mock",
      ...(process.env.ASSISTANT_MODEL ? { ASSISTANT_MODEL: process.env.ASSISTANT_MODEL } : {}),
      ...(process.env.ASSISTANT_MODEL_API_KEY ? { ASSISTANT_MODEL_API_KEY: process.env.ASSISTANT_MODEL_API_KEY } : {}),
      ...(process.env.ASSISTANT_MODEL_BASE_URL ? { ASSISTANT_MODEL_BASE_URL: process.env.ASSISTANT_MODEL_BASE_URL } : {}),
    },
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
