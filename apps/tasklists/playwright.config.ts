import type { PlaywrightTestConfig } from "@playwright/test";

const port = 8000;
const baseURL =
  process.env.PLAYWRIGHT_TEST_BASE_URL ?? `http://127.0.0.1:${port}`;

const dockerImage =
  process.env.PLAYWRIGHT_DOCKER_IMAGE ??
  "mcr.microsoft.com/playwright:v1.56.0-jammy";
const repositoryPath = process.cwd();
const useDockerServer = process.env.PLAYWRIGHT_USE_DOCKER === "1";
const webServerCommand = useDockerServer
  ? [
      "docker run --rm -i",
      `-p ${port}:${port}`,
      `-v "${repositoryPath}":/work`,
      "-w /work",
      dockerImage,
      `bash -lc "npx http-server . -p ${port} -c-1"`,
    ].join(" ")
  : `npx http-server . -p ${port} -c-1`;

const config: PlaywrightTestConfig = {
  use: {
    baseURL,
  },

  // Automatically start a local HTTP server before tests
  webServer: {
    command: webServerCommand,
    url: baseURL,
    timeout: 30_000,
    reuseExistingServer: !process.env.CI,
  },

  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
    {
      name: "firefox",
      use: { browserName: "firefox" },
    },
  ],
};

export default config;
