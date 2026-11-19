import { expect, test, type Page } from "@playwright/test";
import http from "node:http";
const apiPort = Number(process.env.ACRO_TEST_API_PORT ?? 17777);
const proxyPort = Number(process.env.ACRO_TEST_PROXY_PORT ?? 18081);

async function record(page: Page, tag = "fixture") {
  await page.request.post("/api/capture/start");
  await new Promise<void>((resolve, reject) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path: `http://127.0.0.1:${apiPort}/echo?capture=${tag}`,
        headers: { Host: `127.0.0.1:${apiPort}` },
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
        res.on("error", reject);
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error("Proxy timeout")));
    req.on("error", reject);
  });
}
async function toRepeater(page: Page, tag = "fixture") {
  await page.getByRole("button", { name: "Intercept", exact: true }).click();
  const row = page
    .getByRole("main")
    .getByRole("button")
    .filter({ hasText: `/echo?capture=${tag}` });
  await expect(row).toBeVisible();
  const id = (await row.innerText()).match(/#(\d+)/)![1]!;
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Send to repeater", exact: true }).click();
  await expect(page.getByRole("tab", { name: `GET #${id}`, exact: true })).toBeVisible();
  expect(
    (await page.getByRole("tab", { name: `GET #${id}` }).boundingBox())!.height,
  ).toBeLessThanOrEqual(30);
  return id;
}
test.beforeEach(async ({ page }) => {
  await page.request.post("/api/capture/stop");
  await page.request.post("/api/capture/clear");
});

test("fresh workspace stays empty and language uses an icon", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("button", { name: "Local workspace", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send request", exact: true })).toHaveCount(0);
  const language = page.getByRole("combobox", { name: "Language", exact: true });
  await expect(language).toHaveText("");
  await language.click();
  await page.getByRole("option", { name: "简体中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.reload();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("acro.workspace.v1")!));
  expect(saved.projects).toEqual([]);
  expect(saved.drafts).toEqual([]);
  expect(errors).toEqual([]);
});

test("capture IDs, Escape, replay popup, formatting and equal editor fonts", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await record(page);
  await page.goto("/");
  const row = page
    .getByRole("main")
    .getByRole("button")
    .filter({ hasText: "/echo?capture=fixture" });
  await row.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").locator(".shiki").first()).toBeVisible();
  await page.keyboard.down("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.keyboard.up("Escape");
  const id = await toRepeater(page);
  const request = page.getByRole("textbox", { name: "Request", exact: true });
  const raw = await request.inputValue();
  const top = (await request.boundingBox())!.y;
  await page.getByRole("button", { name: "Request options", exact: true }).click();
  await expect(page.getByLabel("Timeout", { exact: true })).toBeVisible();
  expect((await request.boundingBox())!.y).toBe(top);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(page.locator(".syntax-preview")).toContainText("Hello from Acro");
  const requestFont = await request.evaluate((e) => getComputedStyle(e).fontSize);
  const responseFont = await page
    .locator(".syntax-preview code")
    .first()
    .evaluate((e) => getComputedStyle(e).fontSize);
  expect(requestFont).toBe(responseFont);
  expect(requestFont).toBe("12px");
  const tabBox = (await page.getByRole("tab", { name: `GET #${id}` }).boundingBox())!;
  expect(tabBox.height).toBeLessThanOrEqual(30);
  await page.getByText("Pretty", { exact: true }).first().click();
  await expect(page.locator(".syntax-preview").first()).toContainText("GET /echo");
  await page.getByText("Pretty", { exact: true }).first().click();
  await expect(request).toHaveValue(raw);
  await expect(page.getByText("Recent traffic", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Content-Length is calculated automatically", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load local example" })).toHaveCount(0);
  await page.screenshot({ animations: "disabled", path: "test-results/repeater-dark.png" });
  await page.getByRole("button", { name: "Save evidence", exact: true }).click();
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(
    page.getByRole("main").getByText("GET /echo", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(
    page.getByRole("main").getByText("GET /echo", { exact: true }).first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("captured tabs switch, close, reopen and persist without spawning blank drafts", async ({
  page,
}) => {
  await record(page, "one");
  await record(page, "two");
  await page.goto("/");
  const one = await toRepeater(page, "one");
  await page.getByLabel("Request name").fill("Edited capture");
  const two = await toRepeater(page, "two");
  await page.getByRole("tab", { name: `GET #${one}` }).click();
  await expect(page.getByLabel("Request name")).toHaveValue("Edited capture");
  await page.getByRole("button", { name: "Close request: Edited capture", exact: true }).click();
  await page.getByRole("button", { name: "Find request", exact: true }).click();
  await page.getByRole("dialog").getByRole("combobox").fill("Edited capture");
  await page.getByRole("option", { name: /Edited capture/ }).click();
  await page.reload();
  await expect(page.getByRole("tab", { name: `GET #${one}` })).toBeVisible();
  await page.getByRole("button", { name: "Delete request", exact: true }).click();
  await page.getByRole("tab", { name: `GET #${two}` }).click();
  await page.getByRole("button", { name: "Delete request", exact: true }).click();
  await expect(page.getByText("No open requests", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Send request", exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("acro.workspace.v1")!).drafts),
  ).toEqual([]);
});

test("themes and narrow windows remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({ animations: "disabled", path: "test-results/workspace-empty-dark.png" });
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.screenshot({ animations: "disabled", path: "test-results/workspace-empty-light.png" });
  await page.setViewportSize({ width: 430, height: 860 });
  await page.reload();
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(page.getByRole("dialog").getByRole("navigation")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
});

test("new projects have no requests and session drafts persist", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByRole("textbox", { name: "Project name", exact: true }).fill("Payments API");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByText("No open requests", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New session draft: Payments API", exact: true }).click();
  await page.getByLabel("Session title", { exact: true }).fill("Review checkout flow");
  await page.getByLabel("Task instructions", { exact: true }).fill("Compare authorization headers");
  await page.reload();
  await expect(page.getByLabel("Task instructions", { exact: true })).toHaveValue(
    "Compare authorization headers",
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export session", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("acro-session.json");
});

test("legacy workspaces retain requests through migration", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("acro.workspace.v1"))
      localStorage.setItem(
        "acro.workspace.v1",
        JSON.stringify({
          version: 1,
          drafts: [
            {
              id: "legacy-request",
              name: "Existing request",
              target: "https://saved.example.test",
              raw: "GET /preserved HTTP/1.1\nHost: saved.example.test\n\n",
              followRedirects: true,
              timeoutSeconds: 45,
            },
          ],
          selectedId: "legacy-request",
          locale: "en",
          appearance: "dark",
        }),
      );
  });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "GET Existing request", exact: true })).toBeVisible();
  await expect(page.getByLabel("Target origin")).toHaveValue("https://saved.example.test");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Request", exact: true })).toHaveValue(
    "GET /preserved HTTP/1.1\nHost: saved.example.test\n\n",
  );
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("acro.workspace.v1")!).version),
  ).toBe(3);
});

test("reopening capture details reuses previews without sending more worker jobs", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = Object.assign(window, { previewJobs: 0 });
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      message: unknown,
      options?: StructuredSerializeOptions,
    ) {
      if (message && typeof message === "object" && "input" in message) state.previewJobs++;
      return original.call(this, message, options);
    };
  });
  await record(page, "cache");
  await page.goto("/");
  const row = () =>
    page.getByRole("main").getByRole("button").filter({ hasText: "/echo?capture=cache" });
  await row().click();
  const previews = page.getByRole("dialog").locator(".syntax-preview");
  await expect(previews).toHaveCount(2);
  const jobs = () => page.evaluate(() => (window as Window & { previewJobs: number }).previewJobs);
  const initial = await jobs();
  expect(initial).toBe(2);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Repeater", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Intercept", exact: true })
    .click();
  await row().click();
  await expect(previews).toHaveCount(2);
  expect(await jobs()).toBe(initial);
  await page.getByRole("dialog").getByText("Pretty", { exact: true }).click();
  await expect(previews).toHaveCount(0);
  await page.getByRole("dialog").getByText("Pretty", { exact: true }).click();
  await expect(previews).toHaveCount(2);
  expect(await jobs()).toBe(initial);
});
