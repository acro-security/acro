import { expect, test } from "@playwright/test";

test("prefetches nearby chunks, releases distant ones and copies the full response", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const lines = Array.from(
    { length: 6000 },
    (_, i) => `export const value${i} = { id: ${i}, label: "item ${i}" };`,
  ).join("\n");
  expect(lines.length).toBeGreaterThan(128 * 1024);
  let historyReads = 0;
  await page.route("**/api/capture/history", (route) => {
    historyReads++;
    return route.continue();
  });

  await page.route("**/api/replay", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        protocol: "HTTP/1.1",
        status: 200,
        statusText: "OK",
        headers: [{ name: "Content-Type", value: "application/javascript" }],
        body: lines,
        encoding: "utf-8",
        size: lines.length,
        durationMs: 12,
        truncated: false,
      }),
    });
  });

  await page.goto("/");
  await expect.poll(() => historyReads).toBeGreaterThan(0);
  const readsBeforeReload = historyReads;
  await page.evaluate(() =>
    localStorage.setItem(
      "acro.workspace.v1",
      JSON.stringify({
        version: 3,
        projects: [{ id: "p1", name: "QA" }],
        sessions: [],
        drafts: [
          {
            id: "d1",
            projectId: "p1",
            name: "bundle.js",
            target: "http://127.0.0.1:1",
            raw: "GET /bundle.js HTTP/1.1\nHost: 127.0.0.1:1\n\n",
            followRedirects: true,
            timeoutSeconds: 30,
          },
        ],
        openRequestIds: ["d1"],
        selectedId: "d1",
        selectedProjectId: "p1",
        selectedSessionId: null,
        locale: "en",
        appearance: "dark",
      }),
    ),
  );
  await page.reload();
  await page.getByRole("button", { name: "Send request", exact: true }).click();

  const pane = page.getByTestId("code-view").last();
  const preview = pane.locator(".syntax-preview");
  const highlighted = preview.locator(".shiki");
  await expect(highlighted.first()).toContainText("value0", { timeout: 60000 });
  expect(historyReads).toBe(readsBeforeReload);
  expect(await preview.locator("[data-code-chunk]").count()).toBeLessThan(10);
  await expect(preview.locator('[data-line-number="1"]')).toContainText("value0");

  // The following chunk is highlighted while the viewport is still at the top.
  const nextChunk = preview.locator('[data-code-chunk="1"] .shiki');
  await expect(nextChunk).toContainText("value32");
  expect((await nextChunk.boundingBox())!.y).toBeGreaterThan(
    (await pane.boundingBox())!.y + (await pane.boundingBox())!.height,
  );
  expect(await pane.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(preview.getByText("value5999", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Copy", exact: true }).last().click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(lines);

  await pane.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(highlighted.last()).toContainText("value5999");
  await expect(preview.locator('[data-line-number="6000"]')).toContainText("value5999");
  await expect(preview.locator('[data-code-chunk="0"] pre')).toHaveCount(0);
  expect(await highlighted.count()).toBeLessThan(10);

  await pane.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(highlighted.first()).toContainText("value0");
  await expect(preview.getByText("value5999", { exact: true })).toHaveCount(0);

  await page.keyboard.press("Control+f");
  const find = page.getByRole("textbox", { name: "Find in response" });
  await expect(find).toBeFocused();
  await find.fill('LABEL: "item 599');
  const count = page.getByRole("search", { name: "Find in response" }).getByRole("status");
  const active = pane.locator('mark[data-current="true"]');
  await expect(count).toHaveText("1 / 11");
  await expect(active.first()).toBeInViewport();
  await find.press("Shift+Enter");
  await expect(count).toHaveText("11 / 11");
  await expect(active.first()).toBeInViewport();
  await expect(preview.locator('[data-code-chunk="0"] pre')).toHaveCount(0);
  await expect.poll(async () => (await active.allTextContents()).join("")).toBe('label: "item 599');
  await find.press("Enter");
  await expect(count).toHaveText("1 / 11");
  await expect(active.first()).toBeInViewport();
  await find.press("Escape");
  await expect(find).toHaveCount(0);
  await expect(active).toHaveCount(0);
  await page.getByRole("button", { name: "Intercept", exact: true }).click();
  await expect.poll(() => historyReads).toBe(readsBeforeReload + 1);
});
