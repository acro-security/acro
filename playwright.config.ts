import { defineConfig } from "@playwright/test";

const webPort = Number(process.env.ACRO_TEST_WEB_PORT ?? 15173);
const apiPort = Number(process.env.ACRO_TEST_API_PORT ?? 17777);
const proxyPort = Number(process.env.ACRO_TEST_PROXY_PORT ?? 18081);
const apiURL = `http://127.0.0.1:${apiPort}`;
const webURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  use: {
    baseURL: webURL,
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
  },
  webServer: [
    {
      command: "bun run dev:api",
      url: `${apiURL}/api/health`,
      env: { ACRO_DEV_ADDR: `127.0.0.1:${apiPort}`, ACRO_PROXY_PORT: String(proxyPort) },
      reuseExistingServer: false,
    },
    {
      command: `bun run dev:web --port ${webPort}`,
      url: webURL,
      env: { ACRO_DEV_API_URL: apiURL },
      reuseExistingServer: false,
    },
  ],
});
